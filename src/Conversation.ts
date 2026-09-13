import { TypedEventEmitter } from "./EventEmitter.js";
import { Message } from "./Message.js";
import { MessageBuilder } from "./MessageBuilder.js";
import { Participant } from "./Participant.js";
import { Paginator } from "./Paginator.js";
import { RestApi, type RestChat, type RestChatMessage, type RestParticipant } from "./internal/restApi.js";
import type { ConversationUpdateReason, JSONValue, MessageUpdateReason, SendMessageBody } from "./types.js";
import type { WsTransport } from "./internal/wsTransport.js";

interface ConversationEvents {
  updated: [{ conversation: Conversation; updateReasons: ConversationUpdateReason[] }];
  // Mirrors Twilio's own per-conversation messageAdded/messageUpdated — real, actively-used call
  // sites (ChatBodyMessagesComponent.tsx) listen on the CURRENTLY OPEN conversation directly,
  // not just on Client's aggregated feed. Same payload shape as Client's own events.
  messageAdded: [Message];
  messageUpdated: [{ message: Message; updateReasons: MessageUpdateReason[] }];
}

// Mirrors @twilio/conversations' own `Conversation` — one chat. `sid` is zavu's own
// `conversation_sid` column (already a per-chat unique string identifier, serving the exact same
// role Twilio's Conversation SID did). `attributes` is `chats.metadata` directly — the same
// arbitrary-bag-of-custom-fields role Twilio's own conversation attributes played (this is how
// `due_time`, `phone`, `name`, etc. already travel).
export class Conversation extends TypedEventEmitter<ConversationEvents> {
  readonly sid: string;
  readonly friendlyName: string | null;
  readonly dateCreated: Date;
  readonly dateUpdated: Date;
  attributes: JSONValue;
  status: string;
  lastMessage: { index: number; dateCreated: Date } | null = null;
  /**
   * No persisted read-tracking exists on the backend yet (a real, documented gap — see the
   * README). Defaults to "fully read" (the safer failure mode: no spurious unread badges) and
   * only ever changes for the lifetime of this in-memory object via `setAllMessagesRead()`.
   */
  lastReadMessageIndex: number | null = null;

  /** @internal */
  readonly chatId: number;
  private readonly transport: WsTransport;
  // Twilio's Client derives "who am I" from its own access token's grants; zavu's agent WS token
  // carries `agent_id` the same way (decoded once, in Client). Needed ONLY to resolve which
  // participant row is "this agent" for the media-send path — see sendMessage() below.
  private readonly agentId: number | null;
  private cachedMessages: Message[] | null = null;
  private participantIdentities = new Map<number, string>();
  private participantIdByAgentId = new Map<number, number>();
  private pendingMessageUpdates = new Map<number, Array<(message: Message) => void>>();

  /** @internal */
  constructor(raw: RestChat, transport: WsTransport, agentId: number | null = null) {
    super();
    this.chatId = raw.id;
    this.sid = raw.conversation_sid ?? String(raw.id);
    this.friendlyName = raw.name;
    this.dateCreated = new Date(raw.created_at);
    this.dateUpdated = new Date(raw.updated_at);
    this.attributes = (raw.metadata ?? {}) as JSONValue;
    this.status = raw.status;
    this.transport = transport;
    this.agentId = agentId;
    this.ingestParticipants(raw.participants ?? []);
    if (raw.chat_messages?.length) {
      this.setMessagesFromRest(raw.chat_messages);
    }
  }

  /** @internal — used by Message to resolve `author` without a network round trip. */
  participantIdentity(participantId: number | null): string | undefined {
    return participantId == null ? undefined : this.participantIdentities.get(participantId);
  }

  private ingestParticipants(participants: RestParticipant[]): void {
    for (const p of participants) {
      if (p.id == null) continue;
      this.participantIdentities.set(p.id, p.indentify ?? `agent_${p.agent_id ?? p.id}`);
      if (p.agent_id != null) this.participantIdByAgentId.set(p.agent_id, p.id);
    }
  }

  /** @internal — used by sendMessage's media branch to resolve "which participant is me". */
  private resolveOwnParticipantId(): number | null {
    if (this.agentId == null) return null;
    return this.participantIdByAgentId.get(this.agentId) ?? null;
  }

  private setMessagesFromRest(raw: RestChatMessage[]): void {
    this.cachedMessages = raw.map((m) => new Message(m, this));
    const last = this.cachedMessages[this.cachedMessages.length - 1];
    if (last) {
      this.lastMessage = { index: last.index, dateCreated: last.dateCreated };
      this.lastReadMessageIndex = last.index;
    }
  }

