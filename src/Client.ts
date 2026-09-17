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

/** Decodes a JWT's payload without pulling in a JWT library — the same trick
 * @twilio/conversations itself uses internally to drive tokenAboutToExpire/tokenExpired. zavu's
 * own agent WS token payload (see chatToken.service.ts's AgentTokenPayload) is plain, readable
 * JSON once base64-decoded — no need to verify the signature client-side, this is just reading
 * claims already trusted (the token came from our own backend). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")));
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
  // Twilio's Client derives "who am I" from the grants baked into its own access token; this is
  // the equivalent for zavu's agent token (see chatToken.service.ts's AgentTokenPayload) — needed
  // so Conversation can resolve which participant row is "this agent" for the media-send path,
  // with zero new parameters at any frontend call site.
  private agentId: number | null = null;
  // A 'chat'-scope (customer) token carries its own participant_id claim directly (unambiguous —
  // that token is scoped to exactly one chat) — used the same way agentId is, to resolve "who am
  // I" for setAllMessagesRead/setAllMessagesUnread on the CUSTOMER side (the agent side resolves
  // via agentId + Conversation's own per-chat participant map instead, since one agent token is
  // reused across many chats).
  private ownParticipantId: number | null = null;

  constructor(token: string) {
    super();
    this.agentId = this.decodeAgentId(token);
    this.ownParticipantId = this.decodeParticipantId(token);
    this.transport = this.buildTransport(token);
    this.scheduleExpiryTimers(token);
  }

  private decodeAgentId(token: string): number | null {
    const payload = decodeJwtPayload(token);
    return typeof payload?.agent_id === "number" ? payload.agent_id : null;
  }

  private decodeParticipantId(token: string): number | null {
    const payload = decodeJwtPayload(token);
    return typeof payload?.participant_id === "number" ? payload.participant_id : null;
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
    const payload = decodeJwtPayload(token);
    const expiresAt = typeof payload?.exp === "number" ? payload.exp * 1000 : null;
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
    const chat = await RestApi.getChat(this.transport.currentToken, chatId);
    const conversation = new Conversation(chat, this.transport, this.agentId, this.ownParticipantId);
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
    if (reason === "added") {
      this.emit("messageAdded", conversation.applyRealtimeMessage(raw, reason).message);
    } else {
      const { message, updateReasons } = conversation.applyRealtimeMessage(raw, reason);
      this.emit("messageUpdated", { message, updateReasons });
    }
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
    const chat = await RestApi.getChat(this.transport.currentToken, sid);
    const conversation = new Conversation(chat, this.transport, this.agentId, this.ownParticipantId);
    conversation.on("updated", (payload) => this.emit("conversationUpdated", payload));
    this.conversationsByChatId.set(chat.id, conversation);
    return conversation;
  }

  async updateToken(token: string): Promise<void> {
    this.agentId = this.decodeAgentId(token);
    this.ownParticipantId = this.decodeParticipantId(token);
    this.transport.updateToken(token);
    this.scheduleExpiryTimers(token);
  }

  shutdown(): void {
    this.clearExpiryTimers();
    this.transport.shutdown();
    this.removeAllListeners();
  }
}
