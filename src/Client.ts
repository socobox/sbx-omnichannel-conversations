import { TypedEventEmitter } from "./EventEmitter.js";
import { Conversation } from "./Conversation.js";
import { ClientEvent, ConversationEvent } from "./events.js";
import { Message } from "./Message.js";
import { Paginator } from "./Paginator.js";
import { RestApi, type RestChat, type RestChatMessage } from "./internal/restApi.js";
import { TransportEvent } from "./internal/wireProtocol.js";
import { WsTransport, type TransportError } from "./internal/wsTransport.js";
import { ConnectionError } from "./ConnectionError.js";
import type { ClientState, ConnectionState, ConversationUpdateReason, MessageUpdateReason } from "./types.js";

// Keys stay as string literals, not computed keys off ClientEvent (src/events.ts), on purpose —
// tests/contract.test.ts parses this interface as TEXT to freeze the exact event names
// sbx-omnichannel-ui depends on; a computed key would make that guard stop parsing anything.
interface ClientEvents {
  connectionStateChanged: [ConnectionState];
  connectionError: [ConnectionError];
  stateChanged: [ClientState];
  initialized: [];
  initFailed: [{ error?: ConnectionError }];
  tokenAboutToExpire: [];
  tokenExpired: [];
  conversationJoined: [Conversation];
  conversationLeft: [Conversation];
  conversationRemoved: [Conversation];
  conversationUpdated: [{ conversation: Conversation; updateReasons: ConversationUpdateReason[] }];
  messageAdded: [Message];
  messageUpdated: [{ message: Message; updateReasons: MessageUpdateReason[] }];
}

/** Decodes a JWT's payload without pulling in a JWT library — the same trick
 * @twilio/conversations itself uses internally to drive tokenAboutToExpire/tokenExpired. zavu's
 * own agent WS token payload (see chatToken.service.ts's AgentTokenPayload) is plain, readable
 * JSON once base64-decoded — no need to verify the signature client-side, this is just reading
 * claims already trusted (the token came from our own backend). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

const TOKEN_ABOUT_TO_EXPIRE_MS = 3 * 60 * 1000;

/** Hydration has to be bounded. Without it, one chat whose GET hangs would keep the connection
 * from ever being announced, leaving an agent on a loading screen with no error and no timeout. */
const HYDRATION_TIMEOUT_MS = 10_000;

/** Options for `new Client(token, options)` / `Client.create(token, options)`. */
export interface ClientOptions {
  /**
   * How long Message#updateBody / Message#updateAttributes wait for the matching
   * `message.updated` WS echo before rejecting with MessageUpdateTimeoutError. Defaults to
   * Conversation's DEFAULT_MESSAGE_UPDATE_TIMEOUT_MS (12s). Tests pass a short value so they
   * don't have to wait out production timing.
   */
  messageUpdateTimeoutMs?: number;
}

// Matches @twilio/conversations' own `Client` — the single entry point the reference frontend
// constructs with `new Client(token)`. Everything Twilio-specific (Chat Grant JWTs, Conversation
// Service SIDs) is gone; `token` here is zavu's own agent WS token, the exact same one
// `/agents/:id/login` (aliased to `/agents/:id/ws_token`) already returns.
export class Client extends TypedEventEmitter<ClientEvents> {
  private transport: WsTransport;
  private conversationsByChatId = new Map<number, Conversation>();
  private expiryTimers: ReturnType<typeof setTimeout>[] = [];
  // Twilio's Client derives "who am I" from the grants baked into its own access token; this is
  // the equivalent for zavu's agent token (see chatToken.service.ts's AgentTokenPayload) — needed
  // so Conversation can resolve which participant row is "this agent" for the media-send path,
  // with zero new parameters at any frontend call site.
  private agentId: number | null = null;
  private clientState: ClientState | null = null;
  private readonly initPromise: Promise<void>;
  private resolveInit!: () => void;
  private rejectInit!: (error: ConnectionError) => void;
  private initSettled = false;
  // A 'chat'-scope (customer) token carries its own participant_id claim directly (unambiguous —
  // that token is scoped to exactly one chat) — used the same way agentId is, to resolve "who am
  // I" for setAllMessagesRead/setAllMessagesUnread on the CUSTOMER side (the agent side resolves
  // via agentId + Conversation's own per-chat participant map instead, since one agent token is
  // reused across many chats).
  private ownParticipantId: number | null = null;
  private readonly messageUpdateTimeoutMs: number | undefined;

