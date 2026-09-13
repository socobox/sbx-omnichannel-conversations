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

export type MessageUpdateReason = "body" | "attributes" | "dateUpdated" | "deliveryReceipt";

// Matches @twilio/conversations' own JSONValue exactly (its Message/Conversation `attributes`
// getters, and every attributes-accepting method, are typed against this, not a plain
// Record<string, unknown> — some call sites in a migrated frontend pass this type through
// without a cast, so the shape has to line up exactly, not just be "close enough").
export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
export interface JSONObject {
  [x: string]: JSONValue;
}
export type JSONArray = JSONValue[];

export interface SendMediaOptions {
  contentType: string | null;
  media: Blob;
  filename?: string;
}

export type SendMessageBody = string | SendMediaOptions;
