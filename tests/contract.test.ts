import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { configure } from "../src/config.ts";
import { Client } from "../src/Client.ts";
import { Participant } from "../src/Participant.ts";
import { ConnectionState, ConversationUpdateReason, MessageUpdateReason } from "../src/types.ts";
import { ClientEvent, ConversationEvent } from "../src/events.ts";
import type { RestChat, RestChatMessage, RestParticipant } from "../src/internal/restApi.ts";

// This file is NOT a behaviour suite — client.test.ts is. This one freezes the handful of
// values that sbx-omnichannel-ui depends on by name or by exact string, so that a refactor
// inside this package fails HERE instead of silently in a browser that is already in
// production. Every expectation below documents what breaks in the consumer if it changes.
//
// Rule for anyone editing this file: you do not "update the expectation to match the code".
// A failure here means either the change is wrong, or it is a deliberate breaking change that
// has to be coordinated with the consumer and called out in the release notes.

let server: ReturnType<typeof Bun.serve>;
let chats = new Map<string, RestChat>();
let sockets: Array<{ send: (data: string) => void; close: () => void }> = [];
// See client.test.ts's own comment on this exact pattern: configure() is process-global, shared
// across every test FILE in the same `bun test` run, so a client a failing assertion leaves alive
// (before its own client.shutdown() line runs) can reconnect later against a DIFFERENT file's
// mock server once THAT file's beforeEach repoints apiBaseUrl.
let clients: Client[] = [];
function newClient(token: string): Client {
  const client = new Client(token);
  clients.push(client);
  return client;
}

