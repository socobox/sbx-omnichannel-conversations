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

let mediaUploads: Array<{ chat_id: number; participant_id: string; filename: string; filenames: string[]; attributes: unknown }> = [];
// Every Client built in this file, so afterEach can force-shutdown any that a failing test left
// alive before reaching its own client.shutdown() line. configure() is process-global state
// shared across every test FILE in the same `bun test` run (not just this one) — a client leaked
// here can reconnect later against a DIFFERENT file's mock server once that file's own beforeEach
// repoints apiBaseUrl, inflating ITS counters. Same pattern as transport.test.ts/readiness.test.ts/
// unread.test.ts; this file (and contract.test.ts) predated that pattern and never adopted it.
let clients: Client[] = [];
function newClient(token: string): Client {
  const client = new Client(token);
  clients.push(client);
  return client;
}
// Mocks the real backend's persisted per-participant read state (participants.
// last_read_message_id) — keyed by participant id, null/absent meaning "hasn't read anything".
let participantLastRead = new Map<number, number | null>();
let participantUpdates: Array<{ participantId: number; body: unknown }> = [];
// Counts real GET /chats/:id calls — used to assert Conversation#participants/getParticipants()
// actually avoid a network round trip when serving from what's already been ingested.
let chatGetCount = 0;

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
  clients = [];
  chats = new Map([["1", baseChat()]]);
  sockets = [];
  sentMessages = [];
  mediaUploads = [];
  participantLastRead = new Map();
  participantUpdates = [];
  chatGetCount = 0;

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
        chatGetCount += 1;
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
        const files = form.getAll("file") as File[];
        const participantId = String(form.get("participant_id"));
        const attributesRaw = form.get("attributes");
        mediaUploads.push({
          chat_id: Number(sendMediaMatch[1]), participant_id: participantId, filename: files[0]!.name,
          filenames: files.map((f) => f.name), attributes: attributesRaw ? JSON.parse(String(attributesRaw)) : undefined,
        });
        const attachments = files.map((f, i) => ({ key: `sbx-key-90${i}`, name: f.name, content_type: f.type }));
        const created: RestChatMessage = {
          id: 900, sid: "IM900", body: (form.get("body") as string) || "", media: attachments[0]!.key, media_type: files[0]!.type,
          metadata: attributesRaw ? JSON.parse(String(attributesRaw)) : {}, reactions: [], response_time: null,
          chat_id: Number(sendMediaMatch[1]), participant_id: Number(participantId),
          attachments,
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
  for (const client of clients) {
    try { client.shutdown(); } catch { /* already shut down by the test itself */ }
  }
  clients = [];
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
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    expect(conversation.sid).toBe("CH1");
    expect(conversation.attributes).toEqual({ phone: "+15551234567" });
    expect((await client.getSubscribedConversations()).items).toHaveLength(1);
    expect(await client.getConversationBySid("CH1")).toBeDefined();

    client.shutdown();
  });

  it("surfaces an inbound message.new as messageAdded on the right conversation", async () => {
    const client = newClient("agent-token");
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

  it("Message#authorName resolves whatever name the backend gave that participant, distinct from author's opaque identity", async () => {
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");

    // participant 10: USER "Ada" (see baseChat()) — a customer CAN have a real name too (real
    // production data always does, e.g. "Martin1"/"Martin Zuleta"); authorName isn't restricted
    // to HUMAN_AGENT, it just surfaces whatever `name` the backend sent for this participant.
    const customerMsg: RestChatMessage = {
      id: 101, sid: "IM101", body: "hola", media: null, media_type: null,
      metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const customerAdded = waitFor<any>(client, "messageAdded");
    broadcast({ type: "message.new", chat_message: customerMsg });
    const customerMessage = await customerAdded;
    expect(customerMessage.author).toBe("customer_1");
    expect(customerMessage.authorName).toBe("Ada");

    // participant 11: HUMAN_AGENT "Agent" (see baseChat()) — report from sbx-omnichannel-ui:
    // author alone only ever gave "agent_99", never a name a UI could show directly.
    const agentMsg: RestChatMessage = {
      id: 102, sid: "IM102", body: "hi there", media: null, media_type: null,
      metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 11,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const agentAdded = waitFor<any>(client, "messageAdded");
    broadcast({ type: "message.new", chat_message: agentMsg });
    const agentMessage = await agentAdded;
    expect(agentMessage.author).toBe("agent_99");
    expect(agentMessage.authorName).toBe("Agent");

    client.shutdown();
  });

  it("a message from a participant not yet known resolves authorName once the background refetch completes, instead of staying a dead-end placeholder", async () => {
    // Report (sbx-omnichannel-ui, found reading the code — a participant added after this
    // Conversation's initial hydration, e.g. by a transfer, used to resolve as `participant_<id>`
    // FOREVER: no path ever backfilled the real identity/name.
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");

    const newAgentMsg: RestChatMessage = {
      id: 103, sid: "IM103", body: "me hago cargo del chat", media: null, media_type: null,
      metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 132,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const addedPromise = waitFor<any>(client, "messageAdded");
    // The mock backend now "knows" participant 132 too (as a real GET /chats/:id would, once the
    // transfer that added them has actually happened server-side) — simulates the real timing:
    // the WS frame for their message can arrive before this Client's own next full chat refetch.
    chats.set("1", { ...chats.get("1")!, participants: [
      ...chats.get("1")!.participants!,
      { id: 132, agent_id: 132, indentify: "agent_132", name: "Asesor Lider", sid: "MB132", conversation_sid: null, chat_id: 1, participant_type: "HUMAN_AGENT", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
    ] });
    broadcast({ type: "message.new", chat_message: newAgentMsg });
    const message = await addedPromise;

    // Synchronously: the placeholder, immediately usable, never undefined.
    expect(message.author).toBe("participant_132");
    expect(message.authorName).toBeNull();

    // The background refetch (Conversation#getParticipants) is already in flight — give it a
    // tick to land, then re-check the SAME message instance. `authorName` is a live getter (not
    // captured at construction) so it now resolves; `author` itself stays exactly what it was —
    // it's a plain identity string, captured once, same as every other message's.
    await new Promise((r) => setTimeout(r, 20));
    expect(message.author).toBe("participant_132");
    expect(message.authorName).toBe("Asesor Lider");

    client.shutdown();
  });

  it("Conversation#participants reads synchronously from what hydration already ingested, no network call", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const baseline = chatGetCount;

    const participants = conversation.participants;
    expect(chatGetCount).toBe(baseline); // no GET /chats/:id triggered by reading this
    expect(participants.map((p: any) => p.identity).sort()).toEqual(["agent_99", "customer_1"]);
    expect(participants.find((p: any) => p.identity === "agent_99").type).toBe("HUMAN_AGENT");

    client.shutdown();
  });

  it("Conversation#getParticipants() serves from cache by default; forceFetch: true always hits the network", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const baseline = chatGetCount;

    const cached = await conversation.getParticipants();
    expect(chatGetCount).toBe(baseline);
    expect(cached).toHaveLength(2);

    const fresh = await conversation.getParticipants({ forceFetch: true });
    expect(chatGetCount).toBe(baseline + 1);
    expect(fresh).toHaveLength(2);

    client.shutdown();
  });

  it("Message#authorType exposes the sender's participant_type without a separate lookup", async () => {
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");

    const customerMsg: RestChatMessage = {
      id: 104, sid: "IM104", body: "hola", media: null, media_type: null,
      metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const customerAdded = waitFor<any>(client, "messageAdded");
    broadcast({ type: "message.new", chat_message: customerMsg });
    expect((await customerAdded).authorType).toBe("USER");

    const agentMsg: RestChatMessage = {
      id: 105, sid: "IM105", body: "hi", media: null, media_type: null,
      metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 11,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const agentAdded = waitFor<any>(client, "messageAdded");
    broadcast({ type: "message.new", chat_message: agentMsg });
    expect((await agentAdded).authorType).toBe("HUMAN_AGENT");

    client.shutdown();
  });

  it("a participant.updated frame turns into participantJoined/participantLeft/participantUpdated on the live Conversation", async () => {
    // Mirrors the real transfer flow: agentAssignment.service.ts broadcasts one frame for the
    // newly-assigned agent (sid set) and one for the displaced agent (sid -> null), chat-wide —
    // see sbx-omnichannel-zavu's agentAssignment.service.ts#performAssignAgent. A brand-new
    // participant id is used for the join/leave pair specifically so "previously known, sid was
    // already set/unset" isn't ambiguous with "never seen before" — see the update case below for
    // the other kind of change (same participant, sid never moves).
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    const joinedPromise = waitFor<any>(conversation, "participantJoined");
    broadcast({
      type: "participant.updated", chat_id: 1,
      participant: { id: 132, agent_id: 132, indentify: "agent_132", name: "Asesor Lider", sid: "MB132", conversation_sid: null, chat_id: 1, participant_type: "HUMAN_AGENT", metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    });
    const joined = await joinedPromise;
    expect(joined.identity).toBe("agent_132");
    expect(joined.name).toBe("Asesor Lider");

    const leftPromise = waitFor<any>(conversation, "participantLeft");
    broadcast({
      type: "participant.updated", chat_id: 1,
      participant: { id: 132, agent_id: 132, indentify: "agent_132", name: "Asesor Lider", sid: null, conversation_sid: null, chat_id: 1, participant_type: "HUMAN_AGENT", metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    });
    const left = await leftPromise;
    expect(left.identity).toBe("agent_132");

    // A change with sid staying exactly as it was (here: null, both before and after — matches
    // participant 10, the base fixture's own USER, whose sid is always null) is `participantUpdated`,
    // never join/leave — a plain name change, e.g.
    const updatedPromise = waitFor<any>(conversation, "participantUpdated");
    broadcast({
      type: "participant.updated", chat_id: 1,
      participant: { id: 10, agent_id: null, indentify: "customer_1", name: "Ada Lovelace", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date().toISOString() },
    });
    const { participant, updateReasons } = await updatedPromise;
    expect(participant.name).toBe("Ada Lovelace");
    expect(updateReasons).toEqual(["name"]);

    // conversation.participants (the sync getter) reflects all of this immediately too — the
    // displaced participant is still present (deactivated, never removed), not gone.
    const stillThere = conversation.participants.find((p: any) => p.identity === "agent_132");
    expect(stillThere).toBeTruthy();
    const renamed = conversation.participants.find((p: any) => p.identity === "customer_1");
    expect(renamed.name).toBe("Ada Lovelace");

    client.shutdown();
  });

  it("resolves a top-level `reactions` field into message.attributes.reactions", async () => {
    const client = newClient("agent-token");
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

  it("message.attributes surfaces a previously-edited message's update_history from the backend's double-nested custom_metadata wrap", async () => {
    // Reproduces the real shape reported from production (sbx-omnichannel-ui, 2026-09-21):
    // a message already edited once carries its ORIGINAL, faithful metadata one level deeper
    // than the top level, because toChatMessagePublic (chat.repo.ts, a straight port of Rails'
    // `object.metadata.merge(custom_metadata: object.metadata)`) wraps whatever was stored
    // (itself already `{ reactions: [], custom_metadata: { update_history: [...] } }` from the
    // FIRST edit) inside a second `custom_metadata` key. Discarding `metadata.custom_metadata`
    // outright (the pre-fix behavior) loses the history entirely; the fix must read the nested
    // copy's OWN content as the real attributes, not the shadowed top level.
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");

    const editedOnce: RestChatMessage = {
      id: 100, sid: "IM100", body: "Como vas compadre?", media: null, media_type: null,
      metadata: {
        reactions: [],
        custom_metadata: {
          reactions: [],
          custom_metadata: {
            update_history: [
              { new_body: "Como vas compadre?", prev_body: "Como vas?", update_at: "2026-09-21T16:51:00.256Z", update_user: "admin@demo.com" },
            ],
          },
        },
      },
      reactions: [],
      response_time: null, chat_id: 1, participant_id: 10,
      created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
    };
    const updatedPromise = waitFor<any>(client, "messageUpdated");
    broadcast({ type: "message.updated", chat_message: editedOnce });
    const { message } = await updatedPromise;

    expect(message.attributes).toEqual({
      reactions: [],
      custom_metadata: {
        update_history: [
          { new_body: "Como vas compadre?", prev_body: "Como vas?", update_at: "2026-09-21T16:51:00.256Z", update_user: "admin@demo.com" },
        ],
      },
    });

    client.shutdown();
  });

  it("message.attributes stays {} (plus reactions) for a message that was never edited", async () => {
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");

    const neverEdited: RestChatMessage = {
      id: 100, sid: "IM100", body: "hello", media: null, media_type: null,
      metadata: { custom_metadata: {} }, reactions: [],
      response_time: null, chat_id: 1, participant_id: 10,
      created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
    };
    const updatedPromise = waitFor<any>(client, "messageUpdated");
    broadcast({ type: "message.updated", chat_message: neverEdited });
    const { message } = await updatedPromise;

    expect(message.attributes).toEqual({ reactions: [] });

    client.shutdown();
  });

  it("treats chat.finished as conversationRemoved, keyed by the event's own chat_id", async () => {
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");

    const removedPromise = waitFor<any>(client, "conversationRemoved");
    broadcast({ type: "chat.finished", chat_id: 1 });
    const removed = await removedPromise;

    expect(removed.sid).toBe("CH1");
    expect((await client.getSubscribedConversations()).items).toHaveLength(0);

    client.shutdown();
  });

  it("treats chat.unassigned as conversationLeft (cached instance, status untouched), keyed by the event's own chat_id", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined"); // chat 1

    const leftPromise = waitFor<any>(client, "conversationLeft");
    broadcast({ type: "chat.unassigned", chat_id: 1 });
    const left = await leftPromise;

    expect(left).toBe(conversation); // same cached instance, not a fresh one — see Client.ts's own comment
    expect(left.sid).toBe("CH1");
    expect(left.status).toBe("in_progress"); // unlike chat.finished, the chat itself is still active
    expect((await client.getSubscribedConversations()).items).toHaveLength(0);

    client.shutdown();
  });

  it("chat.unassigned for a chat_id this Client never joined is a silent no-op", async () => {
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined"); // chat 1

    let sawConversationLeft = false;
    client.on("conversationLeft", () => { sawConversationLeft = true; });
    broadcast({ type: "chat.unassigned", chat_id: 999 });
    await new Promise((r) => setTimeout(r, 10));

    expect(sawConversationLeft).toBe(false);
    expect((await client.getSubscribedConversations()).items).toHaveLength(1);

    client.shutdown();
  });

  it("joins a brand-new conversation on chat.assigned, mirroring conversationJoined for a chat not seen at connect time", async () => {
    chats.set("2", baseChat({ id: 2, conversation_sid: "CH2", chat_messages: [], participants: [] }));

    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined"); // chat 1, from connected's subscribed_chat_ids

    const joinedPromise = waitFor<any>(client, "conversationJoined");
    broadcast({ type: "chat.assigned", chat_id: 2 });
    const conversation = await joinedPromise;

    expect(conversation.sid).toBe("CH2");
    expect((await client.getSubscribedConversations()).items).toHaveLength(2);

    client.shutdown();
  });

  it("sendMessage resolves with the real message id once the message.new echo arrives", async () => {
    const client = newClient("agent-token");
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
    const client = newClient("agent-token"); // not a real JWT — decodes to no agent_id at all
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    await expect(
      conversation.sendMessage({ contentType: "image/png", media: new Blob(["x"]) }),
    ).rejects.toThrow(/no participant record/);

    client.shutdown();
  });

  it("sendMessage with media uploads via POST .../messages and resolves with the created message's id", async () => {
    const client = newClient(fakeJwt({ scope: "agent", agent_id: 99 })); // matches participant id=11 in baseChat
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    const blob = new Blob(["fake bytes"], { type: "image/png" });
    const index = await conversation.sendMessage({ contentType: "image/png", media: blob, filename: "photo.png" });

    expect(index).toBe(900);
    expect(mediaUploads).toEqual([{ chat_id: 1, participant_id: "11", filename: "photo.png", filenames: ["photo.png"], attributes: undefined }]);

    client.shutdown();
  });

  it("Message#updateBody persists the edit and resolves once the message.updated echo arrives", async () => {
    const client = newClient("agent-token");
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
    const client = newClient("agent-token");
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

    const client = newClient("agent-token");
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

    const client = newClient("agent-token");
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
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const page = await conversation.getMessages();

    expect(page.items[0].type).toBe("text");
    expect(page.items[0].media).toBeNull();
    expect(page.items[1].type).toBe("media");
    expect(page.items[1].media).not.toBeNull();

    client.shutdown();
  });

  it("Conversation exposes dateCreated/dateUpdated", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    expect(conversation.dateCreated).toBeInstanceOf(Date);
    expect(conversation.dateUpdated).toBeInstanceOf(Date);

    client.shutdown();
  });

  it("getUnreadMessagesCount/setAllMessagesRead/setAllMessagesUnread persist read state server-side", async () => {
    const client = newClient(fakeJwt({ scope: "agent", agent_id: 99 })); // matches participant id=11 in baseChat
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
    const client = newClient("agent-token"); // not a real JWT — decodes to no agent_id, no participant
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
    const client = newClient(fakeJwt({ scope: "chat", participant_id: 10 }));
    const conversation = await waitFor<any>(client, "conversationJoined");

    const result = await conversation.setAllMessagesUnread();
    expect(result).toBe(0);
    // The mock server only computes unread_count relative to a HUMAN_AGENT participant, so this
    // just proves resolveOwnParticipantId() picked participant 10 up from the JWT claim itself
    // (no HUMAN_AGENT participant exists in this fixture at all) rather than skipping the call.
    expect(participantUpdates).toEqual([{ participantId: 10, body: { last_read_message_id: null } }]);

    client.shutdown();
  });

  it("getConversationBySid conserva el participant_id del token, igual que conversationJoined", async () => {
    // El merge con main perdió el 4to argumento SOLO en este camino (Client.ts, dentro de
    // getConversationBySid) — una sesión de cliente que resolviera su chat por sid en vez de
    // recibirlo por conversationJoined quedaba sin participante, y sus marcados de leído
    // no-opeaban en silencio para siempre: sin error, sin petición, sin nada que mirar.
    // Dos keys para el mismo chat: la búsqueda inicial por sid usa "CH9" (RestApi.getChat con el
    // string que se le pasa a getConversationBySid), pero cualquier fetch posterior de ESE
    // Conversation (ensureMessagesLoaded, getUnreadMessagesCount) usa `chatId` — el id numérico.
    const chat9 = baseChat({
      id: 9, conversation_sid: "CH9",
      participants: [
        { id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 9, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      ],
      chat_messages: [],
    });
    chats.set("CH9", chat9);
    chats.set("9", chat9);

    const client = newClient(fakeJwt({ scope: "chat", participant_id: 10 }));
    await waitFor<any>(client, "conversationJoined");

    const conversation = await client.getConversationBySid("CH9");
    await conversation.setAllMessagesUnread();

    expect(participantUpdates).toContainEqual({ participantId: 10, body: { last_read_message_id: null } });
    client.shutdown();
  });

  it("Conversation itself emits messageAdded/messageUpdated, mirroring Client's aggregated feed", async () => {
    const client = newClient("agent-token");
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
    const client = newClient(fakeJwt({ scope: "agent", agent_id: 99 }));
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    const index = await conversation.prepareMessage()
      .setBody("ignored for a media send")
      .addMedia({ contentType: "image/png", media: new Blob(["x"]), filename: "a.png" })
      .build()
      .send();

    expect(index).toBe(900);
    expect(mediaUploads).toEqual([{ chat_id: 1, participant_id: "11", filename: "a.png", filenames: ["a.png"], attributes: undefined }]);

    client.shutdown();
  });

  it("MessageBuilder sends multiple attachments as ONE message (2026-09-22 — previously rejected)", async () => {
    const client = newClient(fakeJwt({ scope: "agent", agent_id: 99 }));
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    const index = await conversation.prepareMessage()
      .addMedia({ contentType: "image/png", media: new Blob(["x"]), filename: "one.png" })
      .addMedia({ contentType: "image/jpeg", media: new Blob(["y"]), filename: "two.jpg" })
      .build()
      .send();

    expect(index).toBe(900);
    expect(mediaUploads).toHaveLength(1); // ONE request, not two — both files in the same multipart form
    expect(mediaUploads[0]?.filenames).toEqual(["one.png", "two.jpg"]);

    client.shutdown();
  });

  it("a media send's `attributes` are sent to the backend, not silently dropped (2026-09-22 — previously a documented v1 gap)", async () => {
    const client = newClient(fakeJwt({ scope: "agent", agent_id: 99 }));
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;

    await conversation.prepareMessage()
      .addMedia({ contentType: "image/png", media: new Blob(["x"]), filename: "a.png" })
      .setAttributes({ in_reply_to_message_id: 4180 })
      .build()
      .send();

    expect(mediaUploads[0]?.attributes).toEqual({ in_reply_to_message_id: 4180 });

    client.shutdown();
  });

  it("a message with multiple stored attachments exposes one Media per attachment via attachedMedia", async () => {
    // Simulates a GET /chats/:id response for a message that already has several attachments
    // stored (rather than round-tripping through sendMessage, whose sendMedia branch doesn't wait
    // for a WS echo and so wouldn't be reflected in this Conversation's own cached messages).
    chats.set("1", { ...chats.get("1")!, chat_messages: [
      ...chats.get("1")!.chat_messages!,
      {
        id: 901, sid: "IM901", body: "", media: "sbx-key-a", media_type: "image/png",
        metadata: {}, reactions: [], response_time: null, chat_id: 1, participant_id: 10,
        attachments: [
          { key: "sbx-key-a", name: "one.png", content_type: "image/png" },
          { key: "sbx-key-b", name: "two.jpg", content_type: "image/jpeg" },
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    ] });
    const client = newClient(fakeJwt({ scope: "agent", agent_id: 99 }));
    await waitFor(client, "conversationJoined");
    const conversation = (await client.getSubscribedConversations()).items[0]!;
    const page = await conversation.getMessages();
    const message = page.items.find((m) => m.index === 901)!;

    expect(message.attachedMedia).toHaveLength(2);
    expect(message.attachedMedia![0]!.filename).toBe("one.png");
    expect(message.attachedMedia![1]!.filename).toBe("two.jpg");
    expect(message.media).toBe(message.attachedMedia![0]); // deprecated single-media alias: still the first

    const url0 = await message.attachedMedia![0]!.getContentTemporaryUrl();
    expect(url0).toBe("https://cdn.example.com/901"); // mock server's media_url handler ignores ?key, real backend doesn't

    client.shutdown();
  });

  it("Participant exposes bindings as a best-effort JSONValue (channel-specific shape, not strictly typed)", async () => {
    chats.set("1", baseChat({
      participants: [
        { id: 20, agent_id: null, indentify: "+15550001111", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: { whatsapp: { address: "+15550001111" } }, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      ],
    }));
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const participants = await conversation.getParticipants();

    expect((participants[0].bindings as any).whatsapp.address).toBe("+15550001111");

    client.shutdown();
  });
});
