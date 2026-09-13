import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import type { RestChat, RestChatMessage } from "../src/internal/restApi.ts";

// A minimal stand-in for zavu's own /chats/:id + /ws/chat — just enough of the real wire
// protocol (verified against sbx-omnichannel-zavu's src/ws/chatSocket.ts and
// src/db/repos/chat.repo.ts) to exercise Client end to end without needing the real backend.
let server: ReturnType<typeof Bun.serve>;
let chats = new Map<string, RestChat>();
let sockets: Array<{ send: (data: string) => void; close: () => void }> = [];
let sentMessages: Array<{ chat_id: number; body: string }> = [];

function baseChat(overrides: Partial<RestChat> = {}): RestChat {
  return {
    id: 1,
    name: "Ada",
    conversation_sid: "CH1",
    status: "in_progress",
    duration: null,
    metadata: { phone: "+15551234567" },
    source: "web",
    client: "web",
    omnichannel_tag: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    participants: [
      { id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      { id: 11, agent_id: 99, indentify: "agent_99", name: "Agent", sid: null, conversation_sid: null, chat_id: 1, participant_type: "HUMAN_AGENT", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
    ],
    chat_messages: [
      { id: 100, sid: "IM100", body: "hello", media: null, media_type: null, metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  chats = new Map([["1", baseChat()]]);
  sockets = [];
  sentMessages = [];

  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") {
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const chatMatch = url.pathname.match(/^\/chats\/([^/]+)$/);
      if (chatMatch) {
        const chat = chats.get(chatMatch[1]!);
        if (!chat) return new Response("not found", { status: 404 });
        return Response.json(chat);
      }
      const mediaMatch = url.pathname.match(/^\/web_chats\/(\d+)\/messages\/(\d+)\/media_url$/);
      if (mediaMatch) return Response.json({ url: `https://cdn.example.com/${mediaMatch[2]}` });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws as unknown as { send: (data: string) => void; close: () => void });
        ws.send(JSON.stringify({ type: "connected", subscribed_chat_ids: [1] }));
      },
      message(_ws, raw) {
        const msg = JSON.parse(String(raw));
        if (msg.type === "message.send") {
          sentMessages.push({ chat_id: msg.chat_id, body: msg.body });
        }
      },
    },
  });

  configure({ apiBaseUrl: `http://localhost:${server.port}`, apiKey: "test-key" });
});

afterEach(() => {
  server.stop(true);
});

function broadcast(event: Record<string, unknown>): void {
  const payload = JSON.stringify(event);
  for (const ws of sockets) ws.send(payload);
}

