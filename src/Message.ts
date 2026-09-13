import type { Conversation } from "./Conversation.js";
import { Media } from "./Media.js";
import type { RestChatMessage } from "./internal/restApi.js";

export interface MessageReaction {
  author: string;
  value: string;
  updated_at: string;
}

// Mirrors @twilio/conversations' own `Message`. `index` has no direct zavu equivalent (Twilio's
// own index is a per-conversation sequence starting at 0); the message's own database id is used
// instead — still a strictly-increasing number, which is all any real caller in the reference
// frontend actually relies on (ordering/comparison, never "starts at exactly 0").
export class Message {
  readonly sid: string;
  readonly index: number;
  readonly body: string | null;
  readonly author: string | null;
  readonly attributes: Record<string, unknown>;
  readonly dateCreated: Date;
  readonly dateUpdated: Date;
  readonly conversation: Conversation;
  readonly attachedMedia: Media[] | null;

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
    this.attributes = { ...rest, reactions: raw.reactions ?? [] };
    this.dateCreated = new Date(raw.created_at);
    this.dateUpdated = new Date(raw.updated_at);
    this.conversation = conversation;
    this.attachedMedia = raw.media
      ? [new Media({ chatId: raw.chat_id, messageId: raw.id, contentType: raw.media_type ?? "application/octet-stream" })]
      : null;
  }
}
