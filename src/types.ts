// Mirrors @twilio/conversations' own public type names exactly, so a consumer migrating off
// Twilio can keep the same TypeScript annotations in most call sites.

export const ConnectionState = {
  Connecting: "connecting",
  Connected: "connected",
  Disconnecting: "disconnecting",
  Disconnected: "disconnected",
  Denied: "denied",
} as const;
export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

/**
 * Mirrors @twilio/conversations' own `State` — the lifecycle of the Client OBJECT, which is a
 * different thing from ConnectionState (the lifecycle of its socket). A Client initializes
 * exactly once; every reconnection after that is reported through ConnectionState alone.
 *
 * Named ClientState, not State, on purpose: `State` is a common enough name that a consumer is
 * likely to already have one (sbx-omnichannel-ui does), and colliding on the import costs the
 * caller an alias for no benefit.
 */
export const ClientState = {
  Initialized: "initialized",
  Failed: "failed",
} as const;
export type ClientState = (typeof ClientState)[keyof typeof ClientState];

export const ConversationUpdateReason = {
  Attributes: "attributes",
  DateCreated: "dateCreated",
  DateUpdated: "dateUpdated",
  FriendlyName: "friendlyName",
  LastReadMessageIndex: "lastReadMessageIndex",
  LastMessage: "lastMessage",
  State: "state",
  Status: "status",
} as const;
export type ConversationUpdateReason = (typeof ConversationUpdateReason)[keyof typeof ConversationUpdateReason];

export const MessageUpdateReason = {
  Body: "body",
  Attributes: "attributes",
  DateUpdated: "dateUpdated",
  DeliveryReceipt: "deliveryReceipt",
} as const;
export type MessageUpdateReason = (typeof MessageUpdateReason)[keyof typeof MessageUpdateReason];

/** Mirrors @twilio/conversations' own `Participant.UpdateReason`, narrowed to what zavu's
 * `participant.updated` frame can actually distinguish (see Conversation.ts#applyRealtimeParticipant):
 * `attributes` covers a plain metadata change, `name` a display-name change (a HUMAN_AGENT's own
 * `agents.name` edited elsewhere). A sid transition (join/leave) is never reported as an "update" —
 * that's participantJoined/participantLeft instead, matching Twilio's own event split. */
export const ParticipantUpdateReason = {
  Attributes: "attributes",
  Name: "name",
} as const;
export type ParticipantUpdateReason = (typeof ParticipantUpdateReason)[keyof typeof ParticipantUpdateReason];

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
