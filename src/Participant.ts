import type { RestParticipant } from "./internal/restApi.js";
import type { JSONValue } from "./types.js";

// Mirrors @twilio/conversations' own `Participant` — the frontend only ever reads a handful of
// fields off this (identity/attributes, for display), never mutates it directly.
export class Participant {
  readonly sid: string;
  readonly identity: string | null;
  /**
   * Report (sbx-omnichannel-ui, 2026-09-21): a caller displaying who a message is from had
   * nothing but `identity` (`"agent_62"`) to show — the backend already sends a real `name` for
   * a HUMAN_AGENT participant (and, as a fallback, an embedded `agent.name`), this class just
   * never kept it. Deliberately NOT plumbed into `Message.author`/`Conversation`'s
   * `participantIdentities` map — that stays `identity`-based, matching real Twilio's own
   * `author` contract (an opaque, stable id), which the reference frontend's `fromMe` checks
   * (`author === selfIdentity`) depend on; swapping it for a display name would break every one
   * of those silently. A caller wanting a friendly name reads `participant.name` directly.
   */
  readonly name: string | null;
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
    this.name = raw.name ?? raw.agent?.name ?? null;
    this.attributes = (raw.metadata ?? {}) as JSONValue;
    this.type = raw.participant_type;
    this.bindings = (raw.metadata ?? {}) as JSONValue;
  }
}