  constructor(token: string, options: ClientOptions = {}) {
    super();
    // Built BEFORE the transport: WsTransport opens its socket inside its own constructor, so
    // there must be no window in which a `connected` frame arrives with no promise to settle.
    this.initPromise = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    // `new Client(token)` has nobody awaiting this promise, so a terminal init failure would
    // surface as an unhandled rejection in the browser console. The failure is still reported
    // through initFailed/connectionError; this only marks the promise as handled. Client.create()
    // awaits the ORIGINAL promise, which this does not affect.
    void this.initPromise.catch(() => undefined);
    this.agentId = this.decodeAgentId(token);
    this.ownParticipantId = this.decodeParticipantId(token);
    this.messageUpdateTimeoutMs = options.messageUpdateTimeoutMs;
    this.transport = this.buildTransport(token);
    this.scheduleExpiryTimers(token);
  }

  /**
   * Mirrors @twilio/conversations' own `Client.create(token)`: resolves with a Client whose
   * initially-subscribed conversations are ALREADY hydrated, so the first
   * getSubscribedConversations() is complete instead of racing the socket.
   *
   * Rejects with a ConnectionError when initialization fails terminally — every initial
   * GET /chats/:id failed, or hydration timed out. A TRANSIENT network failure does not reject:
   * the transport keeps retrying with backoff and this promise stays pending until the first
   * successful hydration, exactly as `new Client(token)` has always behaved.
   *
   * `new Client(token)` keeps working unchanged; this is purely an additional entry point.
   */
  static async create(token: string, options: ClientOptions = {}): Promise<Client> {
    const client = new Client(token, options);
    try {
      await client.initPromise;
    } catch (error) {
      client.shutdown();
      throw error;
    }
    return client;
  }

  /**
   * The live connection state, readable synchronously at any time. A listener that subscribes to
   * connectionStateChanged after the transition already happened — the common case inside a
   * React effect — otherwise has no way to learn the current value, only to await the next one.
   */
  get connectionState(): ConnectionState {
    return this.transport.connectionState;
  }

  /** Mirrors Twilio's own Client#state. `null` until initialization settles. */
  get state(): ClientState | null {
    return this.clientState;
  }

  private decodeAgentId(token: string): number | null {
    const payload = decodeJwtPayload(token);
    return typeof payload?.agent_id === "number" ? payload.agent_id : null;
  }

  private decodeParticipantId(token: string): number | null {
    const payload = decodeJwtPayload(token);
    return typeof payload?.participant_id === "number" ? payload.participant_id : null;
  }

