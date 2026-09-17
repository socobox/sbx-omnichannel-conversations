// Internal wire-protocol identifiers for zavu's own /ws/chat socket (see wsTransport.ts).
// NOT exported from index.ts — nothing outside this package interprets the raw wire format;
// Client re-shapes everything into Twilio's own public event surface (src/events.ts).

/** The `type` discriminant of every frame the server sends down the socket. */
export const ServerFrameType = {
  Connected: "connected",
  MessageNew: "message.new",
  MessageUpdated: "message.updated",
  ChatFinished: "chat.finished",
  ChatAssigned: "chat.assigned",
  Error: "error",
} as const;
export type ServerFrameType = (typeof ServerFrameType)[keyof typeof ServerFrameType];

/** The `type` discriminant of a frame this package sends up the socket. */
export const ClientFrameType = {
  MessageSend: "message.send",
} as const;
export type ClientFrameType = (typeof ClientFrameType)[keyof typeof ClientFrameType];

/** WsTransport's own internal event names (its `WsTransportEvents` interface) — distinct from
 * both the wire frame types above and the public Client/Conversation events in src/events.ts. */
export const TransportEvent = {
  ConnectionStateChanged: "connectionStateChanged",
  Connected: "connected",
  MessageNew: "message.new",
  MessageUpdated: "message.updated",
  ChatFinished: "chat.finished",
  ChatAssigned: "chat.assigned",
  ServerError: "serverError",
} as const;
export type TransportEvent = (typeof TransportEvent)[keyof typeof TransportEvent];
