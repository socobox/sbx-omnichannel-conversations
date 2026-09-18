import { ConnectionState } from "../types.js";
import { TypedEventEmitter } from "../EventEmitter.js";
import { wsUrlFor } from "../config.js";
import { ConnectionError, SendTimeoutError } from "../ConnectionError.js";
import { ClientFrameType, ServerFrameType, TransportEvent } from "./wireProtocol.js";
import type { RestChatMessage } from "./restApi.js";

// Matches zavu's own /ws/chat wire protocol exactly (src/ws/chatSocket.ts). Every message shape
// here was verified against the real server source, not assumed from Twilio's own protocol (the
// two have nothing in common on the wire — this class is the ONLY place that fact leaks; Client
// re-shapes everything above it into Twilio's own event surface).
type ServerMessage =
  | { type: typeof ServerFrameType.Connected; subscribed_chat_ids: number[] }
  | { type: typeof ServerFrameType.MessageNew; chat_message: RestChatMessage }
  | { type: typeof ServerFrameType.MessageUpdated; chat_message: RestChatMessage }
  | { type: typeof ServerFrameType.ChatFinished; chat_id: number }
  | { type: typeof ServerFrameType.ChatAssigned; chat_id: number }
  | { type: typeof ServerFrameType.Error; message: string };

// Keys stay as string literals, not computed keys off TransportEvent (internal/wireProtocol.ts) —
// consistent with the same choice in Client.ts/Conversation.ts, even though this interface isn't
// itself read by tests/contract.test.ts (it's internal, never exported).
/** Internal error shape. Deliberately NOT the public ConnectionError class: this layer stays
 * free of the package's public surface, and Client is the single place that translates. */
export interface TransportError {
  terminal: boolean;
  message: string;
  errorCode?: number;
}

interface WsTransportEvents {
  connectionStateChanged: [ConnectionState];
  /** NOTE: connectionState is deliberately NOT "connected" yet — Client hydrates the listed
   * chats first and then calls confirmConnected(generation). */
  connected: [{ chatIds: number[]; generation: number }];
  "message.new": [RestChatMessage];
  "message.updated": [RestChatMessage];
  "chat.finished": [number];
  "chat.assigned": [number];
  serverError: [TransportError];
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];

/** Every client reconnecting on the same fixed schedule means an outage they shared — an office
 * Wi-Fi blip, a backend deploy — ends with all of them hitting /chats/:id in the same second.
 * A spread of +/-30% turns that thundering herd back into a trickle. */
const RECONNECT_JITTER = 0.3;

/** No synchronous ack exists on the wire, so a send whose echo never arrives must not strand its
 * caller's promise forever — a chat UI would sit on a permanently "sending" bubble. This is the
 * backstop for "socket alive, server swallowed it"; a dropped socket rejects immediately. */
const SEND_ACK_TIMEOUT_MS = 30_000;

interface PendingSend {
  /** Kept so the echo can be matched to the send that caused it, rather than to whatever
   * message.new happens to arrive first for this chat. */
  readonly body: string;
  /** This agent's own participant row in the chat, when known. Body alone is not enough to
   * correlate: in a real chat the two sides routinely send the same short text ("ok", "gracias")
   * at the same time, and then the customer's echo matches the agent's pending send. */
  readonly participantId: number | null;
  readonly resolve: (index: number) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// Twilio's Client silently reconnects on a dropped connection (surfacing only
// connectionStateChanged transitions) — this mirrors that rather than surfacing raw WebSocket
// close/error events, since nothing in the reference frontend listens for anything lower-level.
export class WsTransport extends TypedEventEmitter<WsTransportEvents> {
  private ws: WebSocket | null = null;
  private token: string;
  private state: ConnectionState = ConnectionState.Connecting;
  private closedByUser = false;
  /** Set by shutdown() and never cleared: a disposed transport stays disposed. Without it,
   * updateToken() would clear closedByUser and reopen a socket nobody is listening to — the
   * listeners were removed — which then reconnects forever, invisibly. Reachable for real: the
   * consumer unmounts (shutdown) while a token refresh is still in flight. */
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // There's no synchronous ack on the wire — the real confirmation IS the "message.new" echo
  // this same chat receives back. Twilio's own sendMessage() resolves with the new index, and the
  // reference frontend may rely on that, so this queues one resolver per chat (FIFO: a chat UI
  // only ever has one send in flight at a time in practice) instead of returning a dummy value.
  private pendingSends = new Map<number, PendingSend[]>();
  /** Bumped once per socket. Every listener registered in open() closes over the value it was
   * opened with and no-ops once it is stale, so a `close` arriving late from a socket that was
   * already replaced cannot schedule a reconnect on top of a healthy connection. */
  private currentGeneration = 0;

