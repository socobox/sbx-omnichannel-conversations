import type { Conversation } from "./Conversation.js";
import { Media } from "./Media.js";
import { RestApi, type RestChatMessage } from "./internal/restApi.js";
import type { JSONValue } from "./types.js";

export interface MessageReaction {
  author: string;
  value: string;
  updated_at: string;
}

export type MessageType = "text" | "media";

// Mirrors @twilio/conversations' own `Message`. `index` has no direct zavu equivalent (Twilio's
// own index is a per-conversation sequence starting at 0); the message's own database id is used
// instead — still a strictly-increasing number, which is all any real caller in the reference
// frontend actually relies on (ordering/comparison, never "starts at exactly 0").
export class Message {
  readonly sid: string;
  readonly index: number;
  readonly body: string | null;
  readonly author: string | null;
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
    // zavu's own `metadata` already carries a redundant `custom_metadata` copy of itself (a
    // Rails-serializer artifact, see restApi.ts's RestChatMessage comment) — dropped here so
    // `message.attributes` isn't cluttered with a duplicate. `reactions` arrives as a sibling
    // field on the raw row, surfaced at the top level of `attributes` to match what a component
    // reading `message.attributes.reactions` expects.
    const { custom_metadata, ...rest } = raw.metadata ?? {};
    this.attributes = { ...rest, reactions: raw.reactions ?? [] } as unknown as JSONValue;
    this.dateCreated = new Date(raw.created_at);
    this.dateUpdated = new Date(raw.updated_at);
    this.conversation = conversation;
    this.attachedMedia = raw.media
      ? [new Media({ chatId: raw.chat_id, messageId: raw.id, contentType: raw.media_type ?? "application/octet-stream" })]
      : null;
    this.type = this.attachedMedia?.length ? "media" : "text";
    this.media = this.attachedMedia?.[0] ?? null;
  }

  /**
   * Persisted body edit — a genuinely new capability with no Rails precedent (see the README):
   * Twilio's own updateBody() was never durable, only ever live in Twilio's hosted conversation.
   * Only works for `client === 'web'` chats; the backend rejects (422) anything else, surfacing
   * here as a rejected Promise, same as any other REST failure.
   */
  async updateBody(body: string): Promise<Message> {
    await RestApi.updateMessage(this.conversation.chatId, this.index, { body });
    return this.conversation.awaitMessageUpdate(this.index);
  }

  /** Matches Twilio's own updateAttributes — a wholesale merge server-side (see
   * web_chat.repo.ts#updateMessage's own comment: MERGES into existing metadata, not a replace). */
  async updateAttributes(attributes: JSONValue): Promise<Message> {
    await RestApi.updateMessage(this.conversation.chatId, this.index, { metadata: attributes });
    return this.conversation.awaitMessageUpdate(this.index);
  }
}
