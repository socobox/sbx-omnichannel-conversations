import type { Conversation } from "./Conversation.js";
import { Media } from "./Media.js";
import { RestApi, type RestChatMessage } from "./internal/restApi.js";
import type { JSONValue } from "./types.js";

export interface MessageReaction {
  author: string;
  value: string;
  updated_at: string;
}

export const MessageType = {
  Text: "text",
  Media: "media",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// Mirrors @twilio/conversations' own `Message`. `index` has no direct zavu equivalent (Twilio's
// own index is a per-conversation sequence starting at 0); the message's own database id is used
// instead — still a strictly-increasing number, which is all any real caller in the reference
// frontend actually relies on (ordering/comparison, never "starts at exactly 0").
export class Message {
  readonly sid: string;
  readonly index: number;
  readonly body: string | null;
  readonly author: string | null;
  private readonly participantId: number | null;
  readonly attributes: JSONValue;
  readonly dateCreated: Date;
  readonly dateUpdated: Date;
  readonly conversation: Conversation;
  readonly attachedMedia: Media[] | null;
  readonly type: MessageType;
  /** @deprecated Use attachedMedia instead — matches Twilio's own deprecated single-media getter. */
  readonly media: Media | null;

  /** @internal */
  constructor(raw: RestChatMessage, conversation: Conversation) {
    this.sid = raw.sid ?? String(raw.id);
    this.index = raw.id;
    this.body = raw.body;
    this.author = conversation.participantIdentity(raw.participant_id) ?? null;
    this.participantId = raw.participant_id;
    // zavu's `toChatMessagePublic` (chat.repo.ts) wraps whatever is actually stored in
    // `chat_messages.metadata` one level deeper, under the metadata's own `custom_metadata` key —
    // a straight port of Rails' `ChatMessageSerializer#metadata`
    // (`object.metadata.merge(custom_metadata: object.metadata)`), confirmed identical against
    // sbx-omnichannel-api, INCLUDING that `custom_metadata` key itself staying nested inside
    // `attributes` on the wire (confirmed 2026-09-24 against Rails' own real payload — see
    // twilio_service.rb#L707/852 and the serializer — every `Attributes`/`metadata` blob Rails has
    // ever produced carries the same self-nested shape). sbx-omnichannel-ui reads through
    // `attributes.custom_metadata.<field>` in ~37 places (transcription, template, bot,
    // sbx_file_key, parent_message_sid, update_history, attachments) for exactly that reason.
    // `attributes` therefore passes the raw wire metadata straight through — no unwrapping, no
    // rebuilding a `custom_metadata` key from a different source — the wrapper is already there,
    // untouched, whatever a caller last wrote via `updateAttributes` (which shallow-merges into
    // the SAME stored object server-side, so its own `custom_metadata` key round-trips exactly
    // as sent). A prior version of this code unwrapped `custom_metadata` and re-attached only its
    // CONTENTS, which silently dropped the wrapper key itself — reported from sbx-omnichannel-ui
    // 2026-09-24 (`attributes.custom_metadata.transcription` etc. all reading undefined).
    const rawMetadata = (raw.metadata ?? {}) as Record<string, unknown>;
    // `attachments` (like `reactions`) is a raw sibling field on `raw`, not something a caller
    // writes via updateAttributes — stripped here so the TOP-LEVEL `attributes.attachments` never
    // leaks in as a stale duplicate merely because `toChatMessagePublic` wraps the WHOLE stored
    // metadata (attachments included) into `custom_metadata`. The NESTED
    // `attributes.custom_metadata.attachments` copy is left completely alone — that's real stored
    // data, not something this class computed, and sbx-omnichannel-ui reads it directly.
    const { attachments: _attachmentsAtTopLevel, ...cleanMetadata } = rawMetadata;
    this.attributes = { ...cleanMetadata, reactions: raw.reactions ?? [] } as unknown as JSONValue;
    this.dateCreated = new Date(raw.created_at);
    this.dateUpdated = new Date(raw.updated_at);
    this.conversation = conversation;
    // Multiple attachments (2026-09-22): `raw.attachments` (possibly several) takes priority over
    // the legacy singular `media`/`media_type` pair — but that pair still gets populated (the
    // FIRST attachment) by zavu on every send, so this is purely additive: a message from before
    // this feature existed (or a single-attachment send today) has an empty/absent `attachments`
    // and falls back to the one-Media-from-media/media_type shape unchanged.
    this.attachedMedia = raw.attachments?.length
      ? raw.attachments.map((a) => new Media({
          chatId: raw.chat_id,
          messageId: raw.id,
          contentType: a.content_type ?? "application/octet-stream",
          // `filename` is the current (2026-09-24) key; `name` only ever shows up on a message
          // stored before that fix (see RestAttachment's own comment) — never both at once.
          filename: a.filename ?? a.name ?? null,
          key: a.key,
          getToken: () => conversation.currentToken,
        }))
      : raw.media
        ? [
            new Media({
              chatId: raw.chat_id,
              messageId: raw.id,
              contentType: raw.media_type ?? "application/octet-stream",
              key: raw.media,
              getToken: () => conversation.currentToken,
            }),
          ]
        : null;
    this.type = this.attachedMedia?.length ? MessageType.Media : MessageType.Text;
    this.media = this.attachedMedia?.[0] ?? null;
  }

  /**
   * The display name of whoever sent this message, when the backend has one for that
   * participant (a HUMAN_AGENT — `author` alone only ever gives an opaque identity like
   * `"agent_62"`, never a name a UI could show directly). `null` for a customer/bot participant
   * (no name in that case, matching `author`'s own identity for those), or when the participant
   * is genuinely unknown.
   *
   * A GETTER, not a value captured at construction: if this message's participant wasn't part of
   * this Conversation's initial participant list (a report found this reading the code, not
   * reproduced live — a participant added after hydration, e.g. by a transfer, whose name a
   * still-open Conversation hadn't fetched yet), Conversation kicks off a best-effort background
   * refetch the first time that happens (see Conversation#applyRealtimeMessage). Reading
   * `authorName` again after that refetch resolves reflects the real name with no extra plumbing
   * needed here — this class never mutates its own fields after construction.
   */
  get authorName(): string | null {
    return this.conversation.participantName(this.participantId) ?? null;
  }

  /**
   * The `participant_type` (`"USER"`, `"HUMAN_AGENT"`, `"AI_AGENT"`, ...) of whoever sent this
   * message — e.g. to tell a bot's message apart from a human agent's without a separate
   * `getParticipants()` round trip and a manual cross-reference against `author`. Same GETTER
   * shape as `authorName` for the same reason: a participant this Conversation hadn't ingested yet
   * resolves in the background (see Conversation#applyRealtimeMessage), and reading this again
   * afterward reflects it with no extra plumbing. `undefined` (not `null`) when the participant is
   * genuinely still unknown — there is no real Rails/backend state that means "known participant,
   * no type", unlike `authorName`, so there's no third value to reserve `null` for.
   */
  get authorType(): string | undefined {
    return this.conversation.participantType(this.participantId);
  }

  /**
   * Persisted body edit — a genuinely new capability with no Rails precedent (see the README):
   * Twilio's own updateBody() was never durable, only ever live in Twilio's hosted conversation.
   * Only works for `client === 'web'` chats; the backend rejects (422) anything else, surfacing
   * here as a rejected Promise, same as any other REST failure.
   */
  async updateBody(body: string): Promise<Message> {
    // Register the WS-echo waiter BEFORE the REST write returns — otherwise a fast
    // `message.updated` can arrive in the gap and leave this promise pending forever (the same
    // class of hang report1.md hit on a body→attributes sequence when the second echo never
    // came; registering first also closes the early-echo race for a single write).
    const wait = this.conversation.beginMessageUpdate(this.index);
    try {
      await RestApi.updateMessage(this.conversation.currentToken, this.conversation.chatId, this.index, { body });
    } catch (error) {
      wait.cancel(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return wait.promise;
  }

  /** Matches Twilio's own updateAttributes — a wholesale merge server-side (see
   * web_chat.repo.ts#updateMessage's own comment: MERGES into existing metadata, not a replace). */
  async updateAttributes(attributes: JSONValue): Promise<Message> {
    const wait = this.conversation.beginMessageUpdate(this.index);
    try {
      await RestApi.updateMessage(this.conversation.currentToken, this.conversation.chatId, this.index, { metadata: attributes });
    } catch (error) {
      wait.cancel(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return wait.promise;
  }
}
