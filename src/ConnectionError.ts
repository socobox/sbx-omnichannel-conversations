/**
 * Mirrors @twilio/conversations' own `connectionError` payload — the shape a consumer already
 * destructures ({terminal, message, httpStatusCode, errorCode}). It extends Error so the very
 * same object can also be the rejection value of `Client.create()`, without a caller having to
 * special-case a non-Error throw.
 */
export class ConnectionError extends Error {
  /**
   * `true` when this connection will NOT be retried: the server refused the token, or the
   * initial hydration failed and there is no earlier state to fall back on. Recovery needs an
   * action from the caller (a fresh token, a new Client). `false` means the transport is still
   * retrying with backoff and the application only has to say so in its UI.
   */
  readonly terminal: boolean;
  readonly httpStatusCode: number | undefined;
  readonly errorCode: number | undefined;

  constructor(message: string, options: { terminal: boolean; httpStatusCode?: number; errorCode?: number }) {
    super(message);
    this.name = "ConnectionError";
    this.terminal = options.terminal;
    this.httpStatusCode = options.httpStatusCode;
    this.errorCode = options.errorCode;
    // tsc targets ES2020 here, so native Error subclassing works — but a downstream bundler may
    // still downlevel further, and then `instanceof` silently stops matching. Restoring the
    // prototype explicitly keeps it true either way.
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * The specific failure of "the server never echoed this message back". Split out from plain
 * ConnectionError so a consumer's error reporting can group and filter it: this one is expected
 * at a low, non-zero rate on flaky networks, and mixing it into generic connection errors makes
 * both harder to read.
 */
export class SendTimeoutError extends ConnectionError {
  /** `terminal` defaults to false — the transport is still retrying — but a send abandoned by
   * shutdown() is terminal: nothing will ever retry it, and a caller that reads `terminal` to
   * decide between "retry automatically" and "give up" would otherwise loop against a dead
   * transport forever. */
  constructor(message: string, options: { terminal?: boolean } = {}) {
    super(message, { terminal: options.terminal ?? false });
    this.name = "SendTimeoutError";
    Object.setPrototypeOf(this, SendTimeoutError.prototype);
  }
}

/**
 * The `message.updateBody()`/`message.updateAttributes()` equivalent of SendTimeoutError: neither
 * call resolves from its REST response — both resolve once the corresponding `message.updated`
 * echo round-trips back over the socket (Conversation#awaitMessageUpdate), same "no synchronous
 * ack on the wire" reasoning as a text send. Without this, an echo that never arrives (observed
 * against zavu: a `body` update followed immediately by an `attributes` update on the SAME
 * message can leave the second one un-echoed) left the promise pending forever — see
 * docs/solucion-de-problemas.md.
 */
export class MessageUpdateTimeoutError extends ConnectionError {
  /** `terminal` defaults to false, matching SendTimeoutError: this is a single stuck write, not a
   * statement about the connection's own health — the transport itself may be perfectly fine. */
  constructor(message: string, options: { terminal?: boolean } = {}) {
    super(message, { terminal: options.terminal ?? false });
    this.name = "MessageUpdateTimeoutError";
    Object.setPrototypeOf(this, MessageUpdateTimeoutError.prototype);
  }
}
