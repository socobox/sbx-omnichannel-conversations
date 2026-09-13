import { TypedEventEmitter } from "./EventEmitter.js";
import { Conversation } from "./Conversation.js";
import { Message } from "./Message.js";
import { Paginator } from "./Paginator.js";
import { RestApi, type RestChatMessage } from "./internal/restApi.js";
import { WsTransport } from "./internal/wsTransport.js";
import type { ConnectionState, ConversationUpdateReason, MessageUpdateReason } from "./types.js";

interface ClientEvents {
  connectionStateChanged: [ConnectionState];
  tokenAboutToExpire: [];
  tokenExpired: [];
  conversationJoined: [Conversation];
  conversationLeft: [Conversation];
  conversationRemoved: [Conversation];
  conversationUpdated: [{ conversation: Conversation; updateReasons: ConversationUpdateReason[] }];
  messageAdded: [Message];
  messageUpdated: [{ message: Message; updateReasons: MessageUpdateReason[] }];
}

/** Decodes a JWT's `exp` claim (seconds since epoch) without pulling in a JWT library — the same
 * trick @twilio/conversations itself uses internally to drive tokenAboutToExpire/tokenExpired. */
function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

const TOKEN_ABOUT_TO_EXPIRE_MS = 3 * 60 * 1000;

// Matches @twilio/conversations' own `Client` — the single entry point the reference frontend
// constructs with `new Client(token)`. Everything Twilio-specific (Chat Grant JWTs, Conversation
// Service SIDs) is gone; `token` here is zavu's own agent WS token, the exact same one
// `/agents/:id/login` (aliased to `/agents/:id/ws_token`) already returns.
export class Client extends TypedEventEmitter<ClientEvents> {
  private transport: WsTransport;
  private conversationsByChatId = new Map<number, Conversation>();
  private expiryTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(token: string) {
    super();
    this.transport = this.buildTransport(token);
    this.scheduleExpiryTimers(token);
  }

  private buildTransport(token: string): WsTransport {
    const transport = new WsTransport(token);
    transport.on("connectionStateChanged", (state) => this.emit("connectionStateChanged", state));
    transport.on("connected", (chatIds) => void this.hydrateConversations(chatIds));
    transport.on("chat.assigned", (chatId) => void this.joinConversation(chatId));
    transport.on("chat.finished", (chatId) => this.removeConversation(chatId));
    transport.on("message.new", (raw) => this.applyMessage(raw, "added"));
    transport.on("message.updated", (raw) => this.applyMessage(raw, "updated"));
    // No public "connectionError" surface in the real Client either — a serverError becomes a
    // console warning in v1 rather than a new, non-Twilio event nobody would be listening for.
    transport.on("serverError", (message) => {
      console.warn(`sbx-omnichannel-conversations: server error: ${message}`);
    });
    return transport;
  }

  private clearExpiryTimers(): void {
    for (const timer of this.expiryTimers) clearTimeout(timer);
    this.expiryTimers = [];
  }

  private scheduleExpiryTimers(token: string): void {
    this.clearExpiryTimers();
    const expiresAt = decodeJwtExpiry(token);
    if (expiresAt == null) return;
    const now = Date.now();
    const aboutToExpireDelay = expiresAt - TOKEN_ABOUT_TO_EXPIRE_MS - now;
    if (aboutToExpireDelay > 0) {
      this.expiryTimers.push(setTimeout(() => this.emit("tokenAboutToExpire"), aboutToExpireDelay));
    }
    const expiredDelay = Math.max(0, expiresAt - now);
    this.expiryTimers.push(setTimeout(() => this.emit("tokenExpired"), expiredDelay));
  }

  private async hydrateConversations(chatIds: number[]): Promise<void> {
    await Promise.all(chatIds.map((id) => this.joinConversation(id)));
  }

  private async joinConversation(chatId: number): Promise<void> {
    if (this.conversationsByChatId.has(chatId)) return;
    const chat = await RestApi.getChat(chatId);
    const conversation = new Conversation(chat, this.transport);
    conversation.on("updated", (payload) => this.emit("conversationUpdated", payload));
    this.conversationsByChatId.set(chatId, conversation);
    this.emit("conversationJoined", conversation);
  }

  private removeConversation(chatId: number): void {
    const conversation = this.conversationsByChatId.get(chatId);
    if (!conversation) return;
    this.conversationsByChatId.delete(chatId);
    conversation.status = "finish";
    this.emit("conversationRemoved", conversation);
  }

  private applyMessage(raw: RestChatMessage, reason: "added" | "updated"): void {
    const conversation = this.conversationsByChatId.get(raw.chat_id);
    if (!conversation) return; // a message for a chat we haven't joined yet — ignored, matches Twilio's own behavior
    const message = conversation.applyRealtimeMessage(raw, reason);
    if (reason === "added") this.emit("messageAdded", message);
    // Both real triggers for message.updated today (metadata edits, add_reaction) change what
    // surfaces under message.attributes — there's no body-edit or delivery-receipt backend path
    // yet (see the README's known limitations), so "attributes" is the only reason that can fire.
    else this.emit("messageUpdated", { message, updateReasons: ["attributes"] });
  }

  /**
   * Matches Twilio's own async, Paginator-shaped getSubscribedConversations() — the reference
   * frontend does `(await client.getSubscribedConversations()).items`. There's no real
   * server-side pagination over an agent's subscribed chats (the full set arrives in one
   * `connected` WS message), so this is a single-page Paginator wrapping the current cache.
   */
  async getSubscribedConversations(): Promise<Paginator<Conversation>> {
    const all = [...this.conversationsByChatId.values()];
    return new Paginator(all, 0, all.length || 1);
  }

  /**
   * Matches Twilio's own async getConversationBySid — fetches from the server (zavu's
   * `GET /chats/:id` resolves by numeric id, `conversation_sid`, OR `custom_id` in one query) when
   * the conversation isn't already cached, and throws if it truly doesn't exist, same as Twilio.
   */
  async getConversationBySid(sid: string): Promise<Conversation> {
    for (const conversation of this.conversationsByChatId.values()) {
      if (conversation.sid === sid) return conversation;
    }
    const chat = await RestApi.getChat(sid);
    const conversation = new Conversation(chat, this.transport);
    conversation.on("updated", (payload) => this.emit("conversationUpdated", payload));
    this.conversationsByChatId.set(chat.id, conversation);
    return conversation;
  }

  async updateToken(token: string): Promise<void> {
    this.transport.updateToken(token);
    this.scheduleExpiryTimers(token);
  }

  shutdown(): void {
    this.clearExpiryTimers();
    this.transport.shutdown();
    this.removeAllListeners();
  }
}
