import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import { ConnectionError } from "../src/ConnectionError.ts";
import type { RestChat, RestChatMessage } from "../src/internal/restApi.ts";

// The point of the release: a caller can wait until the client is genuinely usable, and a
// reconnect picks up what happened while the socket was down.
let server: ReturnType<typeof Bun.serve>;
let chats = new Map<string, RestChat>();
let sockets: Array<{ send: (d: string) => void; close: () => void }> = [];
let clients: Client[] = [];
let subscribedIds = [1];
/** Chat ids whose GET must fail, to exercise partial and total hydration failure. */
let failingChats = new Set<string>();
/** Delay added to every GET /chats/:id, to exercise the hydration timeout. */
let chatDelayMs = 0;

function msg(id: number, body = `m${id}`): RestChatMessage {
  return {
    id, sid: `IM${id}`, body, media: null, media_type: null, metadata: {}, reactions: [],
    response_time: null, chat_id: 1, participant_id: 10,
    created_at: new Date(id).toISOString(), updated_at: new Date(id).toISOString(),
  };
}

function chat(id: number, messages: RestChatMessage[] = [msg(4102)], unread_count: number | null = null): RestChat {
  return {
    id, name: `chat ${id}`, conversation_sid: `CH${id}`, status: "in_progress", duration: null,
    metadata: {}, source: "web", client: "web", omnichannel_tag: [],
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    participants: [{ id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: null, conversation_sid: null, chat_id: id, participant_type: "USER", metadata: {}, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }],
    chat_messages: messages,
    unread_count,
  };
}

function newClient(token = "agent-token"): any {
  const client = new Client(token);
  clients.push(client);
  return client;
}

beforeEach(() => {
  clients = [];
  sockets = [];
  subscribedIds = [1];
  failingChats = new Set();
  chatDelayMs = 0;
  chats = new Map([["1", chat(1)]]);

  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const m = url.pathname.match(/^\/chats\/([^/]+)$/);
      if (m) {
        const id = m[1]!;
        if (failingChats.has(id)) return new Response("boom", { status: 500 });
        if (chatDelayMs) await new Promise((r) => setTimeout(r, chatDelayMs));
        const found = chats.get(id);
        return found ? Response.json(found) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws as unknown as { send: (d: string) => void; close: () => void });
        ws.send(JSON.stringify({ type: "connected", subscribed_chat_ids: subscribedIds }));
      },
      message() {},
    },
  });
  configure({ apiBaseUrl: `http://localhost:${server.port}` });
});

afterEach(() => {
  for (const c of clients) { try { c.shutdown(); } catch { /* ya apagado */ } }
  clients = [];
  server.stop(true);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function waitFor<T>(e: { once: (ev: string, cb: (a: T) => void) => void }, ev: string, timeoutMs = 8000): Promise<T> {
  // Acotado a propósito: un evento que no llega debe FALLAR, no colgar la suite. Una corrida
  // colgada en CI no dice qué se rompió y bloquea el pipeline hasta que alguien la mate.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`esperando el evento "${ev}" más de ${timeoutMs}ms`)), timeoutMs);
    e.once(ev, (arg: T) => { clearTimeout(timer); resolve(arg); });
  });
}
/** Kills every socket and resolves once the client has reconnected AND re-hydrated. */
function forceReconnect(client: any): Promise<void> {
  const done = new Promise<void>((resolve) => {
    let wentDown = false;
    const onState = (s: string) => {
      if (s !== "connected") { wentDown = true; return; }
      if (!wentDown) return;
      client.off("connectionStateChanged", onState);
      resolve();
    };
    client.on("connectionStateChanged", onState);
  });
  const live = sockets;
  sockets = [];
  for (const ws of live) ws.close();
  return done;
}

