// Mirrors @twilio/conversations' own public type names exactly, so a consumer migrating off
// Twilio can keep the same TypeScript annotations in most call sites.

export type ConnectionState = "connecting" | "connected" | "disconnecting" | "disconnected" | "denied";

export type ConversationUpdateReason =
  | "attributes"
  | "dateCreated"
  | "dateUpdated"
  | "friendlyName"
  | "lastReadMessageIndex"
  | "lastMessage"
  | "state"
  | "status";

export interface SendMediaOptions {
  contentType: string;
  media: Blob;
  filename?: string;
}

export type SendMessageBody = string | SendMediaOptions;
