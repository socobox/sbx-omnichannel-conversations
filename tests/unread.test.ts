import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import type { RestChat, RestChatMessage } from "../src/internal/restApi.ts";

// Read tracking is in-memory only (no backend column persists it), but "not persisted" is not
// the same as "unknowable": for the lifetime of a Conversation the cached history plus the last
// index marked read is an exact answer. These tests pin that answer, and pin the event that
// tells a UI to clear its badge.

let server: ReturnType<typeof Bun.serve>;
let chats = new Map<string, RestChat>();
let sockets: Array<{ send: (data: string) => void; close: () => void }> = [];

function msg(id: number): RestChatMessage {
  return {
    id, sid: `IM${id}`, body: `m${id}`, media: null, media_type: null, metadata: {}, reactions: [],
    response_time: null, chat_id: 1, participant_id: 10,
    created_at: new Date(id).toISOString(), updated_at: new Date(id).toISOString(),
  };
}

function baseChat(messages: RestChatMessage[]): RestChat {
  return {
    id: 1, name: "Ada", conversation_sid: "CH1", status: "in_progress", duration: null,
    metadata: {}, source: "web", client: "web", omnichannel_tag: [],
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    participants: [{ id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }],
    chat_messages: messages,
  };
}

beforeEach(() => {
  // Ids deliberately far apart and non-contiguous: they are database row ids shared with every
  // other chat in the tenant, which is exactly why subtracting two of them counts nothing.
  chats = new Map([["1", baseChat([msg(4102), msg(4187)])]]);
  sockets = [];
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const m = url.pathname.match(/^\/chats\/([^/]+)$/);
      if (m) {
        const chat = chats.get(m[1]!);
        return chat ? Response.json(chat) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws as unknown as { send: (data: string) => void; close: () => void });
        ws.send(JSON.stringify({ type: "connected", subscribed_chat_ids: [1] }));
      },
      message() {},
    },
  });
  configure({ apiBaseUrl: `http://localhost:${server.port}` });
});

afterEach(() => server.stop(true));

function waitFor<T>(emitter: { once: (event: string, cb: (arg: T) => void) => void }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function broadcast(event: Record<string, unknown>): void {
  const payload = JSON.stringify(event);
  for (const ws of sockets) ws.send(payload);
}

describe("conteo de mensajes no leídos", () => {
  it("devuelve un conteo exacto, no la resta de dos ids de base de datos", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    // Recién hidratada, todo cuenta como leído.
    expect(await conversation.getUnreadMessagesCount()).toBe(0);

    broadcast({ type: "message.new", chat_message: msg(4190) });
    broadcast({ type: "message.new", chat_message: msg(4191) });
    await new Promise((r) => setTimeout(r, 20));

    // Dos mensajes nuevos son 2 — no 4191 - 4187 = 4, y no 4191 - 4102 = 89.
    expect(await conversation.getUnreadMessagesCount()).toBe(2);
    expect(conversation.lastMessage.index - conversation.lastReadMessageIndex).toBe(4);

    client.shutdown();
  });

  it("setAllMessagesRead vuelve a cero y avisa, para que una UI pueda limpiar su badge", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    broadcast({ type: "message.new", chat_message: msg(4190) });
    await new Promise((r) => setTimeout(r, 20));
    expect(await conversation.getUnreadMessagesCount()).toBe(1);

    const updated = waitFor<any>(client, "conversationUpdated");
    const remaining = await conversation.setAllMessagesRead();

    expect(remaining).toBe(0);
    expect(await conversation.getUnreadMessagesCount()).toBe(0);
    // Sin este evento, un consumidor no tiene forma de enterarse y su badge se queda pegado
    // hasta la próxima recarga completa de la página.
    expect((await updated).updateReasons).toContain("lastReadMessageIndex");

    client.shutdown();
  });

  it("setAllMessagesUnread devuelve el total real y también avisa", async () => {
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    const updated = waitFor<any>(client, "conversationUpdated");
    const count = await conversation.setAllMessagesUnread();

    // Dos mensajes en el historial son 2, no lastMessage.index + 1 = 4188.
    expect(count).toBe(2);
    expect(await conversation.getUnreadMessagesCount()).toBe(2);
    expect((await updated).updateReasons).toContain("lastReadMessageIndex");

    client.shutdown();
  });

  it("sigue devolviendo null cuando de verdad no hay historial cargado", async () => {
    chats = new Map([["1", baseChat([])]]);
    const client = new Client("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    // Sin mensajes en la respuesta, nada se cachea: "no sé" es la respuesta honesta.
    expect(await conversation.getUnreadMessagesCount()).toBeNull();

    client.shutdown();
  });
});