  constructor(token: string) {
    super();
    this.token = token;
    this.open();
  }

  /** Readable synchronously at any time. A listener that subscribes after the transition already
   * happened — the common case inside a React effect — otherwise has no way to learn the current
   * value, only to wait for the next change. */
  get connectionState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit(TransportEvent.ConnectionStateChanged, state);
  }

  private open(): void {
    const generation = ++this.currentGeneration;
    this.setState(ConnectionState.Connecting);

    // Todo el cuerpo va en un try/catch: si `new WebSocket(...)` o el registro de sus listeners
    // lanzara por cualquier razón, sin esto el ciclo de reconexión moría en silencio para
    // siempre — nada más vuelve a llamar scheduleReconnect(), y el estado queda pegado en
    // "Connecting" (ya seteado arriba) sin ningún indicio de que algo se rompió. Un consumidor
    // (ej. el banner de conexión de sbx-omnichannel-ui) vería "reconectando" congelado, cuando en
    // realidad el propio transporte dejó de intentarlo.
    try {
      const ws = new WebSocket(wsUrlFor(this.token));
      this.ws = ws;

      ws.addEventListener("open", () => {
        if (generation !== this.currentGeneration) return;
        // Deliberately does NOT reset reconnectAttempt. A server that accepts the upgrade and then
        // closes — a token rejected after the handshake, a backend draining a deploy — would reset
        // the counter on every cycle, pinning the delay at RECONNECT_DELAYS_MS[0] forever and
        // defeating both the backoff and the jitter. The reset lives in the `connected` frame,
        // which is the first evidence the connection actually works.
      });

      ws.addEventListener("message", (ev) => {
        if (generation !== this.currentGeneration) return;
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        this.handleServerMessage(parsed, generation);
      });

      ws.addEventListener("close", () => {
        if (generation !== this.currentGeneration) return;
        // Every echo this socket was going to carry is gone with it. Rejecting now, rather than
        // waiting out SEND_ACK_TIMEOUT_MS, is what lets a UI re-enable its send button in
        // milliseconds instead of half a minute.
        this.failPendingSends(new SendTimeoutError("sbx-omnichannel-conversations: the connection closed before the server echoed this message back"));
        if (this.closedByUser) {
          this.setState(ConnectionState.Disconnected);
          return;
        }
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // The subsequent "close" event (browsers always fire close after error) drives
        // reconnection — nothing additional to do here.
      });
    } catch {
      if (generation !== this.currentGeneration) return;
      if (this.closedByUser) {
        this.setState(ConnectionState.Disconnected);
        return;
      }
      this.scheduleReconnect();
    }
  }

  private handleServerMessage(msg: ServerMessage, generation: number): void {
    switch (msg.type) {
      case ServerFrameType.Connected:
        this.reconnectAttempt = 0;
        // Deliberately does NOT setState(Connected) here. Client hydrates the subscribed chats
        // and then calls confirmConnected(), so that a consumer reacting to
        // connectionStateChanged === "connected" — the pattern the reference frontend uses —
        // sees a populated cache instead of racing N in-flight GET /chats/:id.
        this.emit(TransportEvent.Connected, { chatIds: msg.subscribed_chat_ids, generation });
        break;
      case ServerFrameType.MessageNew: {
        // Settled BEFORE emitting: the emit chain runs synchronously into application listeners,
        // and one of them throwing would abort this handler before the ack was settled, hanging
        // a send whose echo had in fact arrived.
        this.settleSend(msg.chat_message.chat_id, msg.chat_message);
        this.emit(TransportEvent.MessageNew, msg.chat_message);
        break;
      }
      case ServerFrameType.MessageUpdated:
        this.emit(TransportEvent.MessageUpdated, msg.chat_message);
        break;
      case ServerFrameType.ChatFinished:
        this.emit(TransportEvent.ChatFinished, msg.chat_id);
        break;
      case ServerFrameType.ChatAssigned:
        this.emit(TransportEvent.ChatAssigned, msg.chat_id);
        break;
      case ServerFrameType.Error:
        this.emit(TransportEvent.ServerError, { terminal: false, message: msg.message });
        break;
    }
  }