describe("Client.create y el arranque", () => {
  it("resuelve solo cuando las conversaciones ya están cargadas", async () => {
    chats = new Map([["1", chat(1)], ["2", chat(2)]]);
    subscribedIds = [1, 2];

    const client = await Client.create("agent-token");
    clients.push(client);

    // Sin esperar nada más: la lista está completa en el instante en que create() resuelve.
    expect((await client.getSubscribedConversations()).items).toHaveLength(2);
    expect(client.connectionState).toBe("connected");
    expect(client.state).toBe("initialized");
  });

  it("el camino legacy tampoco ve ya la caché vacía al reaccionar a 'connected'", async () => {
    chats = new Map([["1", chat(1)], ["2", chat(2)]]);
    subscribedIds = [1, 2];

    // Reproducción literal de ChatContext.tsx:271-281, que es donde nació todo esto.
    const client = newClient();
    const seen = await new Promise<number>((resolve) => {
      client.on("connectionStateChanged", async (state: string) => {
        if (state !== "connected") return;
        resolve((await client.getSubscribedConversations()).items.length);
      });
    });

    expect(seen).toBe(2);
  });

  it("emite initialized una sola vez, aunque reconecte", async () => {
    const client = await Client.create("agent-token");
    clients.push(client);

    let initialized = 0;
    client.on("initialized", () => { initialized += 1; });
    await forceReconnect(client);

    // Twilio inicializa un Client exactamente una vez; las reconexiones se expresan solo por
    // connectionStateChanged. Re-emitirlo volvería inservible el handler de bootstrap.
    expect(initialized).toBe(0);
    expect(client.state).toBe("initialized");
  });

  it("una hidratación que falla del todo rechaza create() con un error terminal", async () => {
    failingChats = new Set(["1"]);
    await expect(Client.create("agent-token")).rejects.toThrow(/failed to load 1 of 1/);
    await expect(Client.create("agent-token")).rejects.toBeInstanceOf(ConnectionError);
  });

  it("una hidratación parcial sí inicializa, y reporta lo que falló", async () => {
    chats = new Map([["1", chat(1)], ["2", chat(2)]]);
    subscribedIds = [1, 2];
    failingChats = new Set(["2"]);

    const client = newClient();
    const errors: any[] = [];
    client.on("connectionError", (e: any) => errors.push(e));

    await waitFor(client, "initialized");

    // Negarse a arrancar entero por un chat que el backend no puede servir sería peor.
    expect((await client.getSubscribedConversations()).items).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].terminal).toBe(false);
    expect(errors[0].message).toMatch(/failed to load 1 of 2/);
  });

  it("un chat colgado no deja la conexión atascada en 'connecting' para siempre", async () => {
    chatDelayMs = 30_000; // más que HYDRATION_TIMEOUT_MS
    const client = newClient();
    const failure = await waitFor<any>(client, "initFailed", 15_000);

    // Con Promise.all y sin timeout, el evento `connected` no se emitía JAMÁS y el agente se
    // quedaba en la pantalla de carga sin error alguno.
    expect(failure.error.message).toMatch(/timed out/);
    expect(client.state).toBe("failed");
    expect(client.connectionState).toBe("connected");
  }, 20_000);

  it("shutdown durante create() no deja a quien espera colgado para siempre", async () => {
    chatDelayMs = 30_000;
    const client = newClient();
    const pending = (client as any).initPromise;
    client.shutdown();
    await expect(pending).rejects.toThrow(/shut down before it finished initializing/);
  });
});