  private buildTransport(token: string): WsTransport {
    const transport = new WsTransport(token);
    transport.on(TransportEvent.ConnectionStateChanged, (state) => this.emit(ClientEvent.ConnectionStateChanged, state));
    transport.on(TransportEvent.Connected, ({ chatIds, generation }) => void this.handleConnected(chatIds, generation));
    transport.on(TransportEvent.ChatAssigned, (chatId) => {
      // Was a bare `void promise`: a failing GET /chats/:id became an unhandled rejection that
      // nothing could observe. Now it is a first-class connectionError.
      void this.joinConversation(chatId).catch((cause) => this.reportError(cause, false));
    });
    transport.on(TransportEvent.ChatFinished, (chatId) => this.removeConversation(chatId));
    // Reassigned away from this agent (a transfer to someone else) — distinct from ChatFinished:
    // the chat itself is still active, just no longer this agent's. `leaveConversation` already
    // existed for the reconnect-reconciliation path (syncConversations); this is the live
    // counterpart to ChatAssigned above, so a consumer sees it disappear immediately instead of
    // only on next reconnect.
    transport.on(TransportEvent.ChatUnassigned, (chatId) => this.leaveConversation(chatId));
    // No Client-level aggregate for this one — matches real Twilio, where participantJoined/Left/
    // Updated are only ever emitted on the Conversation itself, never on Client.
    transport.on(TransportEvent.ParticipantUpdated, ({ chatId, participant }) => {
      this.conversationsByChatId.get(chatId)?.applyRealtimeParticipant(participant);
    });
    transport.on(TransportEvent.MessageNew, (raw) => this.applyMessage(raw, "added"));
    transport.on(TransportEvent.MessageUpdated, (raw) => this.applyMessage(raw, "updated"));
    // No public "connectionError" surface in the real Client either — a serverError becomes a
    // console warning in v1 rather than a new, non-Twilio event nobody would be listening for.
    transport.on(TransportEvent.ServerError, ({ terminal, message, errorCode }) => {
      const error = new ConnectionError(message, { terminal, errorCode });
      this.emit(ClientEvent.ConnectionError, error);
      if (terminal) this.failInitialization(error);
    });
    return transport;
  }

  private clearExpiryTimers(): void {
    for (const timer of this.expiryTimers) clearTimeout(timer);
    this.expiryTimers = [];
  }

  private scheduleExpiryTimers(token: string): void {
    this.clearExpiryTimers();
    const payload = decodeJwtPayload(token);
    const expiresAt = typeof payload?.exp === "number" ? payload.exp * 1000 : null;
    if (expiresAt == null) return;
    const now = Date.now();
    const aboutToExpireDelay = expiresAt - TOKEN_ABOUT_TO_EXPIRE_MS - now;
    if (aboutToExpireDelay > 0) {
      this.expiryTimers.push(setTimeout(() => this.emit(ClientEvent.TokenAboutToExpire), aboutToExpireDelay));
    }
    const expiredDelay = Math.max(0, expiresAt - now);
    this.expiryTimers.push(setTimeout(() => this.emit(ClientEvent.TokenExpired), expiredDelay));
  }

  /**
   * The server's authoritative `connected` frame. Hydration finishes BEFORE connectionState
   * becomes "connected" (see WsTransport#confirmConnected): a consumer reacting to that event —
   * the pattern the reference frontend already uses — used to read an empty
   * getSubscribedConversations(), because hydration was fired and forgotten.
   */
  private async handleConnected(chatIds: number[], generation: number): Promise<void> {
    const outcome = await this.hydrate(chatIds);

    // The socket itself IS open either way. Announcing it keeps the state machine honest and
    // stops it from being stuck on "connecting" forever when a chat fails to load.
    this.transport.confirmConnected(generation);

    if (outcome === "timeout") {
      const error = new ConnectionError(
        `sbx-omnichannel-conversations: loading the subscribed conversations timed out after ${HYDRATION_TIMEOUT_MS}ms`,
        { terminal: !this.initSettled },
      );
      this.emit(ClientEvent.ConnectionError, error);
      if (!this.initSettled) this.failInitialization(error);
      return;
    }

    if (outcome.failed > 0) {
      // Partial failure still initializes: some conversations are usable, and reporting beats
      // refusing to start over one chat the backend cannot serve.
      const terminal = outcome.failed === outcome.total && !this.initSettled;
      const error = new ConnectionError(
        `sbx-omnichannel-conversations: failed to load ${outcome.failed} of ${outcome.total} subscribed conversations: ${outcome.firstError}`,
        { terminal },
      );
      this.emit(ClientEvent.ConnectionError, error);
      if (terminal) {
        this.failInitialization(error);
        return;
      }
    }

    this.completeInitialization();
  }