function waitFor<T>(emitter: { once: (event: string, cb: (arg: T) => void) => void }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

describe("Client", () => {
  it("hydrates already-subscribed conversations on connect, mirroring conversationJoined", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    expect(conversation.sid).toBe("CH1");
    expect(conversation.attributes).toEqual({ phone: "+15551234567" });
    expect(client.getSubscribedConversations()).toHaveLength(1);
    expect(client.getConversationBySid("CH1")).toBeDefined();

    client.shutdown();
  });

  it("surfaces an inbound message.new as messageAdded on the right conversation", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");

    const newMessage: RestChatMessage = {
      id: 101, sid: "IM101", body: "new message", media: null, media_type: null,
      metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const addedPromise = waitFor<any>(client, "messageAdded");
    broadcast({ type: "message.new", chat_message: newMessage });
    const message = await addedPromise;

    expect(message.body).toBe("new message");
    expect(message.author).toBe("customer_1");
    expect(message.index).toBe(101);

    const conversation = client.getSubscribedConversations()[0]!;
    expect(conversation.lastMessage?.index).toBe(101);

    client.shutdown();
  });

  it("resolves a top-level `reactions` field into message.attributes.reactions", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");

    const updated: RestChatMessage = {
      id: 100, sid: "IM100", body: "hello", media: null, media_type: null,
      metadata: { custom_metadata: {} }, reactions: [{ author: "agent_99", value: "👍", updated_at: new Date().toISOString() }],
      response_time: null, chat_id: 1, participant_id: 10,
      created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
    };
    const updatedPromise = waitFor<any>(client, "messageUpdated");
    broadcast({ type: "message.updated", chat_message: updated });
    const { message } = await updatedPromise;

    expect(message.attributes.reactions).toEqual([{ author: "agent_99", value: "👍", updated_at: updated.updated_at }]);

    client.shutdown();
  });

  it("treats chat.finished as conversationRemoved, keyed by the event's own chat_id", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");

    const removedPromise = waitFor<any>(client, "conversationRemoved");
    broadcast({ type: "chat.finished", chat_id: 1 });
    const removed = await removedPromise;

    expect(removed.sid).toBe("CH1");
    expect(client.getSubscribedConversations()).toHaveLength(0);

    client.shutdown();
  });

  it("joins a brand-new conversation on chat.assigned, mirroring conversationJoined for a chat not seen at connect time", async () => {
    chats.set("2", baseChat({ id: 2, conversation_sid: "CH2", chat_messages: [], participants: [] }));

    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined"); // chat 1, from connected's subscribed_chat_ids

    const joinedPromise = waitFor<any>(client, "conversationJoined");
    broadcast({ type: "chat.assigned", chat_id: 2 });
    const conversation = await joinedPromise;

    expect(conversation.sid).toBe("CH2");
    expect(client.getSubscribedConversations()).toHaveLength(2);

    client.shutdown();
  });

  it("sendMessage resolves with the real message id once the message.new echo arrives", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");
    const conversation = client.getSubscribedConversations()[0]!;

    const sendPromise = conversation.sendMessage("hi there");
    // The mock server doesn't echo automatically — simulate the real backend's own round trip.
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages).toEqual([{ chat_id: 1, body: "hi there" }]);
    broadcast({
      type: "message.new",
      chat_message: {
        id: 555, sid: "IM555", body: "hi there", media: null, media_type: null,
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 11,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    });

    expect(await sendPromise).toBe(555);
    client.shutdown();
  });

  it("rejects sendMessage with media (outbound attachments have no backend endpoint in v1)", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");
    const conversation = client.getSubscribedConversations()[0]!;

    await expect(
      conversation.sendMessage({ contentType: "image/png", media: new Blob(["x"]) }),
    ).rejects.toThrow(/isn't wired/);

    client.shutdown();
  });

  it("getMessages returns a Paginator over the most recent messages, cached client-side", async () => {
    chats.set("1", baseChat({
      chat_messages: [1, 2, 3].map((n) => ({
        id: 100 + n, sid: `IM${100 + n}`, body: `msg ${n}`, media: null, media_type: null,
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date(n).toISOString(), updated_at: new Date(n).toISOString(),
      })),
    }));

    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    const page = await conversation.getMessages(2);
    expect(page.items.map((m: any) => m.body)).toEqual(["msg 2", "msg 3"]);
    expect(page.hasPrevPage).toBe(true);
    expect(page.hasNextPage).toBe(false);

    const prev = await page.prevPage();
    expect(prev.items.map((m: any) => m.body)).toEqual(["msg 1", "msg 2"]);

    client.shutdown();
  });

  it("Media#getContentTemporaryUrl resolves lazily via the media_url endpoint", async () => {
    chats.set("1", baseChat({
      chat_messages: [{
        id: 200, sid: "IM200", body: null, media: "some/key.png", media_type: "image/png",
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
    }));

    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const page = await conversation.getMessages();
    const message = page.items[0]!;

    expect(message.attachedMedia).not.toBeNull();
    const url = await message.attachedMedia[0].getContentTemporaryUrl();
    expect(url).toBe("https://cdn.example.com/200");

    client.shutdown();
  });
});
