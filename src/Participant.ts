import type { RestParticipant } from "./internal/restApi.js";

// Mirrors @twilio/conversations' own `Participant` — the frontend only ever reads a handful of
// fields off this (identity/attributes, for display), never mutates it directly.
export class Participant {
  readonly sid: string;
  readonly identity: string | null;
  readonly attributes: Record<string, unknown>;
  readonly type: string;

  /** @internal */
  constructor(raw: RestParticipant) {
    this.sid = raw.sid ?? raw.conversation_sid ?? String(raw.id);
    this.identity = raw.indentify;
    this.attributes = raw.metadata ?? {};
    this.type = raw.participant_type;
  }
}