  /** Bounded, and per-chat tolerant: allSettled rather than all, so one failing GET cannot stop
   * the others from being usable. */
  private async hydrate(chatIds: number[]): Promise<{ total: number; failed: number; firstError: string } | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), HYDRATION_TIMEOUT_MS);
    });
    try {
      const work = this.syncConversations(chatIds);
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Reconciles the cache against `subscribed_chat_ids`, which the server re-sends on EVERY
   * (re)connect. This only ever added before: after an outage every conversation kept its stale
   * pre-outage state and every message that arrived meanwhile was lost, because joinConversation
   * returned early for anything already cached.
   */
  private async syncConversations(chatIds: number[]): Promise<{ total: number; failed: number; firstError: string }> {
    const subscribed = new Set(chatIds);
    for (const chatId of [...this.conversationsByChatId.keys()]) {
      if (!subscribed.has(chatId)) this.leaveConversation(chatId);
    }
    const results = await Promise.allSettled(chatIds.map((id) => this.joinConversation(id)));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const firstError = rejected[0] ? String(rejected[0].reason?.message ?? rejected[0].reason) : "";
    return { total: chatIds.length, failed: rejected.length, firstError };
  }

  /**
   * Joins a chat, or REFRESHES it in place when already cached. Refreshing rather than returning
   * early is what makes a reconnect pick up everything that happened during the outage; doing it
   * in place, instead of building a new Conversation, keeps every reference the consumer already
   * holds valid.
   */
  private async joinConversation(chatId: number): Promise<void> {
    const chat: RestChat = await RestApi.getChat(this.transport.currentToken, chatId);
    const existing = this.conversationsByChatId.get(chatId);
    if (existing) {
      existing.refreshFromRest(chat);
      return;
    }
    const conversation = new Conversation(
      chat,
      this.transport,
      this.agentId,
      this.ownParticipantId,
      this.messageUpdateTimeoutMs,
    );
    conversation.on(ConversationEvent.Updated, (payload) => this.emit(ClientEvent.ConversationUpdated, payload));
    this.conversationsByChatId.set(chatId, conversation);
    this.emit(ClientEvent.ConversationJoined, conversation);
  }

  /**
   * The counterpart of conversationJoined for a chat this agent no longer owns (reassigned
   * away), as opposed to chat.finished -> conversationRemoved. Declared in the event map since
   * 0.1; until now only reachable via the reconnect-reconciliation path (syncConversations
   * diffing subscribed_chat_ids) — a `chat.unassigned` live frame now also reaches it directly
   * (see buildTransport's ChatUnassigned handler above), so a transfer-away is reflected
   * immediately instead of only on the agent's next reconnect (report: sbx-omnichannel-ui, chat
   * CH016a621028234b41bbdc3c07fa5e567c, 2026-09-21 — the previous agent kept the chat live until
   * a full page reload).
   *
   * Emits the CACHED instance, never a fresh one: the consumer filters its list by object
   * identity, so a new object would fail to match and leave the conversation stranded on screen.
   */
  private leaveConversation(chatId: number): void {
    const conversation = this.conversationsByChatId.get(chatId);
    if (!conversation) return;
    this.conversationsByChatId.delete(chatId);
    this.emit(ClientEvent.ConversationLeft, conversation);
  }

  private completeInitialization(): void {
    if (!this.initSettled) {
      this.initSettled = true;
      this.resolveInit();
    }
    this.setClientState("initialized");
  }

  private failInitialization(error: ConnectionError): void {
    if (!this.initSettled) {
      this.initSettled = true;
      this.rejectInit(error);
    }
    this.setClientState("failed", error);
  }

  /**
   * Emits only on a real transition, exactly like WsTransport#setState. Two deliberate
   * consequences: `initialized` is NOT re-emitted on a reconnect (Twilio initializes a Client
   * once, and consumers do one-shot bootstrap work in that handler); and "failed" ->
   * "initialized" IS possible when a failed client recovers via updateToken(freshToken). The
   * init promise itself stays rejected — a promise settles once — which is why what fails is
   * Client.create(), not the Client object forever.
   */
  private setClientState(next: ClientState, error?: ConnectionError): void {
    if (this.clientState === next) return;
    this.clientState = next;
    this.emit(ClientEvent.StateChanged, next);
    if (next === "initialized") this.emit(ClientEvent.Initialized);
    else this.emit(ClientEvent.InitFailed, { error });
  }

  private reportError(cause: unknown, terminal: boolean): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.emit(ClientEvent.ConnectionError, new ConnectionError(message, { terminal }));
  }

  private removeConversation(chatId: number): void {
    const conversation = this.conversationsByChatId.get(chatId);
    if (!conversation) return;
    this.conversationsByChatId.delete(chatId);
    conversation.status = "finish";
    this.emit(ClientEvent.ConversationRemoved, conversation);
  }

  private applyMessage(raw: RestChatMessage, reason: "added" | "updated"): void {
    const conversation = this.conversationsByChatId.get(raw.chat_id);
    if (!conversation) return; // a message for a chat we haven't joined yet — ignored, matches Twilio's own behavior
    if (reason === "added") {
      this.emit(ClientEvent.MessageAdded, conversation.applyRealtimeMessage(raw, reason).message);
    } else {
      const { message, updateReasons } = conversation.applyRealtimeMessage(raw, reason);
      this.emit(ClientEvent.MessageUpdated, { message, updateReasons });
    }
  }

  /**
   * Matches Twilio's own async, Paginator-shaped getSubscribedConversations() — the reference
   * frontend does `(await client.getSubscribedConversations()).items`. There's no real
   * server-side pagination over an agent's subscribed chats (the full set arrives in one
   * `connected` WS message), so this is a single-page Paginator wrapping the current cache.
   */
  async getSubscribedConversations(): Promise<Paginator<Conversation>> {
    const all = [...this.conversationsByChatId.values()];
    return new Paginator(all, 0, all.length || 1);
  }

  /**
   * Matches Twilio's own async getConversationBySid — fetches from the server (zavu's
   * `GET /chats/:id` resolves by numeric id, `conversation_sid`, OR `custom_id` in one query) when
   * the conversation isn't already cached, and throws if it truly doesn't exist, same as Twilio.
   */
  async getConversationBySid(sid: string): Promise<Conversation> {
    for (const conversation of this.conversationsByChatId.values()) {
      if (conversation.sid === sid) return conversation;
    }
    const chat = await RestApi.getChat(this.transport.currentToken, sid);
    const conversation = new Conversation(
      chat,
      this.transport,
      this.agentId,
      this.ownParticipantId,
      this.messageUpdateTimeoutMs,
    );
    conversation.on(ConversationEvent.Updated, (payload) => this.emit(ClientEvent.ConversationUpdated, payload));
    this.conversationsByChatId.set(chat.id, conversation);
    return conversation;
  }

  async updateToken(token: string): Promise<void> {
    this.agentId = this.decodeAgentId(token);
    this.ownParticipantId = this.decodeParticipantId(token);
    this.transport.updateToken(token);
    this.scheduleExpiryTimers(token);
  }

  shutdown(): void {
    // If someone shuts down while Client.create() is still awaiting, settle the promise rather
    // than leaving it — and its caller — pending forever.
    if (!this.initSettled) {
      this.failInitialization(new ConnectionError(
        "sbx-omnichannel-conversations: the client was shut down before it finished initializing",
        { terminal: true },
      ));
    }
    this.clearExpiryTimers();
    this.transport.shutdown();
    this.removeAllListeners();
  }
}
