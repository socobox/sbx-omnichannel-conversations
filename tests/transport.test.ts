import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import { ConnectionError, SendTimeoutError } from "../src/ConnectionError.ts";
import type { RestChat, RestChatMessage } from "../src/internal/restApi.ts";

// Reconnection and ack handling. Everything here is about what happens when the socket does NOT
// behave: it drops mid-send, it is replaced under a token rotation, or the server never echoes.
let server: ReturnType<typeof Bun.serve>;
let sockets: Array<{ send: (d: string) => void; close: () => void }> = [];
let upgrades = 0;
/** When true the server accepts the send but never echoes it back. */
let swallowSends = false;
/** Acepta el upgrade y cierra en seguida: token rechazado tras el handshake, backend drenando. */
let rejectAfterUpgrade = false;
/** Every Client built in this file, so afterEach can shut it down even when a test fails before
 * its own shutdown() line. A leaked client keeps reconnecting, and since `port: 0` lets the OS
 * reuse a just-freed port, it can land on the NEXT test's server and inflate its counters. */
let clients: Client[] = [];

/** Un JWT estructuralmente válido (sin firmar) con el claim agent_id que Client decodifica. */
function agentJwt(agentId = 99): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ agent_id: agentId, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function newClient(token = agentJwt()): any {
  const client = new Client(token);
  clients.push(client);
  return client;
}

function msg(id: number, body: string, participantId = 10): RestChatMessage {
  return {
    id, sid: `IM${id}`, body, media: null, media_type: null, metadata: {}, reactions: [],
    response_time: null, chat_id: 1, participant_id: participantId,
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
  chat_messages: [msg(100, "hola")],
};

beforeEach(() => {
  clients = [];
  sockets = [];
  upgrades = 0;
  swallowSends = false;
  rejectAfterUpgrade = false;
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/chat") {
        upgrades += 1;
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      }
      if (/^\/chats\/[^/]+$/.test(url.pathname)) return Response.json(chat);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (rejectAfterUpgrade) { ws.close(1008, "unauthorized"); return; }
        sockets.push(ws as unknown as { send: (d: string) => void; close: () => void });
        ws.send(JSON.stringify({ type: "connected", subscribed_chat_ids: [1] }));
      },
      message() { /* deliberately never echoes: see swallowSends */ },
    },
  });
  configure({ apiBaseUrl: `http://localhost:${server.port}` });
});

afterEach(() => {
  for (const client of clients) {
    try { client.shutdown(); } catch { /* ya apagado por el propio test */ }
  }
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
function killSockets(): void {
  const live = sockets;
  sockets = [];
  for (const ws of live) ws.close();
}

describe("transporte: reconexión y acuses", () => {
  it("expone connectionState de forma síncrona, desde antes de conectar", async () => {
    const client = newClient("agent-token");
    // Sin getter, quien se suscriba después de la transición no tiene forma de saber el estado:
    // solo puede esperar al próximo cambio, que quizá no llegue nunca.
    expect(client.connectionState).toBe("connecting");

    // Desde A4, "connected" significa "socket abierto Y conversaciones hidratadas". En el
    // instante de conversationJoined la hidratación sigue en curso, así que todavía no lo es.
    await waitFor(client, "conversationJoined");
    expect(client.connectionState).toBe("connecting");

    await waitFor(client, "initialized");
    expect(client.connectionState).toBe("connected");
    client.shutdown();
    expect((client as any).transport.connectionState).toBe("disconnected");
  });

  it("rechaza el envío en vuelo cuando el socket cae, sin esperar el timeout", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    swallowSends = true;
    const inFlight = conversation.sendMessage("nunca ecoado");
    await sleep(20);
    killSockets();

    // Antes esto quedaba pendiente para siempre y el botón de enviar no se rehabilitaba nunca.
    await expect(inFlight).rejects.toThrow(/connection closed/);
    await expect(inFlight).rejects.toBeInstanceOf(SendTimeoutError);
    client.shutdown();
  });

  it("resuelve el envío con SU propio eco, no con el mensaje que escribió el cliente", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    const inFlight = conversation.sendMessage("respuesta del agente");
    await sleep(20);

    // El cliente escribe mientras el envío del agente sigue en vuelo. Antes, ESTE mensaje
    // resolvía la promesa del agente, devolviéndole un id que no es el suyo.
    for (const ws of sockets) ws.send(JSON.stringify({ type: "message.new", chat_message: msg(500, "pregunta del cliente") }));
    await sleep(20);
    for (const ws of sockets) ws.send(JSON.stringify({ type: "message.new", chat_message: msg(501, "respuesta del agente", 11) }));

    expect(await inFlight).toBe(501);
    client.shutdown();
  });

  it("updateToken reemplaza el socket sin dejar una reconexión espuria detrás", async () => {
    const client = newClient("agent-token");
    await waitFor(client, "conversationJoined");
    const before = upgrades;

    await client.updateToken("token-rotado");
    await sleep(1600); // más que el primer backoff, para que una reconexión espuria ya se vería

    // Exactamente una conexión nueva: la del token rotado. Sin la guarda de generación, el
    // `close` tardío del socket viejo agendaba otra encima de la sana.
    expect(upgrades).toBe(before + 1);
    expect((client as any).transport.connectionState).toBe("connected");
    client.shutdown();
  });

  it("shutdown deja el transporte sin timers ni envíos colgados", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");

    swallowSends = true;
    const inFlight = conversation.sendMessage("en vuelo al apagar");
    await sleep(20);
    client.shutdown();

    await expect(inFlight).rejects.toThrow(/shut down/);
    // Un timer de 30 s sobreviviendo al shutdown mantiene vivo el proceso de bun test.
    expect((client as any).transport["pendingSends"].size).toBe(0);
    expect((client as any).transport["reconnectTimer"]).toBeNull();
  });
});

