import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import { MessageUpdateTimeoutError } from "../src/ConnectionError.ts";
import type { RestChat, RestChatMessage } from "../src/internal/restApi.ts";

// Reproduces the hang from report1.md: `message.updateBody(text)` followed by
// `message.updateAttributes(attrs)` on the SAME message index. Both calls resolve their REST PUT
// immediately, but neither resolves the returned promise from that response — they resolve once
// the corresponding `message.updated` WS echo round-trips back (Conversation#awaitMessageUpdate).
// The mock server below deliberately echoes the FIRST update (body) but swallows the SECOND
// (attributes) — exactly what the real zavu backend was observed doing — to prove that, before a
// timeout exists, the second promise hangs forever.
let server: ReturnType<typeof Bun.serve>;
let sockets: Array<{ send: (d: string) => void; close: () => void }> = [];
let clients: Client[] = [];
/** Set per-test: how many more PUT /web_chats/:id/messages/:id requests should echo a
 * message.updated frame. Lets a test allow the FIRST update through and swallow every one after
 * it, matching the exact sequence report1.md observed. */
let echoesRemaining = 0;
let lastPutBody: Record<string, unknown> | null = null;

function agentJwt(agentId = 99): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ agent_id: agentId, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function newClient(options?: ConstructorParameters<typeof Client>[1]): Client {
  const client = new Client(agentJwt(), options);
  clients.push(client);
  return client;
}

function msg(id: number, body: string, metadata: Record<string, unknown> = {}): RestChatMessage {
  return {
    id, sid: `IM${id}`, body, media: null, media_type: null, metadata, reactions: [],
    response_time: null, chat_id: 1, participant_id: 10,
    created_at: new Date(id).toISOString(), updated_at: new Date(id).toISOString(),
  };
}

const chat: RestChat = {
  id: 1, name: "Ada", conversation_sid: "CH1", status: "in_progress", duration: null,
  metadata: {}, source: "web", client: "web", omnichannel_tag: [],
  created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  participants: [
    { id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
    { id: 11, agent_id: 99, indentify: "agent_99", name: "Agent", sid: null, conversation_sid: null, chat_id: 1, participant_type: "HUMAN_AGENT", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
  ],
  chat_messages: [msg(200, "original")],
};

beforeEach(() => {
  clients = [];
  sockets = [];
  echoesRemaining = 0;
  lastPutBody = null;
  // Fresh message row each test — the PUT handler mutates chat.chat_messages in place.
  chat.chat_messages = [msg(200, "original")];
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      }
      if (/^\/chats\/[^/]+$/.test(url.pathname)) return Response.json(chat);
      const putMatch = /^\/web_chats\/(\d+)\/messages\/(\d+)$/.exec(url.pathname);
      if (putMatch && req.method === "PUT") {
        lastPutBody = (await req.json()) as Record<string, unknown>;
        // The REST write always succeeds — matches the report exactly: it's the WS echo that
        // goes missing, never the HTTP response.
        if (echoesRemaining > 0) {
          echoesRemaining -= 1;
          const messageId = Number(putMatch[2]);
          const existing = chat.chat_messages?.find((m) => m.id === messageId);
          const nextMetadata =
            typeof lastPutBody.metadata === "object" && lastPutBody.metadata !== null
              ? { ...(existing?.metadata ?? {}), ...(lastPutBody.metadata as Record<string, unknown>) }
              : (existing?.metadata ?? {});
          const nextBody = typeof lastPutBody.body === "string" ? lastPutBody.body : (existing?.body ?? "original");
          const echoed = msg(messageId, nextBody, nextMetadata);
          // Keep the mock chat in sync so a follow-up updateAttributes echoes the edited body,
          // not the original fixture — matches what zavu's SELECT-after-UPDATE does.
          if (chat.chat_messages) {
            const at = chat.chat_messages.findIndex((m) => m.id === messageId);
            if (at >= 0) chat.chat_messages[at] = echoed;
          }
          const echo = JSON.stringify({ type: "message.updated", chat_message: echoed });
          for (const ws of sockets) ws.send(echo);
        }
        return Response.json({ success: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws as unknown as { send: (d: string) => void; close: () => void });
        ws.send(JSON.stringify({ type: "connected", subscribed_chat_ids: [1] }));
      },
      message() { /* nothing sent up this socket in these tests */ },
    },
  });
  configure({ apiBaseUrl: `http://localhost:${server.port}` });
});

afterEach(() => {
  // Same reasoning as transport.test.ts: a leaked client keeps reconnecting on a freed port and
  // can bleed into a LATER test file's server, turning a real bug into what looks like flakiness.
  for (const client of clients) {
    try { client.shutdown(); } catch { /* already shut down by the test itself */ }
  }
  clients = [];
  server.stop(true);
});

function waitFor<T>(e: { once: (ev: string, cb: (a: T) => void) => void }, ev: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`esperando el evento "${ev}" más de ${timeoutMs}ms`)), timeoutMs);
    e.once(ev, (arg: T) => { clearTimeout(timer); resolve(arg); });
  });
}

describe("message.updateBody() + message.updateAttributes(): eco de WS que nunca llega", () => {
  it("updateAttributes() rechaza con MessageUpdateTimeoutError cuando el segundo eco nunca llega", async () => {
    // Un timeout de prueba MUY corto — la librería resuelve `awaitMessageUpdate` en base a este
    // valor por instancia, así el test no tiene que esperar el default de producción (10-15s)
    // para probar que el timeout de verdad dispara.
    const client = newClient({ messageUpdateTimeoutMs: 150 });
    const conversation = await waitFor<any>(client, "conversationJoined");
    const [message] = (await conversation.getMessages()).items;
    expect(message.index).toBe(200);

    // El PRIMER update (body) sí se ecoa — reproduce la secuencia real del reporte.
    echoesRemaining = 1;
    const updated = await message.updateBody("texto editado");
    expect(updated.body).toBe("texto editado");

    // El SEGUNDO update (attributes), sobre el MISMO índice, no se ecoa — el bug de zavu.
    echoesRemaining = 0;
    const secondUpdate = updated.updateAttributes({ foo: "bar" });

    await expect(secondUpdate).rejects.toBeInstanceOf(MessageUpdateTimeoutError);
    await expect(secondUpdate).rejects.toThrow(/timed out/);

    client.shutdown();
  });

  it("todavía resuelve normalmente cuando el eco SÍ llega a tiempo (no rompe el flujo feliz)", async () => {
    const client = newClient({ messageUpdateTimeoutMs: 2000 });
    const conversation = await waitFor<any>(client, "conversationJoined");
    const [message] = (await conversation.getMessages()).items;

    echoesRemaining = 1;
    const updated = await message.updateBody("primer edit");
    expect(updated.body).toBe("primer edit");

    echoesRemaining = 1;
    const second = await updated.updateAttributes({ foo: "bar" });
    expect(second.attributes).toMatchObject({ foo: "bar" });

    client.shutdown();
  });

  it("el eco que llega ANTES de que termine el REST no deja la promesa colgada (register-before-write)", async () => {
    // Fuerza el eco en el mismo handler del PUT (antes de que RestApi resuelva). Si el waiter
    // se registrara DESPUÉS del REST — el bug de timing — esta promesa colgaría hasta el timeout.
    const client = newClient({ messageUpdateTimeoutMs: 800 });
    const conversation = await waitFor<any>(client, "conversationJoined");
    const [message] = (await conversation.getMessages()).items;

    echoesRemaining = 1;
    const updated = await message.updateBody("eco temprano");
    expect(updated.body).toBe("eco temprano");

    client.shutdown();
  });
});
