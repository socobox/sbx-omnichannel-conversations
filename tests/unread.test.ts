import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import type { RestChat, RestChatMessage } from "../src/internal/restApi.ts";

// Read tracking is persisted server-side (participants.last_read_message_id/last_read_at,
// main@255723f) — this file protects the CLIENT's half of that contract: deriving
// lastReadMessageIndex from the backend's own unread_count instead of assuming "todo leído",
// not repeating a GET /chats/:id the hydration already just made, and not lying about success
// when the backend rejects a read-state write. The happy path of the three public methods is
// covered in tests/client.test.ts; what's here is what that file doesn't touch.

let server: ReturnType<typeof Bun.serve>;
let chats = new Map<string, RestChat>();
let sockets: Array<{ send: (data: string) => void; close: () => void }> = [];
let clients: Client[] = [];

// Mismo truco que tests/client.test.ts: un JWT sin firmar, estructuralmente válido, para que
// Client pueda decodificar agent_id/participant_id de sus claims.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

function newClient(payload: Record<string, unknown> = { scope: "agent", agent_id: 99 }): any {
  const client = new Client(fakeJwt(payload));
  clients.push(client);
  return client;
}

function msg(id: number): RestChatMessage {
  return {
    id, sid: `IM${id}`, body: `m${id}`, media: null, media_type: null, metadata: {}, reactions: [],
    response_time: null, chat_id: 1, participant_id: 10,
    created_at: new Date(id).toISOString(), updated_at: new Date(id).toISOString(),
  };
}