describe("transporte: correcciones de la revisión", () => {
  it("no confunde el eco del cliente con el del agente cuando el texto es idéntico", async () => {
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");

    // "ok" es el caso común, no el raro: los dos lados de un chat mandan el mismo texto corto
    // a la vez todo el tiempo. Correlacionar solo por body resolvía con el id del cliente.
    const inFlight = conversation.sendMessage("ok");
    await sleep(20);
    for (const ws of sockets) ws.send(JSON.stringify({ type: "message.new", chat_message: msg(700, "ok", 10) }));
    await sleep(20);
    for (const ws of sockets) ws.send(JSON.stringify({ type: "message.new", chat_message: msg(701, "ok", 11) }));

    expect(await inFlight).toBe(701);
  });

  it("updateToken no resucita un transporte ya apagado", async () => {
    const client = newClient();
    await waitFor(client, "conversationJoined");
    client.shutdown();
    const after = upgrades;

    // El consumidor desmonta (shutdown) y un refresco de token en vuelo resuelve después.
    await client.updateToken(agentJwt(99));
    await sleep(300);

    expect(upgrades).toBe(after);
    expect(client.transport.connectionState).toBe("disconnected");
  });

  it("el backoff escala cuando el servidor acepta el upgrade y cierra en seguida", async () => {
    rejectAfterUpgrade = true;
    const client = newClient();
    await sleep(2600);

    // Reseteando en el evento `open` del socket, cada ciclo volvía a RECONNECT_DELAYS_MS[0] y
    // el backoff nunca escalaba. Con el reset en el frame `connected`, sí escala.
    expect(client.transport["reconnectAttempt"]).toBeGreaterThan(1);
    expect(upgrades).toBeLessThan(6);
  });

  it("pero sí vuelve a cero cuando la conexión de verdad funciona", async () => {
    // La otra mitad del contrato: si el reset viviera en el evento `open` del socket, este test
    // pasaría igual — por eso hace falta el de arriba. Y si no hubiera reset en ningún lado, el
    // backoff se quedaría alto para siempre tras una caída pasajera, que es este.
    rejectAfterUpgrade = true;
    const client = newClient();
    await sleep(1500);
    expect(client.transport["reconnectAttempt"]).toBeGreaterThan(0);

    rejectAfterUpgrade = false;
    await waitFor(client, "conversationJoined");

    expect(client.transport["reconnectAttempt"]).toBe(0);
  });

  it("un throw al construir el WebSocket durante open() no mata el ciclo de reconexión", async () => {
    const client = newClient();
    await waitFor(client, "conversationJoined");

    // El parche del global y la llamada a open() son 100% síncronos (sin ningún await de por
    // medio): Bun corre los archivos de test en paralelo dentro del MISMO proceso, así que un
    // WebSocket global parchado que sobreviviera aunque sea un tick async se filtraría a
    // cualquier otro test en vuelo (ES justo lo que pasó en el primer intento de este test:
    // rompió aserciones de sendMessage en client.test.ts que ni tocan este archivo).
    const RealWebSocket = globalThis.WebSocket;
    try {
      // @ts-expect-error asignación de solo-test al constructor global
      globalThis.WebSocket = function () {
        throw new Error("simulated WebSocket constructor failure");
      };
      // Llamada directa al método privado: no hace falta esperar un ciclo real de reconexión
      // (killSockets() + backoff) para probar que open() en sí mismo sobrevive a su propio throw.
      (client.transport as any).open();
    } finally {
      globalThis.WebSocket = RealWebSocket;
    }

    // Sin el try/catch de open() (wsTransport.ts), este throw habría dejado reconnectTimer sin
    // programar — nada más vuelve a llamar scheduleReconnect(), y el ciclo de reconexión muere
    // ahí para siempre. scheduleReconnect() sí corrió: puso "disconnecting" (primer intento tras
    // una conexión real, reconnectAttempt en 0) y programó el próximo open().
    expect((client.transport as any).reconnectTimer).not.toBeNull();
    expect(client.connectionState).toBe("disconnecting");
  });

  it("enviar sin conexión rechaza con el tipo de error documentado", async () => {
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");
    client.shutdown();

    const rejected = conversation.sendMessage("sin socket");
    await expect(rejected).rejects.toBeInstanceOf(ConnectionError);
  });

  it("salda el acuse ANTES de emitir, para no quedar rehén de los listeners del consumidor", async () => {
    const client = newClient();
    const conversation = await waitFor<any>(client, "conversationJoined");

    // La cadena de emit corre sincrónicamente hasta el código de la aplicación. Si el acuse se
    // saldara DESPUÉS, un listener que lance abortaría el handler y dejaría colgado un envío
    // cuyo eco sí había llegado — 30 s con el botón de enviar deshabilitado.
    let pendingWhenListenerRan = -1;
    client.on("messageAdded", () => {
      pendingWhenListenerRan = client.transport["pendingSends"].size;
    });

    const inFlight = conversation.sendMessage("orden de saldado");
    await sleep(20);
    for (const ws of sockets) ws.send(JSON.stringify({ type: "message.new", chat_message: msg(800, "orden de saldado", 11) }));

    expect(await inFlight).toBe(800);
    // Cero al momento de correr el listener = el acuse ya estaba saldado.
    expect(pendingWhenListenerRan).toBe(0);
  });
});