function msg(overrides: Partial<RestChatMessage> = {}): RestChatMessage {
  return {
    id: 4187, sid: "IM4187", body: "hola", media: null, media_type: null,
    metadata: { custom: true }, reactions: [{ author: "agent_99", value: "👍", updated_at: new Date(0).toISOString() }],
    response_time: null, chat_id: 1, participant_id: 10,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function participant(overrides: Partial<RestParticipant> = {}): RestParticipant {
  return {
    id: 10, agent_id: null, indentify: "customer_1", name: "Ada", sid: "PA10",
    conversation_sid: null, chat_id: 1, participant_type: "USER", metadata: {},
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function baseChat(overrides: Partial<RestChat> = {}): RestChat {
  return {
    id: 1, name: "Ada", conversation_sid: "CH1", status: "in_progress", duration: null,
    metadata: { phone: "+15551234567" }, source: "web", client: "web", omnichannel_tag: [],
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    participants: [participant(), participant({ id: 11, agent_id: 99, indentify: "agent_99", participant_type: "HUMAN_AGENT" })],
    chat_messages: [msg({ id: 4102 }), msg()],
    ...overrides,
  };
}

beforeEach(() => {
  clients = [];
  chats = new Map([["1", baseChat()]]);
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

afterEach(() => {
  for (const client of clients) {
    try { client.shutdown(); } catch { /* already shut down by the test itself */ }
  }
  clients = [];
  server.stop(true);
});

function waitFor<T>(emitter: { once: (event: string, cb: (arg: T) => void) => void }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

/** Reads a source file as TEXT. TypeScript interfaces are erased at compile time, so the only
 * way to assert on the declared event catalogue is to read the declaration itself. */
function source(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

/** Extracts the declared keys of an `interface X { ... }` block. */
function interfaceKeys(src: string, name: string): string[] {
  const start = src.indexOf(`interface ${name} {`);
  if (start < 0) throw new Error(`no encontré la interfaz ${name}`);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}"?([a-zA-Z][a-zA-Z.]*)"?:/gm)].map((m) => m[1]!);
}

describe("contrato público — valores de los que depende sbx-omnichannel-ui", () => {
  it("Message.index es el id de base de datos, no una posición en el array", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const { items } = await conversation.getMessages();

    // El consumidor compara índices para ordenar y para resolver "cuál es el último"
    // (ChatContext.tsx). Si esto pasara a ser 0,1,2… esas comparaciones seguirían
    // "funcionando" pero contra otros datos, que es el peor modo de falla posible.
    expect(items.map((m: any) => m.index)).toEqual([4102, 4187]);
    expect(items[0].index).not.toBe(0);
    client.shutdown();
  });

  it("Participant.identity se lee de raw.indentify — la errata del backend se conserva", () => {
    // restApi.ts:38 declara `indentify` porque así lo manda el backend. "Arreglar" el typo
    // aquí dejaría a todos los autores en agent_undefined, sin ningún error visible.
    const p = new Participant(participant({ indentify: "customer_1" }) as any);
    expect(p.identity).toBe("customer_1");

    const rest = source("internal/restApi.ts");
    expect(rest).toContain("indentify");
    expect(rest).not.toContain("  identify:");
  });

  it("Conversation.sid usa conversation_sid, con el id numérico como respaldo", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    expect(conversation.sid).toBe("CH1");
    client.shutdown();

    // El respaldo importa: hay 165 usos de .sid en el consumidor, y un undefined ahí
    // rompe el keying de toda la lista de chats.
    chats.set("1", baseChat({ conversation_sid: null }));
    const client2 = newClient("agent-token");
    const conversation2 = await waitFor<any>(client2, "conversationJoined");
    expect(conversation2.sid).toBe("1");
    client2.shutdown();
  });

  it("Message.attributes expone reactions como hermano de metadata, no anidado", async () => {
    const client = newClient("agent-token");
    const conversation = await waitFor<any>(client, "conversationJoined");
    const { items } = await conversation.getMessages();

    expect(items[1].attributes).toMatchObject({
      custom: true,
      reactions: [{ author: "agent_99", value: "👍" }],
    });
    client.shutdown();
  });

  it("los nombres de los eventos de Client no cambian de valor", () => {
    // Dos representaciones que TIENEN que coincidir: la interfaz declara las claves (lo que
    // TypeScript verifica en los .on()/.emit()) y el catálogo lleva los valores (lo que
    // realmente viaja). Afirmar solo una deja que la otra se mueva en silencio, que es
    // exactamente el agujero que esto cierra.
    const frozen = [
      "connectionError",
      "connectionStateChanged",
      "conversationJoined",
      "conversationLeft",
      "conversationRemoved",
      "conversationUpdated",
      "initFailed",
      "initialized",
      "messageAdded",
      "messageUpdated",
      "stateChanged",
      "tokenAboutToExpire",
      "tokenExpired",
    ];
    expect(Object.values(ClientEvent).sort()).toEqual(frozen);
    expect(interfaceKeys(source("Client.ts"), "ClientEvents").sort()).toEqual(frozen);
  });

  it("los nombres de los eventos de Conversation no cambian de valor", () => {
    // Dos representaciones que TIENEN que coincidir: la interfaz declara las claves (lo que
    // TypeScript verifica en los .on()/.emit()) y el catálogo lleva los valores (lo que
    // realmente viaja). Afirmar solo una deja que la otra se mueva en silencio, que es
    // exactamente el agujero que esto cierra.
    const frozen = [
      "messageAdded",
      "messageUpdated",
      "updated",
    ];
    expect(Object.values(ConversationEvent).sort()).toEqual(frozen);
    expect(interfaceKeys(source("Conversation.ts"), "ConversationEvents").sort()).toEqual(frozen);
  });

  it("ConnectionState mapea 1:1 con el enum ChatStatus del consumidor", () => {
    // sbx-omnichannel-ui/src/types/Chat.ts:41-47 declara estos mismos cinco valores, y
    // ChatContext.tsx:539 dispara el teardown del cliente comparando contra ellos.
    //
    // A2b convirtió ConnectionState de union de literales a objeto `as const`, por lo que ya no
    // hay una declaración `export type ConnectionState = "a" | "b" | ...;` que unionMembers()
    // pueda leer como texto. Se afirma en runtime sobre Object.values(...) — una aserción MÁS
    // fuerte: además de los valores, confirma que el catálogo sigue siendo el objeto que
    // Client.ts/Conversation.ts/wsTransport.ts realmente usan, no solo su tipo declarado.
    expect(Object.values(ConnectionState).sort()).toEqual([
      "connected", "connecting", "denied", "disconnected", "disconnecting",
    ]);
  });

  it("los motivos de actualización declarados siguen siendo los de Twilio", () => {
    expect(Object.values(ConversationUpdateReason)).toContain("lastMessage");
    expect(Object.values(ConversationUpdateReason)).toContain("attributes");
    expect(Object.values(MessageUpdateReason).sort()).toEqual([
      "attributes", "body", "dateUpdated", "deliveryReceipt",
    ]);
  });

  it("la superficie exportada del paquete no se reduce", async () => {
    const pkg = await import("../src/index.ts");
    // Clases y funciones.
    for (const name of ["configure", "Client", "Conversation", "Message", "MessageBuilder",
                        "Participant", "Media", "Paginator", "ConnectionError", "SendTimeoutError",
                        "MessageUpdateTimeoutError"]) {
      expect(typeof (pkg as any)[name]).toBe("function");
    }
    // Catálogos: desde A2b existen en RUNTIME, no solo como tipos. El consumidor los importa
    // en una cláusula de import de valor (ChatBodyMessagesComponent.tsx:2), así que quitar
    // cualquiera de ellos rompería el bundle sin que ningún test de comportamiento lo note.
    for (const name of ["ClientEvent", "ConversationEvent", "ConnectionState", "ClientState",
                        "ConversationUpdateReason", "MessageUpdateReason", "MessageType"]) {
      expect(typeof (pkg as any)[name]).toBe("object");
    }
  });

  it("los métodos públicos que el consumidor llama siguen existiendo", () => {
    for (const m of ["getSubscribedConversations", "getConversationBySid", "updateToken", "shutdown", "on", "off", "once", "removeAllListeners"]) {
      expect(typeof (Client.prototype as any)[m]).toBe("function");
    }
  });
});

describe("ConnectionError", () => {
  it("sobrevive como instanceof y expone el payload de Twilio", async () => {
    const { ConnectionError, SendTimeoutError, MessageUpdateTimeoutError } = await import("../src/ConnectionError.ts");

    const err = new ConnectionError("el servidor rechazó el token", { terminal: true, errorCode: 1008 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.name).toBe("ConnectionError");
    expect(err.terminal).toBe(true);
    expect(err.errorCode).toBe(1008);
    expect(err.httpStatusCode).toBeUndefined();
    expect(err.message).toBe("el servidor rechazó el token");

    // Un timeout de envío no es terminal: el transporte sigue reintentando.
    const timeout = new SendTimeoutError("sin eco");
    expect(timeout).toBeInstanceOf(ConnectionError);
    expect(timeout).toBeInstanceOf(SendTimeoutError);
    expect(timeout.name).toBe("SendTimeoutError");
    expect(timeout.terminal).toBe(false);

    const updateTimeout = new MessageUpdateTimeoutError("sin eco de update");
    expect(updateTimeout).toBeInstanceOf(ConnectionError);
    expect(updateTimeout).toBeInstanceOf(MessageUpdateTimeoutError);
    expect(updateTimeout.name).toBe("MessageUpdateTimeoutError");
    expect(updateTimeout.terminal).toBe(false);
  });
});
