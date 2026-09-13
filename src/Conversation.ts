import { TypedEventEmitter } from "./EventEmitter.js";
import { Message } from "./Message.js";
import { Participant } from "./Participant.js";
import { Paginator } from "./Paginator.js";
import { RestApi, type RestChat, type RestChatMessage, type RestParticipant } from "./internal/restApi.js";
import type { ConversationUpdateReason, SendMessageBody } from "./types.js";
import type { WsTransport } from "./internal/wsTransport.js";

interface ConversationEvents {
  updated: [{ conversation: Conversation; updateReasons: ConversationUpdateReason[] }];
}

// Mirrors @twilio/conversations' own `Conversation` — one chat. `sid` is zavu's own
// `conversation_sid` column (already a per-chat unique string identifier, serving the exact same
// role Twilio's Conversation SID did). `attributes` is `chats.metadata` directly — the same
// arbitrary-bag-of-custom-fields role Twilio's own conversation attributes played (this is how
// `due_time`, `phone`, `name`, etc. already travel).
export class Conversation extends TypedEventEmitter<ConversationEvents> {
  readonly sid: string;
  readonly friendlyName: string | null;
  attributes: Record<string, unknown>;
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
  private cachedMessages: Message[] | null = null;
  private participantIdentities = new Map<number, string>();

  /** @internal */
  constructor(raw: RestChat, transport: WsTransport) {
    super();
    this.chatId = raw.id;
    this.sid = raw.conversation_sid ?? String(raw.id);
    this.friendlyName = raw.name;
    this.attributes = raw.metadata ?? {};
    this.status = raw.status;
    this.transport = transport;
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
      if (p.id != null) this.participantIdentities.set(p.id, p.indentify ?? `agent_${p.agent_id ?? p.id}`);
    }
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
  applyRealtimeMessage(raw: RestChatMessage, reason: "added" | "updated"): Message {
    if (raw.participant_id != null && !this.participantIdentities.has(raw.participant_id)) {
      // A participant we haven't seen yet (e.g. a bot/agent added after this Conversation was
      // first hydrated) — best-effort identity fallback; a full re-fetch isn't worth it just to
      // resolve one display name.
      this.participantIdentities.set(raw.participant_id, `participant_${raw.participant_id}`);
    }
    const message = new Message(raw, this);
    if (!this.cachedMessages) this.cachedMessages = [];
    const idx = this.cachedMessages.findIndex((m) => m.index === message.index);
    if (idx >= 0) this.cachedMessages[idx] = message;
    else this.cachedMessages.push(message);

    if (reason === "added") {
      this.lastMessage = { index: message.index, dateCreated: message.dateCreated };
      this.emit("updated", { conversation: this, updateReasons: ["lastMessage"] });
    } else {
      this.emit("updated", { conversation: this, updateReasons: ["lastMessage"] });
    }
    return message;
  }

  /** @internal */
  applyAttributesUpdate(attributes: Record<string, unknown>): void {
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

  /** In-memory only — see the class-level `lastReadMessageIndex` comment. */
  async setAllMessagesRead(): Promise<void> {
    if (this.lastMessage) this.lastReadMessageIndex = this.lastMessage.index;
  }

  async sendMessage(body: SendMessageBody, attributes?: Record<string, unknown>): Promise<number> {
    if (typeof body !== "string") {
      throw new Error(
        "sbx-omnichannel-conversations: sending a file/media attachment from the agent side isn't wired to a backend endpoint yet — " +
          "see the README's \"Known limitations\" section. Plain-text sendMessage(body) works today.",
      );
    }
    void attributes; // no per-message custom-attributes write path exists server-side yet either
    return await this.transport.sendMessage(this.chatId, body);
  }
}