  /** @internal — called by Client when a fresh message.new/message.updated arrives over WS. */
  applyRealtimeMessage(raw: RestChatMessage, reason: "added" | "updated"): { message: Message; updateReasons: MessageUpdateReason[] } {
    if (raw.participant_id != null && !this.participantIdentities.has(raw.participant_id)) {
      // A participant we haven't seen yet (e.g. a bot/agent added after this Conversation was
      // first hydrated) — best-effort identity fallback; a full re-fetch isn't worth it just to
      // resolve one display name.
      this.participantIdentities.set(raw.participant_id, `participant_${raw.participant_id}`);
    }
    const previous = this.cachedMessages?.find((m) => m.index === raw.id) ?? null;
    const message = new Message(raw, this);
    if (!this.cachedMessages) this.cachedMessages = [];
    const idx = this.cachedMessages.findIndex((m) => m.index === message.index);
    if (idx >= 0) this.cachedMessages[idx] = message;
    else this.cachedMessages.push(message);

    let messageUpdateReasons: MessageUpdateReason[] = [];
    if (reason === "added") {
      this.lastMessage = { index: message.index, dateCreated: message.dateCreated };
      this.emit("messageAdded", message);
    } else {
      // Diffed against the PREVIOUSLY cached copy — both a body edit and an attributes/reaction
      // change arrive as the same wire event (message.updated), so this is the only way to tell
      // a caller which one actually happened, matching Twilio's own updateReasons contract.
      if (previous && previous.body !== message.body) messageUpdateReasons.push("body");
      if (previous && JSON.stringify(previous.attributes) !== JSON.stringify(message.attributes)) messageUpdateReasons.push("attributes");
      if (messageUpdateReasons.length === 0) messageUpdateReasons = ["attributes"];

      const resolvers = this.pendingMessageUpdates.get(message.index);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve(message);
        this.pendingMessageUpdates.delete(message.index);
      }
      this.emit("messageUpdated", { message, updateReasons: messageUpdateReasons });
    }
    this.emit("updated", { conversation: this, updateReasons: ["lastMessage"] });
    return { message, updateReasons: messageUpdateReasons };
  }

  /** @internal — used by Message#updateBody/updateAttributes to resolve once the corresponding
   * message.updated echo round-trips back over the socket (there's no synchronous ack, same
   * reasoning as Conversation#sendMessage's own pendingSends). */
  awaitMessageUpdate(index: number): Promise<Message> {
    return new Promise((resolve) => {
      const list = this.pendingMessageUpdates.get(index) ?? [];
      list.push(resolve);
      this.pendingMessageUpdates.set(index, list);
    });
  }

  /** @internal */
  applyAttributesUpdate(attributes: JSONValue): void {
    this.attributes = attributes;
    this.emit("updated", { conversation: this, updateReasons: ["attributes"] });
  }

  private async ensureMessagesLoaded(): Promise<Message[]> {
    if (this.cachedMessages) return this.cachedMessages;
    const chat = await RestApi.getChat(this.chatId);
    this.ingestParticipants(chat.participants ?? []);
    this.setMessagesFromRest(chat.chat_messages ?? []);
    return this.cachedMessages ?? [];
  }

  /**
   * Matches Twilio's own default direction: the `pageSize` MOST RECENT messages, with
   * `hasPrevPage` telling the caller whether older history exists to page back into.
   */
  async getMessages(pageSize = 30): Promise<Paginator<Message>> {
    const all = await this.ensureMessagesLoaded();
    const start = Math.max(0, all.length - pageSize);
    return new Paginator(all, start, pageSize);
  }

  async getParticipants(): Promise<Participant[]> {
    const chat = await RestApi.getChat(this.chatId);
    this.ingestParticipants(chat.participants ?? []);
    return (chat.participants ?? []).map((p) => new Participant(p));
  }

  /**
   * No backend read-tracking exists yet (see the class-level `lastReadMessageIndex` comment) —
   * always resolves `null`, the same "I don't know, compute it yourself" signal Twilio's own SDK
   * can return, which `sbx-omnichannel-ui`'s ChatContext already falls back on
   * (`lastMessageIndex - lastReadIndex`) for exactly this case.
   */
  async getUnreadMessagesCount(): Promise<number | null> {
    return null;
  }

  /** In-memory only — see the class-level `lastReadMessageIndex` comment. Matches Twilio's own
   * return contract (resulting unread count) even though nothing is actually persisted. */
  async setAllMessagesRead(): Promise<number> {
    if (this.lastMessage) this.lastReadMessageIndex = this.lastMessage.index;
    return 0;
  }

  /** In-memory only — see the class-level `lastReadMessageIndex` comment. */
  async setAllMessagesUnread(): Promise<number> {
    this.lastReadMessageIndex = -1;
    return this.lastMessage ? this.lastMessage.index + 1 : 0;
  }

  /** Matches Twilio's own MessageBuilder entry point — see MessageBuilder's own comment for
   * exactly which subset of the real builder API is implemented. */
  prepareMessage(): MessageBuilder {
    return new MessageBuilder(this);
  }

  /**
   * Text: unchanged, resolves once the message.new echo round-trips over the socket (see
   * WsTransport#sendMessage). Media: proxied through zavu's own `POST /web_chats/:id/messages`
   * (see the README) — resolves immediately from that REST response, no need to wait for the WS
   * echo since the endpoint already returns the created message. Requires this agent to have a
   * participant record in this chat already (the same requirement the WS text-send path enforces
   * server-side); `attributes` on a media send isn't persisted yet — a narrow, documented v1 gap
   * (recordMessage's shared insert path doesn't accept custom metadata at creation time today).
   */
  async sendMessage(body: SendMessageBody, attributes?: JSONValue): Promise<number> {
    if (typeof body === "string") {
      void attributes;
      return await this.transport.sendMessage(this.chatId, body);
    }
    const participantId = this.resolveOwnParticipantId();
    if (participantId == null) {
      throw new Error("sbx-omnichannel-conversations: no participant record for this agent in this chat — cannot send media");
    }
    const created = await RestApi.sendMedia(this.chatId, participantId, body.media, body.filename, body.contentType, undefined);
    return created.id;
  }
}
