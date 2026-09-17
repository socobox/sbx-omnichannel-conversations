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

// Builds a structurally-valid (unsigned) JWT so Client's own base64 payload decode — the same
// trick @twilio/conversations uses for exp — can read a fake `agent_id`/`exp` claim in tests.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

let mediaUploads: Array<{ chat_id: number; participant_id: string; filename: string }> = [];
// Mocks the real backend's persisted per-participant read state (participants.
// last_read_message_id) — keyed by participant id, null/absent meaning "hasn't read anything".
let participantLastRead = new Map<number, number | null>();
let participantUpdates: Array<{ participantId: number; body: unknown }> = [];

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
  mediaUploads = [];
  participantLastRead = new Map();
  participantUpdates = [];

  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") {
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const chatMatch = url.pathname.match(/^\/chats\/([^/]+)$/);
      if (chatMatch) {
        const chat = chats.get(chatMatch[1]!);
        if (!chat) return new Response("not found", { status: 404 });
        // Mirrors the real backend: unread_count is computed relative to the chat's own
        // HUMAN_AGENT participant (there's only ever one across this test file's fixtures) —
        // null when there isn't one at all, matching "nothing to compute against".
        const agentParticipant = chat.participants?.find((p) => p.participant_type === "HUMAN_AGENT");
        const unread_count = agentParticipant
          ? (chat.chat_messages ?? []).filter((m) => m.id > (participantLastRead.get(agentParticipant.id) ?? 0)).length
          : null;
        return Response.json({ ...chat, unread_count });
      }
      const mediaMatch = url.pathname.match(/^\/web_chats\/(\d+)\/messages\/(\d+)\/media_url$/);
      if (mediaMatch) return Response.json({ url: `https://cdn.example.com/${mediaMatch[2]}` });

      const updateMessageMatch = url.pathname.match(/^\/web_chats\/(\d+)\/messages\/(\d+)$/);
      if (updateMessageMatch && req.method === "PUT") return Response.json({ success: true });

      const updateParticipantMatch = url.pathname.match(/^\/web_chats\/(\d+)\/participants\/(\d+)$/);
      if (updateParticipantMatch && req.method === "PUT") {
        const body = await req.json();
        const participantId = Number(updateParticipantMatch[2]);
        participantUpdates.push({ participantId, body });
        if (body && typeof body === "object" && "last_read_message_id" in body) {
          participantLastRead.set(participantId, (body as { last_read_message_id: number | null }).last_read_message_id);
        }
        return Response.json({ success: true });
      }

      const sendMediaMatch = url.pathname.match(/^\/web_chats\/(\d+)\/messages$/);
      if (sendMediaMatch && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file") as File;
        const participantId = String(form.get("participant_id"));
        mediaUploads.push({ chat_id: Number(sendMediaMatch[1]), participant_id: participantId, filename: file.name });
        const created: RestChatMessage = {
          id: 900, sid: "IM900", body: (form.get("body") as string) || "", media: "sbx-key-900", media_type: file.type,
          metadata: {}, reactions: [], response_time: null, chat_id: Number(sendMediaMatch[1]), participant_id: Number(participantId),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        return Response.json(created);
      }
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

  configure({ apiBaseUrl: `http://localhost:${server.port}` });
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
    expect((await client.getSubscribedConversations()).items).toHaveLength(1);
    expect(await client.getConversationBySid("CH1")).toBeDefined();

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

    const conversation = (await client.getSubscribedConversations()).items[0]!;
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
    const { message, updateReasons } = await updatedPromise;

    expect(message.attributes.reactions).toEqual([{ author: "agent_99", value: "👍", updated_at: updated.updated_at }]);
    expect(updateReasons).toEqual(["attributes"]);

    client.shutdown();
  });

  it("treats chat.finished as conversationRemoved, keyed by the event's own chat_id", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");

    const removedPromise = waitFor<any>(client, "conversationRemoved");
    broadcast({ type: "chat.finished", chat_id: 1 });
    const removed = await removedPromise;

    expect(removed.sid).toBe("CH1");
    expect((await client.getSubscribedConversations()).items).toHaveLength(0);

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
    expect((await client.getSubscribedConversations()).items).toHaveLength(2);

    client.shutdown();
  });

  it("sendMessage resolves with the real message id once the message.new echo arrives", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

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

  it("rejects sendMessage with media when this agent has no participant record in this chat", async () => {
    const client = new Client("agent-token"); // not a real JWT — decodes to no agent_id at all
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    await expect(
      conversation.sendMessage({ contentType: "image/png", media: new Blob(["x"]) }),
    ).rejects.toThrow(/no participant record/);

    client.shutdown();
  });

  it("sendMessage with media uploads via POST .../messages and resolves with the created message's id", async () => {
    const client = new Client(fakeJwt({ scope: "agent", agent_id: 99 })); // matches participant id=11 in baseChat
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    const blob = new Blob(["fake bytes"], { type: "image/png" });
    const index = await conversation.sendMessage({ contentType: "image/png", media: blob, filename: "photo.png" });

    expect(index).toBe(900);
    expect(mediaUploads).toEqual([{ chat_id: 1, participant_id: "11", filename: "photo.png" }]);

    client.shutdown();
  });

  it("Message#updateBody persists the edit and resolves once the message.updated echo arrives", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const page = await conversation.getMessages();
    const message = page.items[0]!;
    expect(message.body).toBe("hello");

    const updatePromise = message.updateBody("edited");
    await new Promise((r) => setTimeout(r, 10));
    broadcast({
      type: "message.updated",
      chat_message: {
        id: 100, sid: "IM100", body: "edited", media: null, media_type: null,
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
      },
    });
    const updated = await updatePromise;
    expect(updated.body).toBe("edited");

    client.shutdown();
  });

  it("messageUpdated reports updateReasons: ['body'] for a body-only edit vs ['attributes'] for metadata/reactions", async () => {
    const client = new Client("agent-token");
    await waitFor(client, "conversationJoined");

    const bodyEditPromise = waitFor<any>(client, "messageUpdated");
    broadcast({
      type: "message.updated",
      chat_message: {
        id: 100, sid: "IM100", body: "edited body", media: null, media_type: null,
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
      },
    });
    expect((await bodyEditPromise).updateReasons).toEqual(["body"]);

    const reactionPromise = waitFor<any>(client, "messageUpdated");
    broadcast({
      type: "message.updated",
      chat_message: {
        id: 100, sid: "IM100", body: "edited body", media: null, media_type: null,
        metadata: {}, reactions: [{ author: "agent_99", value: "👍", updated_at: new Date().toISOString() }],
        response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
      },
    });
    expect((await reactionPromise).updateReasons).toEqual(["attributes"]);

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

  it("Message#type/media reflect whether the message has an attachment, matching Twilio's deprecated single-media getter", async () => {
    chats.set("1", baseChat({
      chat_messages: [
        { id: 300, sid: "IM300", body: "hi", media: null, media_type: null, metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
        { id: 301, sid: "IM301", body: null, media: "key.png", media_type: "image/png", metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      ],
    }));
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const page = await conversation.getMessages();

    expect(page.items[0].type).toBe("text");
    expect(page.items[0].media).toBeNull();
    expect(page.items[1].type).toBe("media");
    expect(page.items[1].media).not.toBeNull();

    client.shutdown();
  });

  it("Conversation exposes dateCreated/dateUpdated", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    expect(conversation.dateCreated).toBeInstanceOf(Date);
    expect(conversation.dateUpdated).toBeInstanceOf(Date);

    client.shutdown();
  });

  it("getUnreadMessagesCount/setAllMessagesRead/setAllMessagesUnread persist read state server-side", async () => {
    const client = new Client(fakeJwt({ scope: "agent", agent_id: 99 })); // matches participant id=11 in baseChat
    const conversation = await waitFor<any>(client, "conversationJoined");

    // baseChat's one message (id 100) hasn't been read yet — a fresh participant has no
    // last_read_message_id at all, so it counts as unread (matches the real backend's "everything
    // unread until proven otherwise" default).
    expect(await conversation.getUnreadMessagesCount()).toBe(1);

    const readResult = await conversation.setAllMessagesRead();
    expect(readResult).toBe(0);
    expect(conversation.lastReadMessageIndex).toBe(100);
    expect(await conversation.getUnreadMessagesCount()).toBe(0);
    expect(participantUpdates).toEqual([{ participantId: 11, body: { last_read_message_id: 100 } }]);

    const unreadResult = await conversation.setAllMessagesUnread();
    expect(unreadResult).toBe(1);
    expect(conversation.lastReadMessageIndex).toBe(-1);
    expect(await conversation.getUnreadMessagesCount()).toBe(1);
    expect(participantUpdates[1]).toEqual({ participantId: 11, body: { last_read_message_id: null } });

    client.shutdown();
  });

  it("setAllMessagesRead/Unread no-op (no network call) when this session has no participant in the chat", async () => {
    const client = new Client("agent-token"); // not a real JWT — decodes to no agent_id, no participant
    const conversation = await waitFor<any>(client, "conversationJoined");

    expect(await conversation.setAllMessagesRead()).toBe(0);
    expect(await conversation.setAllMessagesUnread()).toBe(0);
    expect(participantUpdates).toEqual([]);

    client.shutdown();
  });

  it("a customer session resolves its own unread state via the token's own participant_id claim (no agent_id needed)", async () => {
    chats.set("1", baseChat({
      participants: [
        { id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      ],
      chat_messages: [],
    }));
    const client = new Client(fakeJwt({ scope: "chat", participant_id: 10 }));
    const conversation = await waitFor<any>(client, "conversationJoined");

    const result = await conversation.setAllMessagesUnread();
    expect(result).toBe(0);
    // The mock server only computes unread_count relative to a HUMAN_AGENT participant, so this
    // just proves resolveOwnParticipantId() picked participant 10 up from the JWT claim itself
    // (no HUMAN_AGENT participant exists in this fixture at all) rather than skipping the call.
    expect(participantUpdates).toEqual([{ participantId: 10, body: { last_read_message_id: null } }]);

    client.shutdown();
  });

  it("Conversation itself emits messageAdded/messageUpdated, mirroring Client's aggregated feed", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    const addedPromise = waitFor<any>(conversation, "messageAdded");
    broadcast({
      type: "message.new",
      chat_message: {
        id: 400, sid: "IM400", body: "hi again", media: null, media_type: null,
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    });
    expect((await addedPromise).body).toBe("hi again");

    const updatedPromise = waitFor<any>(conversation, "messageUpdated");
    broadcast({
      type: "message.updated",
      chat_message: {
        id: 400, sid: "IM400", body: "edited", media: null, media_type: null,
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    });
    const { message, updateReasons } = await updatedPromise;
    expect(message.body).toBe("edited");
    expect(updateReasons).toEqual(["body"]);

    client.shutdown();
  });

  it("prepareMessage()/MessageBuilder sends a single-attachment message via the same media upload path", async () => {
    const client = new Client(fakeJwt({ scope: "agent", agent_id: 99 }));
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    const index = await conversation.prepareMessage()
      .setBody("ignored for a media send")
      .addMedia({ contentType: "image/png", media: new Blob(["x"]), filename: "a.png" })
      .build()
      .send();

    expect(index).toBe(900);
    expect(mediaUploads).toEqual([{ chat_id: 1, participant_id: "11", filename: "a.png" }]);

    client.shutdown();
  });

  it("MessageBuilder rejects more than one attachment per message, clearly", async () => {
    const client = new Client(fakeJwt({ scope: "agent", agent_id: 99 }));
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    const builder = conversation.prepareMessage()
      .addMedia({ contentType: "image/png", media: new Blob(["x"]) })
      .addMedia({ contentType: "image/png", media: new Blob(["y"]) });

    await expect(builder.build().send()).rejects.toThrow(/more than one attachment/);

    client.shutdown();
  });

  it("Participant exposes bindings as a best-effort JSONValue (channel-specific shape, not strictly typed)", async () => {
    chats.set("1", baseChat({
      participants: [
        { id: 20, agent_id: null, indentify: "+15550001111", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: { whatsapp: { address: "+15550001111" } }, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      ],
    }));
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const participants = await conversation.getParticipants();

    expect((participants[0].bindings as any).whatsapp.address).toBe("+15550001111");

    client.shutdown();
  });
});