function baseChat(messages: RestChatMessage[], opts: { soloCliente?: boolean } = {}): RestChat {
  const participants = opts.soloCliente
    ? [{ id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }]
    : [
        { id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
        { id: 11, agent_id: 99, indentify: "agent_99", name: "Agent", sid: null, conversation_sid: null, chat_id: 1, participant_type: "HUMAN_AGENT", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() },
      ];
  return {
    id: 1, name: "Ada", conversation_sid: "CH1", status: "in_progress", duration: null,
    metadata: {}, source: "web", client: "web", omnichannel_tag: [],
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    participants,
    chat_messages: messages,
  };
}

// Espeja participants.last_read_message_id del backend real — keyed por participant id,
// ausente/null significa "no ha leído nada".
let participantLastRead = new Map<number, number | null>();
let participantUpdates: Array<{ participantId: number; body: { last_read_message_id: number | null } }> = [];
// Cuántos GET /chats/:id se hicieron — la de-duplicación (P1-2) se apoya en este contador.
let chatFetches = 0;
// Simula el 200-con-{success:false} del backend: una validación rechazada, no un error HTTP.
let participantUpdateRejects = false;

beforeEach(() => {
  // Ids deliberately far apart and non-contiguous: they are database row ids shared with every
  // other chat in the tenant, which is exactly why subtracting two of them counts nothing.
  chats = new Map([["1", baseChat([msg(4102), msg(4187)])]]);
  sockets = [];
  clients = [];
  participantLastRead = new Map();
  participantUpdates = [];
  chatFetches = 0;
  participantUpdateRejects = false;

  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });

      const m = url.pathname.match(/^\/chats\/([^/]+)$/);
      if (m) {
        const chat = chats.get(m[1]!);
        if (!chat) return new Response("not found", { status: 404 });
        chatFetches += 1;
        const agent = chat.participants?.find((p) => p.participant_type === "HUMAN_AGENT");
        const unread_count = agent
          ? (chat.chat_messages ?? []).filter((msg) => msg.id > (participantLastRead.get(agent.id) ?? 0)).length
          : null;
        return Response.json({ ...chat, unread_count });
      }

      const p = url.pathname.match(/^\/web_chats\/(\d+)\/participants\/(\d+)$/);
      if (p && req.method === "PUT") {
        const body = (await req.json()) as { last_read_message_id: number | null };
        const participantId = Number(p[2]);
        participantUpdates.push({ participantId, body });
        if (participantUpdateRejects) {
          // 200 con success:false — el modo de falla que el tipo de retorno de restApi.ts
          // declara y que request() NO convierte en rechazo, porque la respuesta es 2xx.
          return Response.json({ success: false, errors: { last_read_message_id: ["is invalid"] } });
        }
        participantLastRead.set(participantId, body.last_read_message_id);
        return Response.json({ success: true });
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

afterEach(() => {
  // Sin esto, un test que falla (throw en una aserción) deja su Client vivo reconectando; como
  // configure() es estado global de proceso, el siguiente archivo de test repunta la baseUrl y
  // esos zombis terminan haciendo upgrade contra SU servidor — así 3 fallos acá se convertían en
  // 2 fallos más, deterministas, en tests/transport.test.ts.
  for (const c of clients) { try { c.shutdown(); } catch { /* ya apagado */ } }
  clients = [];
  server.stop(true);
});

function waitFor<T>(emitter: { once: (event: string, cb: (arg: T) => void) => void }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function broadcast(event: Record<string, unknown>): void {
  const payload = JSON.stringify(event);
  for (const ws of sockets) ws.send(payload);
}

describe("conteo de mensajes no leídos", () => {
  it("devuelve un conteo exacto, no la resta de dos ids de base de datos", async () => {
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");

    // Recién hidratada, sin nada leído todavía por este participante: todo cuenta como no leído.
    expect(await conversation.getUnreadMessagesCount()).toBe(2);

    // El mock del "servidor" (chats map) también tiene que ver los mensajes nuevos: broadcast()
    // solo entrega el frame por WS al cliente (actualiza su caché local), no toca la respuesta
    // que el mock de GET /chats/:id va a dar en el próximo fetch. Sin esto, la invalidación de
    // applyRealtimeMessage dispararía un re-fetch que vería el chat_messages viejo.
    chats.set("1", baseChat([msg(4102), msg(4187), msg(4190), msg(4191)]));
    broadcast({ type: "message.new", chat_message: msg(4190) });
    broadcast({ type: "message.new", chat_message: msg(4191) });
    await new Promise((r) => setTimeout(r, 20));

    // Cuatro mensajes nuevos son 4 — no 4191 - 4187 = 4 por casualidad de estos ids, sino porque
    // el backend cuenta mensajes reales contra last_read_message_id, nunca resta índices.
    expect(await conversation.getUnreadMessagesCount()).toBe(4);

    client.shutdown();
  });

  it("setAllMessagesRead vuelve a cero y avisa, para que una UI pueda limpiar su badge", async () => {
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");

    chats.set("1", baseChat([msg(4102), msg(4187), msg(4190)]));
    broadcast({ type: "message.new", chat_message: msg(4190) });
    await new Promise((r) => setTimeout(r, 20));
    expect(await conversation.getUnreadMessagesCount()).toBe(3);

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
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");

    const updated = waitFor<any>(client, "conversationUpdated");
    const count = await conversation.setAllMessagesUnread();

    // Dos mensajes en el historial son 2, no lastMessage.index + 1 = 4188.
    expect(count).toBe(2);
    expect(await conversation.getUnreadMessagesCount()).toBe(2);
    expect((await updated).updateReasons).toContain("lastReadMessageIndex");

    client.shutdown();
  });

  it("sin nada contra qué computar (unread_count null) sigue devolviendo null", async () => {
    // Sin participante HUMAN_AGENT, el servidor falso devuelve unread_count: null — el mismo
    // "no lo sé, computalo vos" que el SDK de Twilio puede devolver.
    chats = new Map([["1", baseChat([msg(4102), msg(4187)], { soloCliente: true })]]);
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");

    expect(await conversation.getUnreadMessagesCount()).toBeNull();

    client.shutdown();
  });

  describe("lastReadMessageIndex se deriva del unread_count del servidor", () => {
    it("con algo leído, deriva el índice exacto en vez de asumir todo leído", async () => {
      // 2 mensajes, 1 sin leer: el último leído es el primero de la lista. Asumir "todo leído"
      // acá es lo que hacía que, tras un reload, el menú del consumidor ofreciera "marcar como
      // no leído" sobre un chat que el servidor consideraba parcialmente sin leer.
      participantLastRead.set(11, 4102);
      const client = newClient();
      const conversation = await waitFor<any>(client, "conversationJoined");

      expect(await conversation.getUnreadMessagesCount()).toBe(1);
      expect(conversation.lastReadMessageIndex).toBe(4102);

      client.shutdown();
    });

    it("nada leído se deriva como el centinela -1 que el consumidor espera", async () => {
      const client = newClient(); // participantLastRead vacío: el backend cuenta todo sin leer
      const conversation = await waitFor<any>(client, "conversationJoined");

      expect(await conversation.getUnreadMessagesCount()).toBe(2);
      expect(conversation.lastReadMessageIndex).toBe(-1);

      client.shutdown();
    });

    it("sin nada contra qué computar, el default sigue siendo todo leído (sin badge espurio)", async () => {
      chats = new Map([["1", baseChat([msg(4102), msg(4187)], { soloCliente: true })]]);
      const client = newClient();
      const conversation = await waitFor<any>(client, "conversationJoined");

      expect(await conversation.getUnreadMessagesCount()).toBeNull();
      expect(conversation.lastReadMessageIndex).toBe(4187);

      client.shutdown();
    });
  });

  describe("de-duplicación del GET /chats/:id", () => {
    it("no repite el GET que la hidratación acaba de hacer", async () => {
      const client = newClient();
      const conversation = await waitFor<any>(client, "conversationJoined");
      const trasHidratar = chatFetches;

      expect(await conversation.getUnreadMessagesCount()).toBe(2);
      // El consumidor pide esto para CADA chat, en serie, en CADA reconexión
      // (ChatContext.tsx:668-692) — y cada respuesta trae el historial completo.
      expect(chatFetches).toBe(trasHidratar);

      client.shutdown();
    });

    it("pero sí vuelve a preguntar en cuanto llega un mensaje nuevo", async () => {
      // La otra mitad del contrato: sin esta, borrar la invalidación entera dejaría pasar el
      // test de arriba y devolvería un conteo congelado para siempre.
      const client = newClient();
      const conversation = await waitFor<any>(client, "conversationJoined");
      await conversation.getUnreadMessagesCount();
      const antes = chatFetches;

      chats.set("1", baseChat([msg(4102), msg(4187), msg(4190)]));
      broadcast({ type: "message.new", chat_message: msg(4190) });
      await new Promise((r) => setTimeout(r, 20));

      expect(await conversation.getUnreadMessagesCount()).toBe(3);
      expect(chatFetches).toBe(antes + 1);

      client.shutdown();
    });
  });

  it("un guardado rechazado por el backend no limpia el badge ni miente sobre el estado local", async () => {
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");
    const previo = conversation.lastReadMessageIndex;

    const avisos: any[] = [];
    client.on("conversationUpdated", (p: any) => avisos.push(p));
    participantUpdateRejects = true;

    await expect(conversation.setAllMessagesRead()).rejects.toThrow(/rejected the read-state update/);

    // Lo que importa no es que lance: es que NO haya avanzado el estado ni avisado. Emitir
    // "lastReadMessageIndex" hace que el consumidor ponga el badge en 0 (ChatContext.tsx:452).
    expect(conversation.lastReadMessageIndex).toBe(previo);
    expect(avisos).toHaveLength(0);
    expect(await conversation.getUnreadMessagesCount()).toBeGreaterThan(0);

    client.shutdown();
  });

  it("sin participante resoluble, setAllMessagesUnread no toca el estado local", async () => {
    // participantLastRead ya tiene algo leído para el participante 11 ANTES de hidratar, así
    // que lastReadMessageIndex arranca en un valor real (no en el -1 por defecto) — si no fuera
    // así, la mutación que este test protege (reponer `lastReadMessageIndex = -1` en la rama sin
    // participante) sería indistinguible de un no-op.
    participantLastRead.set(11, 4102);
    const client = newClient({ scope: "agent" }); // sin agent_id: esta sesión no resuelve participante
    const conversation = await waitFor<any>(client, "conversationJoined");
    const previo = conversation.lastReadMessageIndex;
    expect(previo).toBe(4102);

    expect(await conversation.setAllMessagesUnread()).toBe(0);
    expect(conversation.lastReadMessageIndex).toBe(previo);
    expect(participantUpdates).toEqual([]);

    client.shutdown();
  });
});
