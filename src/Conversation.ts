import { TypedEventEmitter } from "./EventEmitter.js";
import { ConversationEvent } from "./events.js";
import { Message } from "./Message.js";
import { MessageBuilder } from "./MessageBuilder.js";
import { Participant } from "./Participant.js";
import { Paginator } from "./Paginator.js";
import { RestApi, type RestChat, type RestChatMessage, type RestParticipant } from "./internal/restApi.js";
import { ConversationUpdateReason, MessageUpdateReason, type JSONValue, type SendMessageBody } from "./types.js";
import type { WsTransport } from "./internal/wsTransport.js";

// Keys stay as string literals, not computed keys off ConversationEvent (src/events.ts), on
// purpose — tests/contract.test.ts parses this interface as TEXT to freeze the exact event names
// sbx-omnichannel-ui depends on; a computed key would make that guard stop parsing anything.
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

  /** @internal — the same per-session token authenticating this conversation's WS connection,
   * reused for its REST calls (see internal/restApi.ts). Read lazily, never captured, since it
   * can rotate underneath this Conversation via Client#updateToken. */
  get currentToken(): string {
    return this.transport.currentToken;
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
      this.emit(ConversationEvent.MessageAdded, message);
    } else {
      // Diffed against the PREVIOUSLY cached copy — both a body edit and an attributes/reaction
      // change arrive as the same wire event (message.updated), so this is the only way to tell
      // a caller which one actually happened, matching Twilio's own updateReasons contract.
      if (previous && previous.body !== message.body) messageUpdateReasons.push(MessageUpdateReason.Body);
      if (previous && JSON.stringify(previous.attributes) !== JSON.stringify(message.attributes)) messageUpdateReasons.push(MessageUpdateReason.Attributes);
      if (messageUpdateReasons.length === 0) messageUpdateReasons = [MessageUpdateReason.Attributes];

      const resolvers = this.pendingMessageUpdates.get(message.index);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve(message);
        this.pendingMessageUpdates.delete(message.index);
      }
      this.emit(ConversationEvent.MessageUpdated, { message, updateReasons: messageUpdateReasons });
    }
    this.emit(ConversationEvent.Updated, { conversation: this, updateReasons: [ConversationUpdateReason.LastMessage] });
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

  /**
   * @internal — re-applies an authoritative `GET /chats/:id` snapshot onto THIS instance instead
   * of building a new Conversation, so every reference the consumer already holds stays valid:
   * its React state, its `currentConversationSid` lookups, and the listeners it registered on
   * this object. Replacing the instance instead would leave the open conversation pointing at an
   * object nothing updates any more.
   *
   * Used on reconnect. While the socket was down no message.new was delivered, so messages,
   * participants, status and metadata may all have moved on without a single event arriving.
   */
  refreshFromRest(raw: RestChat): void {
    const updateReasons: ConversationUpdateReason[] = [];

    const nextAttributes = (raw.metadata ?? {}) as JSONValue;
    if (JSON.stringify(this.attributes) !== JSON.stringify(nextAttributes)) {
      this.attributes = nextAttributes;
      updateReasons.push(ConversationUpdateReason.Attributes);
    }
    if (this.status !== raw.status) {
      this.status = raw.status;
      updateReasons.push(ConversationUpdateReason.Status);
    }

    this.ingestParticipants(raw.participants ?? []);

    if (raw.chat_messages?.length) {
      const previousLastRead = this.lastReadMessageIndex;
      const previousLastIndex = this.lastMessage?.index ?? null;
      const knownIndexes = new Set((this.cachedMessages ?? []).map((m) => m.index));
      this.setMessagesFromRest(raw.chat_messages);
      // setMessagesFromRest marks everything read, which is right for a FIRST hydration and
      // wrong for a refresh: it would silently clear the unread state for every message that
      // landed while the socket was down. Read state is in-memory only, so the pre-refresh
      // value is the only truth there is.
      this.lastReadMessageIndex = previousLastRead;
      if (this.lastMessage && this.lastMessage.index !== previousLastIndex) {
        updateReasons.push(ConversationUpdateReason.LastMessage);
      }

      // Recovering the messages into the cache is only half the job. A consumer that renders an
      // open chat reads the history once and then appends from `messageAdded` — nothing re-reads
      // the cache — so without these the recovered messages sit in memory and never reach the
      // screen. Emitting them makes a reconnect look like what it is: those messages arriving.
      //
      // Deliberately ONLY the per-conversation event, never Client's aggregated one. Client's
      // feed is what drives notifications, and replaying it after a five-minute outage would
      // fire a toast per recovered message. Unread badges have an exact source now —
      // getUnreadMessagesCount() — and do not need to be rebuilt from a replayed stream.
      for (const message of this.cachedMessages ?? []) {
        if (!knownIndexes.has(message.index)) this.emit(ConversationEvent.MessageAdded, message);
      }
    }

    if (updateReasons.length) this.emit(ConversationEvent.Updated, { conversation: this, updateReasons });
  }

  /** @internal */
  applyAttributesUpdate(attributes: JSONValue): void {
    this.attributes = attributes;
    this.emit(ConversationEvent.Updated, { conversation: this, updateReasons: [ConversationUpdateReason.Attributes] });
  }

  private async ensureMessagesLoaded(): Promise<Message[]> {
    if (this.cachedMessages) return this.cachedMessages;
    const chat = await RestApi.getChat(this.currentToken, this.chatId);
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
    const chat = await RestApi.getChat(this.currentToken, this.chatId);
    this.ingestParticipants(chat.participants ?? []);
    return (chat.participants ?? []).map((p) => new Participant(p));
  }

  /**
   * Twilio's contract: `null` means "I genuinely don't know", a number is an exact count.
   *
   * Until 0.3.0 this always returned `null`, on the grounds that nothing persists reads
   * server-side. That is still true across reloads (see the class-level `lastReadMessageIndex`
   * comment), but it conflated "not persisted" with "unknowable": for the lifetime of this
   * object the cached history plus the last index marked read IS an exact answer.
   *
   * Returning it matters because the alternative a caller is left with — subtracting
   * `lastMessage.index - lastReadMessageIndex` — does NOT count messages. Those are database
   * row ids shared across every chat in the tenant (see Message#index), so the difference
   * between two of them is an arbitrary number, not a quantity of messages. It only ever looked
   * correct because both sides happened to be equal, making it zero.
   *
   * Still `null` when no history has been loaded yet: that really is unknown.
   */
  async getUnreadMessagesCount(): Promise<number | null> {
    const messages = this.cachedMessages;
    if (!messages) return null;
    const lastRead = this.lastReadMessageIndex;
    if (lastRead == null) return messages.length;
    return messages.filter((message) => message.index > lastRead).length;
  }

  /**
   * In-memory only — see the class-level `lastReadMessageIndex` comment. Matches Twilio's own
   * return contract (the resulting unread count) even though nothing is persisted.
   *
   * Emits `updated` with a `lastReadMessageIndex` reason, which is how Twilio tells a UI to
   * clear its unread badge. Before 0.3.0 nothing was emitted here at all, so a consumer that
   * had written that handler (sbx-omnichannel-ui has one) could never see it fire, and its
   * badge kept whatever count it had until the next full page load.
   */
  async setAllMessagesRead(): Promise<number> {
    if (this.lastMessage) this.lastReadMessageIndex = this.lastMessage.index;
    this.emitReadStateChanged();
    return 0;
  }

  /** In-memory only — see the class-level `lastReadMessageIndex` comment. */
  async setAllMessagesUnread(): Promise<number> {
    this.lastReadMessageIndex = -1;
    this.emitReadStateChanged();
    return (await this.getUnreadMessagesCount()) ?? 0;
  }

  private emitReadStateChanged(): void {
    this.emit(ConversationEvent.Updated, {
      conversation: this,
      updateReasons: [ConversationUpdateReason.LastReadMessageIndex],
    });
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
      // El id del participante propio deja que el transporte reconozca SU eco: dos lados de un
      // chat mandan el mismo texto corto ("ok", "gracias") a la vez con toda normalidad.
      return await this.transport.sendMessage(this.chatId, body, this.resolveOwnParticipantId());
    }
    const participantId = this.resolveOwnParticipantId();
    if (participantId == null) {
      throw new Error("sbx-omnichannel-conversations: no participant record for this agent in this chat — cannot send media");
    }
    const created = await RestApi.sendMedia(this.currentToken, this.chatId, participantId, body.media, body.filename, body.contentType, undefined);
    return created.id;
  }
}
