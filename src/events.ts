// Public event-name catalogs for Client and Conversation.
//
// The `ClientEvents`/`ConversationEvents` interfaces (Client.ts, Conversation.ts) deliberately
// keep literal string keys rather than computed keys off these catalogs:
// tests/contract.test.ts reads those interfaces as TEXT (see its interfaceKeys() helper) to
// freeze the exact event names sbx-omnichannel-ui depends on. A computed key there would make
// that guard stop parsing anything, silently disabling the check it exists for. These catalogs
// are for every OTHER call site — `.on(...)`, `.emit(...)`, etc.

export const ClientEvent = {
  ConnectionStateChanged: "connectionStateChanged",
  /** Twilio's own connectionError. Replaces a console.warn: a server-side problem used to be
   * invisible to the application. `terminal: true` means it will not be retried. */
  ConnectionError: "connectionError",
  /** Twilio's own Client lifecycle. `initialized` fires at most once per transition INTO
   * "initialized" — NOT on every reconnect, which is expressed by connectionStateChanged alone. */
  StateChanged: "stateChanged",
  Initialized: "initialized",
  InitFailed: "initFailed",
  TokenAboutToExpire: "tokenAboutToExpire",
  TokenExpired: "tokenExpired",
  ConversationJoined: "conversationJoined",
  ConversationLeft: "conversationLeft",
  ConversationRemoved: "conversationRemoved",
  ConversationUpdated: "conversationUpdated",
  MessageAdded: "messageAdded",
  MessageUpdated: "messageUpdated",
} as const;
export type ClientEvent = (typeof ClientEvent)[keyof typeof ClientEvent];

export const ConversationEvent = {
  Updated: "updated",
  MessageAdded: "messageAdded",
  MessageUpdated: "messageUpdated",
  /** New — zavu now broadcasts a `participant.updated` frame on transfer (see
   * Conversation.ts#applyRealtimeParticipant). Fires when a participant this Conversation hadn't
   * seen before appears with an active `sid` (a new or reactivated HUMAN_AGENT). */
  ParticipantJoined: "participantJoined",
  /** Fires when a KNOWN participant's `sid` clears to null (displaced by a transfer) — the closest
   * zavu equivalent to "left", since a participant row is never deleted, only deactivated. */
  ParticipantLeft: "participantLeft",
  /** Fires for any other change to a known participant (name, attributes) that isn't a join/leave. */
  ParticipantUpdated: "participantUpdated",
} as const;
export type ConversationEvent = (typeof ConversationEvent)[keyof typeof ConversationEvent];