  /**
   * @internal — called by Client once the chats listed in the `connected` frame for `generation`
   * have been hydrated (successfully or not: the socket is up either way). A stale generation or
   * a socket that already closed is a no-op, so a connection that died mid-hydration can never
   * be announced as connected.
   */
  confirmConnected(generation: number): void {
    if (generation !== this.currentGeneration) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.setState(ConnectionState.Connected);
  }

  private scheduleReconnect(): void {
    this.setState(this.reconnectAttempt === 0 ? ConnectionState.Disconnecting : ConnectionState.Connecting);
    const base = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    const delay = Math.round(base * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  /** The token currently authenticating this connection — reused for REST calls too (see restApi.ts). */
  get currentToken(): string {
    return this.token;
  }

  /** Matches Client#updateToken — swaps credentials and reconnects with the new one. */
  updateToken(token: string): void {
    if (this.disposed) return;
    this.token = token;
    this.closedByUser = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.failPendingSends(new SendTimeoutError("sbx-omnichannel-conversations: the connection was replaced before the server echoed this message back"));
    const previous = this.ws;
    this.ws = null;
    // Bump BEFORE closing. The old socket's `close` fires asynchronously, after open() below has
    // already installed the replacement; without this it would see closedByUser === false and
    // schedule a reconnect on top of the new, healthy socket — orphaning it while its listeners
    // stayed attached, so every later frame was handled twice.
    this.currentGeneration += 1;
    previous?.close();
    this.open();
  }

  sendMessage(chatId: number, body: string, participantId: number | null = null): Promise<number> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Typed like every other rejection here, so a consumer's `instanceof ConnectionError`
      // branch covers the failure it will hit most often instead of falling through.
      return Promise.reject(new ConnectionError("sbx-omnichannel-conversations: cannot send a message while disconnected", { terminal: false }));
    }
    this.ws.send(JSON.stringify({ type: ClientFrameType.MessageSend, chat_id: chatId, body }));
    return new Promise<number>((resolve, reject) => {
      const pending: PendingSend = { body, participantId, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        this.discardPendingSend(chatId, pending);
        reject(new SendTimeoutError(`sbx-omnichannel-conversations: timed out after ${SEND_ACK_TIMEOUT_MS}ms waiting for the server to echo this message back`));
      }, SEND_ACK_TIMEOUT_MS);
      const list = this.pendingSends.get(chatId) ?? [];
      list.push(pending);
      this.pendingSends.set(chatId, list);
    });
  }

  /**
   * Resolves the send this echo actually belongs to — and ONLY that one.
   *
   * The queue is per chat, and a customer can type while an agent's send is in flight, so
   * popping the oldest entry for any incoming message resolves the agent's promise with the
   * CUSTOMER's message id. Matching on the body is the only correlation the wire offers: the
   * protocol carries no client-supplied reference on `message.send` (see ClientFrameType).
   *
   * An echo that matches nothing is left alone rather than falling back to the oldest, because
   * that fallback IS the bug. The cost is that a server which rewrites the body it echoes would
   * strand the send until SEND_ACK_TIMEOUT_MS — documented, and preferable to handing the caller
   * a confidently wrong id.
   */
  private settleSend(chatId: number, echo: { body: string | null; participant_id: number | null; id: number }): void {
    const list = this.pendingSends.get(chatId);
    if (!list?.length) return;
    const messageId = echo.id;
    const at = list.findIndex((pending) =>
      pending.body === echo.body &&
      (pending.participantId == null || pending.participantId === echo.participant_id));
    if (at < 0) return;
    const [pending] = list.splice(at, 1);
    if (list.length === 0) this.pendingSends.delete(chatId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(messageId);
  }

  private discardPendingSend(chatId: number, pending: PendingSend): void {
    const list = this.pendingSends.get(chatId);
    if (!list) return;
    const at = list.indexOf(pending);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.pendingSends.delete(chatId);
  }

  private failPendingSends(error: Error): void {
    if (this.pendingSends.size === 0) return;
    const lists = [...this.pendingSends.values()];
    this.pendingSends.clear();
    for (const list of lists) {
      for (const pending of list) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }

  shutdown(): void {
    this.closedByUser = true;
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPendingSends(new SendTimeoutError("sbx-omnichannel-conversations: the client shut down before the server echoed this message back", { terminal: true }));
    this.currentGeneration += 1;
    const previous = this.ws;
    this.ws = null;
    // Assigned directly rather than through setState: removeAllListeners() below means nobody
    // could hear the event anyway, but the getter must still read "disconnected" afterwards.
    this.state = ConnectionState.Disconnected;
    previous?.close();
    this.removeAllListeners();
  }
}
