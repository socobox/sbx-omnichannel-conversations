import type { ConnectionState } from "../types.js";
import { TypedEventEmitter } from "../EventEmitter.js";
import { wsUrlFor } from "../config.js";
import type { RestChatMessage } from "./restApi.js";

// Matches zavu's own /ws/chat wire protocol exactly (src/ws/chatSocket.ts). Every message shape
// here was verified against the real server source, not assumed from Twilio's own protocol (the
// two have nothing in common on the wire — this class is the ONLY place that fact leaks; Client
// re-shapes everything above it into Twilio's own event surface).
type ServerMessage =
  | { type: "connected"; subscribed_chat_ids: number[] }
  | { type: "message.new"; chat_message: RestChatMessage }
  | { type: "message.updated"; chat_message: RestChatMessage }
  | { type: "chat.finished"; chat_id: number }
  | { type: "chat.assigned"; chat_id: number }
  | { type: "error"; message: string };

interface WsTransportEvents {
  connectionStateChanged: [ConnectionState];
  connected: [number[]];
  "message.new": [RestChatMessage];
  "message.updated": [RestChatMessage];
  "chat.finished": [number];
  "chat.assigned": [number];
  serverError: [string];
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];

// Twilio's Client silently reconnects on a dropped connection (surfacing only
// connectionStateChanged transitions) — this mirrors that rather than surfacing raw WebSocket
// close/error events, since nothing in the reference frontend listens for anything lower-level.
export class WsTransport extends TypedEventEmitter<WsTransportEvents> {
  private ws: WebSocket | null = null;
  private token: string;
  private state: ConnectionState = "connecting";
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // There's no synchronous ack on the wire — the real confirmation IS the "message.new" echo
  // this same chat receives back. Twilio's own sendMessage() resolves with the new index, and the
  // reference frontend may rely on that, so this queues one resolver per chat (FIFO: a chat UI
  // only ever has one send in flight at a time in practice) instead of returning a dummy value.
  private pendingSends = new Map<number, Array<(index: number) => void>>();

  constructor(token: string) {
    super();
    this.token = token;
    this.open();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("connectionStateChanged", state);
  }

  private open(): void {
    this.setState(this.reconnectAttempt > 0 ? "connecting" : "connecting");
    const ws = new WebSocket(wsUrlFor(this.token));
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
    });

    ws.addEventListener("message", (ev) => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handleServerMessage(parsed);
    });

    ws.addEventListener("close", () => {
      if (this.closedByUser) {
        this.setState("disconnected");
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The subsequent "close" event (browsers always fire close after error) drives
      // reconnection — nothing additional to do here.
    });
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "connected":
        this.setState("connected");
        this.emit("connected", msg.subscribed_chat_ids);
        break;
      case "message.new": {
        this.emit("message.new", msg.chat_message);
        const resolvers = this.pendingSends.get(msg.chat_message.chat_id);
        if (resolvers?.length) resolvers.shift()!(msg.chat_message.id);
        break;
      }
      case "message.updated":
        this.emit("message.updated", msg.chat_message);
        break;
      case "chat.finished":
        this.emit("chat.finished", msg.chat_id);
        break;
      case "chat.assigned":
        this.emit("chat.assigned", msg.chat_id);
        break;
      case "error":
        this.emit("serverError", msg.message);
        break;
    }
  }

  private scheduleReconnect(): void {
    this.setState(this.reconnectAttempt === 0 ? "disconnecting" : "connecting");
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByUser) this.open();
    }, delay);
  }

  /** Matches Client#updateToken — swaps credentials and reconnects with the new one. */
  updateToken(token: string): void {
    this.token = token;
    this.closedByUser = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.reconnectAttempt = 0;
    this.open();
  }

  sendMessage(chatId: number, body: string): Promise<number> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("sbx-omnichannel-conversations: cannot send a message while disconnected"));
    }
    this.ws.send(JSON.stringify({ type: "message.send", chat_id: chatId, body }));
    return new Promise((resolve) => {
      const list = this.pendingSends.get(chatId) ?? [];
      list.push(resolve);
      this.pendingSends.set(chatId, list);
    });
  }

  shutdown(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.removeAllListeners();
  }
}