describe("reconexión: re-hidratación", () => {
  it("recupera los mensajes que llegaron mientras el socket estaba caído", async () => {
    const client = await Client.create("agent-token");
    clients.push(client);
    const before = (await client.getSubscribedConversations()).items[0] as any;
    expect((await before.getMessages(100)).items).toHaveLength(1);

    // El backend sigue vivo durante el corte y acumula mensajes.
    chats.set("1", chat(1, [msg(4102), msg(4190, "llegó durante el corte"), msg(4191, "y este también")]));
    await forceReconnect(client);

    const after = (await client.getSubscribedConversations()).items[0] as any;
    // MISMA instancia: el consumidor filtra su lista por identidad de objeto, así que
    // reemplazarla dejaría la conversación abierta apuntando a algo que ya nadie actualiza.
    expect(after).toBe(before);
    expect((await after.getMessages(100)).items).toHaveLength(3);
  });

  it("avisa de cada mensaje recuperado, para que el chat abierto los pinte", async () => {
    const client = await Client.create("agent-token");
    clients.push(client);
    const conversation = (await client.getSubscribedConversations()).items[0] as any;

    // Así es como un consumidor pinta la conversación abierta: lee el historial una vez y a
    // partir de ahí solo escucha. Si la re-hidratación no avisa, lo recuperado queda en memoria
    // y nunca llega a la pantalla.
    const pintados: number[] = [];
    conversation.on("messageAdded", (m: any) => pintados.push(m.index));

    chats.set("1", chat(1, [msg(4102), msg(4190), msg(4191)]));
    await forceReconnect(client);

    expect(pintados).toEqual([4190, 4191]);
  });

  it("no repite el feed agregado del Client al re-hidratar", async () => {
    const client = await Client.create("agent-token");
    clients.push(client);

    // El feed de Client es el que dispara notificaciones. Repetirlo tras un corte de cinco
    // minutos sería un toast por cada mensaje recuperado.
    let notificaciones = 0;
    client.on("messageAdded", () => { notificaciones += 1; });

    chats.set("1", chat(1, [msg(4102), msg(4190), msg(4191)]));
    await forceReconnect(client);

    expect(notificaciones).toBe(0);
  });

  it("preserva el estado de no leídos al re-hidratar", async () => {
    chats.set("1", chat(1, [msg(4102)], 0));
    const client = await Client.create("agent-token");
    clients.push(client);
    const conversation = (await client.getSubscribedConversations()).items[0] as any;
    expect(await conversation.getUnreadMessagesCount()).toBe(0);

    // El backend sigue vivo durante el corte, acumula dos mensajes, y su unread_count lo refleja
    // — el servidor es la fuente de verdad ahora, no un valor que este objeto tuviera que
    // preservar por su cuenta desde antes del corte.
    chats.set("1", chat(1, [msg(4102), msg(4190), msg(4191)], 2));
    await forceReconnect(client);

    expect(await conversation.getUnreadMessagesCount()).toBe(2);
    expect(conversation.lastReadMessageIndex).toBe(4102);
  });

  it("re-hidratar NO emite lastReadMessageIndex, aunque el estado de leído haya cambiado", async () => {
    // Guarda de compatibilidad con el consumidor: ChatContext.tsx trata esa razón como "el
    // agente acaba de marcar como leído" y pone el badge en 0. Si refreshFromRest la emitiera,
    // cada reconexión borraría el badge de todo lo llegado durante el corte — el bug exacto que
    // el release de persistencia server-side vino a arreglar, reintroducido por la puerta de
    // atrás.
    const client = await Client.create("agent-token");
    clients.push(client);

    const razones: string[] = [];
    client.on("conversationUpdated", ({ updateReasons }: any) => razones.push(...updateReasons));

    chats.set("1", chat(1, [msg(4102), msg(4190)], 1));
    await forceReconnect(client);

    expect(razones).toContain("lastMessage");
    expect(razones).not.toContain("lastReadMessageIndex");
  });

  it("emite conversationLeft con la instancia cacheada cuando el chat deja de estar asignado", async () => {
    chats = new Map([["1", chat(1)], ["2", chat(2)]]);
    subscribedIds = [1, 2];
    const client = await Client.create("agent-token");
    clients.push(client);
    const originals = (await client.getSubscribedConversations()).items as any[];
    const target = originals.find((c) => c.sid === "CH2");

    const left = waitFor<any>(client, "conversationLeft");
    subscribedIds = [1];
    await forceReconnect(client);

    const emitted = await left;
    expect(emitted).toBe(target);
    expect((await client.getSubscribedConversations()).items).toHaveLength(1);
  });
});
