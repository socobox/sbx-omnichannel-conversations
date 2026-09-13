import type { RestParticipant } from "./internal/restApi.js";
import type { JSONValue } from "./types.js";

// Mirrors @twilio/conversations' own `Participant` — the frontend only ever reads a handful of
// fields off this (identity/attributes, for display), never mutates it directly.
export class Participant {
  readonly sid: string;
  readonly identity: string | null;
  readonly attributes: JSONValue;
  readonly type: string;
  /**
   * Twilio's own `bindings` is channel-specific (only `email` is even typed) and every real call
   * site in the reference frontend already reads it through an `as any` cast — this exposes the
   * participant's raw metadata as a best-effort stand-in, not a faithful per-channel shape.
   */
  readonly bindings: JSONValue;

  /** @internal */
  constructor(raw: RestParticipant) {
    this.sid = raw.sid ?? raw.conversation_sid ?? String(raw.id);
    this.identity = raw.indentify;
    this.attributes = (raw.metadata ?? {}) as JSONValue;
    this.type = raw.participant_type;
    this.bindings = (raw.metadata ?? {}) as JSONValue;
  }
}
