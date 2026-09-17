import { TypedEventEmitter } from "./EventEmitter.js";
import { ConversationEvent } from "./events.js";
import { Message } from "./Message.js";
import { MessageBuilder } from "./MessageBuilder.js";
import { Participant } from "./Participant.js";
import { Paginator } from "./Paginator.js";
import { RestApi, type RestChat, type RestChatMessage, type RestParticipant } from "./internal/restApi.js";
import { ConversationUpdateReason, MessageUpdateReason, type JSONValue, type SendMessageBody } from "./types.js";
import type { WsTransport } from "./internal/wsTransport.js";

// Keys stay as string literals, not computed keys off ConversationEvent (src/events.ts), on
// purpose — tests/contract.test.ts parses this interface as TEXT to freeze the exact event names
// sbx-omnichannel-ui depends on; a computed key would make that guard stop parsing anything.
interface ConversationEvents {
  updated: [{ conversation: Conversation; updateReasons: ConversationUpdateReason[] }];
  // Mirrors Twilio's own per-conversation messageAdded/messageUpdated — real, actively-used call
  // sites (ChatBodyMessagesComponent.tsx) listen on the CURRENTLY OPEN conversation directly,
  // not just on Client's aggregated feed. Same payload shape as Client's own events.
  messageAdded: [Message];
  messageUpdated: [{ message: Message; updateReasons: MessageUpdateReason[] }];
}

// Mirrors @twilio/conversations' own `Conversation` — one chat. `sid` is zavu's own
// `conversation_sid` column (already a per-chat unique string identifier, serving the exact same
// role Twilio's Conversation SID did). `attributes` is `chats.metadata` directly — the same
// arbitrary-bag-of-custom-fields role Twilio's own conversation attributes played (this is how
// `due_time`, `phone`, `name`, etc. already travel).
export class Conversation extends TypedEventEmitter<ConversationEvents> {
  readonly sid: string;
  readonly friendlyName: string | null;
  readonly dateCreated: Date;
  readonly dateUpdated: Date;
  attributes: JSONValue;
  status: string;
  lastMessage: { index: number; dateCreated: Date } | null = null;
  /**
   * Persisted server-side (see getUnreadMessagesCount/setAllMessagesRead/setAllMessagesUnread) —
   * survives a page reload, unlike this package's earlier v1 (an in-memory-only value, reset to
   * "fully read" on every reconnect, since there was nowhere else to keep it). Still only updated
   * locally by calling setAllMessagesRead/setAllMessagesUnread — there's no WS push for a read
   * receipt happening on some OTHER client instance.
   */
  lastReadMessageIndex: number | null = null;

  /** @internal */
  readonly chatId: number;
  private readonly transport: WsTransport;
  // Twilio's Client derives "who am I" from its own access token's grants; zavu's agent WS token
  // carries `agent_id` the same way (decoded once, in Client). Needed ONLY to resolve which
  // participant row is "this agent" for the media-send path — see sendMessage() below.
  private readonly agentId: number | null;
  // A 'chat'-scope (customer) token's own participant_id claim (see Client's own comment) — used
  // by resolveOwnParticipantId() below as the direct, unambiguous answer for a customer session
  // (an agent session has no such single-chat claim, so it still resolves via agentId + the
  // per-chat participantIdByAgentId map instead).
  private readonly ownParticipantIdFromToken: number | null;
  private cachedMessages: Message[] | null = null;
  private participantIdentities = new Map<number, string>();
  private participantIdByAgentId = new Map<number, number>();
  private pendingMessageUpdates = new Map<number, Array<(message: Message) => void>>();
  // Ver applyUnreadCount()/getUnreadMessagesCount() más abajo — el último conteo que dio el
  // SERVIDOR, y si algo pasó desde entonces que pudiera haberlo movido.
  private lastKnownUnreadCount: number | null = null;
  private unreadCountIsFresh = false;

  /** @internal */
  constructor(raw: RestChat, transport: WsTransport, agentId: number | null = null, ownParticipantIdFromToken: number | null = null) {
    super();
    this.chatId = raw.id;
    this.sid = raw.conversation_sid ?? String(raw.id);
    this.friendlyName = raw.name;
    this.dateCreated = new Date(raw.created_at);
    this.dateUpdated = new Date(raw.updated_at);
    this.attributes = (raw.metadata ?? {}) as JSONValue;
    this.status = raw.status;
    this.transport = transport;
    this.agentId = agentId;
    this.ownParticipantIdFromToken = ownParticipantIdFromToken;
    this.ingestParticipants(raw.participants ?? []);
    if (raw.chat_messages?.length) {
      this.setMessagesFromRest(raw.chat_messages, raw.unread_count ?? null);
    }
  }

  /** @internal — used by Message to resolve `author` without a network round trip. */
  participantIdentity(participantId: number | null): string | undefined {
    return participantId == null ? undefined : this.participantIdentities.get(participantId);
  }

  /** @internal — the same per-session token authenticating this conversation's WS connection,
   * reused for its REST calls (see internal/restApi.ts). Read lazily, never captured, since it
   * can rotate underneath this Conversation via Client#updateToken. */
  get currentToken(): string {
    return this.transport.currentToken;
  }

  private ingestParticipants(participants: RestParticipant[]): void {
    for (const p of participants) {
      if (p.id == null) continue;
      this.participantIdentities.set(p.id, p.indentify ?? `agent_${p.agent_id ?? p.id}`);
      if (p.agent_id != null) this.participantIdByAgentId.set(p.agent_id, p.id);
    }
  }

  /** @internal — used by sendMessage's media branch and setAllMessagesRead/Unread to resolve
   * "which participant is me". */
  private resolveOwnParticipantId(): number | null {
    if (this.ownParticipantIdFromToken != null) return this.ownParticipantIdFromToken;
    if (this.agentId == null) return null;
    return this.participantIdByAgentId.get(this.agentId) ?? null;
  }

  /**
   * Aplica los mensajes de un snapshot completo de `GET /chats/:id` y deriva el estado de leído
   * del MISMO snapshot, en vez de asumir "todo leído".
   *
   * `unreadCount` es el `unread_count` que el backend computó para el participante de esta
   * sesión. Como el snapshot trae el historial entero, "k no leídos" fija `lastReadMessageIndex`
   * exactamente: es el índice del mensaje k-ésimo desde el final, menos uno. Asumir "todo leído"
   * acá era lo que hacía que esta propiedad contradijera su propio comentario de clase — el
   * conteo volvía persistido del servidor mientras el índice de al lado se reseteaba en cada
   * recarga.
   */
  private setMessagesFromRest(raw: RestChatMessage[], unreadCount: number | null): void {
    this.cachedMessages = raw.map((m) => new Message(m, this));
    const last = this.cachedMessages[this.cachedMessages.length - 1];
    if (!last) return;
    this.lastMessage = { index: last.index, dateCreated: last.dateCreated };
    this.lastReadMessageIndex = this.deriveLastReadIndex(this.cachedMessages, unreadCount);
    this.applyUnreadCount(unreadCount);
  }

  /**
   * `unreadCount` null significa que el backend no tenía contra qué computar (token de cliente,
   * o sin registro de participante en este chat): no hay estado de leído que derivar, así que
   * vale el default de siempre — "todo leído", el modo de falla que no pinta badges espurios.
   */
  private deriveLastReadIndex(messages: Message[], unreadCount: number | null): number | null {
    const last = messages[messages.length - 1];
    if (!last) return null;
    if (unreadCount == null || unreadCount <= 0) return last.index;
    const lastReadPosition = messages.length - unreadCount - 1;
    // Todo (o más que todo — el backend cuenta contra ids, no contra posiciones) está sin leer.
    // -1 es el centinela que el menú "marcar como leído/no leído" del consumidor lee
    // (ChatItemMenuComponent.tsx:41).
    return lastReadPosition < 0 ? -1 : messages[lastReadPosition]!.index;
  }

  /**
   * Registra la respuesta del backend, venga del snapshot que venga (hidratación, refresh de
   * reconexión, o un `setAllMessagesRead`/`Unread` propio). No es una caché de propósito
   * general: solo sirve para no repetir un `GET /chats/:id` que este objeto ya acaba de hacer —
   * ver `getUnreadMessagesCount()` más abajo para el porqué exacto.
   */
  private applyUnreadCount(unreadCount: number | null): void {
    this.lastKnownUnreadCount = unreadCount;
    this.unreadCountIsFresh = true;
  }

  /** @internal — called by Client when a fresh message.new/message.updated arrives over WS. */
  applyRealtimeMessage(raw: RestChatMessage, reason: "added" | "updated"): { message: Message; updateReasons: MessageUpdateReason[] } {
    if (raw.participant_id != null && !this.participantIdentities.has(raw.participant_id)) {
      // A participant we haven't seen yet (e.g. a bot/agent added after this Conversation was
      // first hydrated) — best-effort identity fallback; a full re-fetch isn't worth it just to
      // resolve one display name.
      this.participantIdentities.set(raw.participant_id, `participant_${raw.participant_id}`);
    }
    const previous = this.cachedMessages?.find((m) => m.index === raw.id) ?? null;
    const message = new Message(raw, this);
    if (!this.cachedMessages) this.cachedMessages = [];
    const idx = this.cachedMessages.findIndex((m) => m.index === message.index);
    if (idx >= 0) this.cachedMessages[idx] = message;
    else this.cachedMessages.push(message);

    let messageUpdateReasons: MessageUpdateReason[] = [];
    if (reason === "added") {
      this.lastMessage = { index: message.index, dateCreated: message.dateCreated };
      // El conteo cacheado ya no vale: un mensaje nuevo pudo haberlo movido. Invalidar en vez de
      // incrementar localmente delega la decisión de "¿es mío o del cliente?" al backend, que es
      // quien la define — evita tener que acertar acá la misma regla que él ya aplica.
      this.unreadCountIsFresh = false;
      this.emit(ConversationEvent.MessageAdded, message);
    } else {
      // Diffed against the PREVIOUSLY cached copy — both a body edit and an attributes/reaction
      // change arrive as the same wire event (message.updated), so this is the only way to tell
      // a caller which one actually happened, matching Twilio's own updateReasons contract.
      if (previous && previous.body !== message.body) messageUpdateReasons.push(MessageUpdateReason.Body);
      if (previous && JSON.stringify(previous.attributes) !== JSON.stringify(message.attributes)) messageUpdateReasons.push(MessageUpdateReason.Attributes);
      if (messageUpdateReasons.length === 0) messageUpdateReasons = [MessageUpdateReason.Attributes];

      const resolvers = this.pendingMessageUpdates.get(message.index);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve(message);
        this.pendingMessageUpdates.delete(message.index);
      }
      this.emit(ConversationEvent.MessageUpdated, { message, updateReasons: messageUpdateReasons });
    }
    this.emit(ConversationEvent.Updated, { conversation: this, updateReasons: [ConversationUpdateReason.LastMessage] });
    return { message, updateReasons: messageUpdateReasons };
  }

  /** @internal — used by Message#updateBody/updateAttributes to resolve once the corresponding
   * message.updated echo round-trips back over the socket (there's no synchronous ack, same
   * reasoning as Conversation#sendMessage's own pendingSends). */
  awaitMessageUpdate(index: number): Promise<Message> {
    return new Promise((resolve) => {
      const list = this.pendingMessageUpdates.get(index) ?? [];
      list.push(resolve);
      this.pendingMessageUpdates.set(index, list);
    });
  }

  /**
   * @internal — re-applies an authoritative `GET /chats/:id` snapshot onto THIS instance instead
   * of building a new Conversation, so every reference the consumer already holds stays valid:
   * its React state, its `currentConversationSid` lookups, and the listeners it registered on
   * this object. Replacing the instance instead would leave the open conversation pointing at an
   * object nothing updates any more.
   *
   * Used on reconnect. While the socket was down no message.new was delivered, so messages,
   * participants, status and metadata may all have moved on without a single event arriving.
   */
  refreshFromRest(raw: RestChat): void {
    const updateReasons: ConversationUpdateReason[] = [];

    const nextAttributes = (raw.metadata ?? {}) as JSONValue;
    if (JSON.stringify(this.attributes) !== JSON.stringify(nextAttributes)) {
      this.attributes = nextAttributes;
      updateReasons.push(ConversationUpdateReason.Attributes);
    }
    if (this.status !== raw.status) {
      this.status = raw.status;
      updateReasons.push(ConversationUpdateReason.Status);
    }

    this.ingestParticipants(raw.participants ?? []);

    if (raw.chat_messages?.length) {
      const previousLastIndex = this.lastMessage?.index ?? null;
      const knownIndexes = new Set((this.cachedMessages ?? []).map((m) => m.index));
      this.setMessagesFromRest(raw.chat_messages, raw.unread_count ?? null);
      // Ya no se preserva ningún valor previo: el `unread_count` de ESTE snapshot ES el estado
      // de leído, así que re-derivarlo (ver deriveLastReadIndex) es estrictamente mejor que
      // arrastrar una suposición local. El viejo restore de `previousLastRead` existía solo
      // porque el estado era en memoria y el snapshot no tenía nada que decir al respecto.
      if (this.lastMessage && this.lastMessage.index !== previousLastIndex) {
        updateReasons.push(ConversationUpdateReason.LastMessage);
      }

      // Recovering the messages into the cache is only half the job. A consumer that renders an
      // open chat reads the history once and then appends from `messageAdded` — nothing re-reads
      // the cache — so without these the recovered messages sit in memory and never reach the
      // screen. Emitting them makes a reconnect look like what it is: those messages arriving.
      //
      // Deliberately ONLY the per-conversation event, never Client's aggregated one. Client's
      // feed is what drives notifications, and replaying it after a five-minute outage would
      // fire a toast per recovered message. Unread badges have an exact source now —
      // getUnreadMessagesCount() — and do not need to be rebuilt from a replayed stream.
      for (const message of this.cachedMessages ?? []) {
        if (!knownIndexes.has(message.index)) this.emit(ConversationEvent.MessageAdded, message);
      }
    }

    // DELIBERADAMENTE no se agrega ConversationUpdateReason.LastReadMessageIndex acá, ni aunque
    // el valor derivado se haya movido: sbx-omnichannel-ui trata esa razón como "el agente
    // acaba de marcar como leído" y pone el badge en cero (ChatContext.tsx:439-455, cuyo propio
    // comentario dice que depende de que refreshFromRest se quede callado). Emitirla en cada
    // reconexión borraría el badge de los mensajes llegados durante el corte — exactamente el
    // bug que 255723f vino a arreglar.
    if (updateReasons.length) this.emit(ConversationEvent.Updated, { conversation: this, updateReasons });
  }

  /** @internal */
  applyAttributesUpdate(attributes: JSONValue): void {
    this.attributes = attributes;
    this.emit(ConversationEvent.Updated, { conversation: this, updateReasons: [ConversationUpdateReason.Attributes] });
  }

  private async ensureMessagesLoaded(): Promise<Message[]> {
    if (this.cachedMessages) return this.cachedMessages;
    const chat = await RestApi.getChat(this.currentToken, this.chatId);
    this.ingestParticipants(chat.participants ?? []);
    this.setMessagesFromRest(chat.chat_messages ?? [], chat.unread_count ?? null);
    return this.cachedMessages ?? [];
  }

  /**
   * Matches Twilio's own default direction: the `pageSize` MOST RECENT messages, with
   * `hasPrevPage` telling the caller whether older history exists to page back into.
   */
  async getMessages(pageSize = 30): Promise<Paginator<Message>> {
    const all = await this.ensureMessagesLoaded();
    const start = Math.max(0, all.length - pageSize);
    return new Paginator(all, start, pageSize);
  }

  async getParticipants(): Promise<Participant[]> {
    const chat = await RestApi.getChat(this.currentToken, this.chatId);
    this.ingestParticipants(chat.participants ?? []);
    return (chat.participants ?? []).map((p) => new Participant(p));
  }

  /**
   * Computado por el backend (ver el comentario de clase de `lastReadMessageIndex`). Nunca
   * devuelve un valor que pueda haber quedado obsoleto: se re-pide en cuanto algo pasó desde la
   * última respuesta del servidor — un mensaje nuevo o un marcado propio. Lo que NO hace es
   * volver a preguntar cuando la respuesta sigue siendo la misma que el servidor acaba de dar.
   *
   * Resuelve `null` cuando el backend no tenía contra qué computarlo (sin identidad de agente en
   * esta sesión, o sin registro de participante en este chat) — el mismo "no lo sé, computalo
   * vos" que el SDK de Twilio puede devolver, y del que ChatContext de sbx-omnichannel-ui ya
   * hace fallback (`lastMessageIndex - lastReadIndex`).
   */
  async getUnreadMessagesCount(): Promise<number | null> {
    if (this.unreadCountIsFresh) return this.lastKnownUnreadCount;
    const chat = await RestApi.getChat(this.currentToken, this.chatId);
    this.applyUnreadCount(chat.unread_count ?? null);
    return this.lastKnownUnreadCount;
  }

  /**
   * `RestApi.updateParticipant` ya rechaza en un status non-2xx (restApi.ts#request), pero el
   * backend también tiene una forma 200-con-`{success: false}` para una validación rechazada
   * (por eso el tipo de retorno es una unión, restApi.ts). Tratar las dos igual es todo el
   * punto: antes, un guardado rechazado por esa vía igual avanzaba lastReadMessageIndex y emitía
   * `updated`, así que la UI limpiaba su badge por una escritura que nunca aterrizó — y el
   * siguiente getUnreadMessagesCount() lo traía de vuelta, sin nada que explicara el parpadeo.
   */
  private async persistLastRead(participantId: number, lastReadMessageId: number | null): Promise<void> {
    const result = await RestApi.updateParticipant(this.currentToken, this.chatId, participantId, {
      last_read_message_id: lastReadMessageId,
    });
    if (!result.success) {
      const detail = result.errors ? `: ${JSON.stringify(result.errors)}` : "";
      throw new Error(
        `sbx-omnichannel-conversations: the backend rejected the read-state update for participant ${participantId} in chat ${this.chatId}${detail}`,
      );
    }
  }

  /**
   * Persists "read up to the last message" server-side (see the class-level `lastReadMessageIndex`
   * comment — this used to be in-memory only). Matches Twilio's own return contract (resulting
   * unread count, always 0 once everything's marked read). A no-op (resolves 0 without a network
   * call) when this session has no resolvable participant in this chat or there's nothing to mark
   * read yet — same "nothing to do" cases sendMessage's media branch already treats this way,
   * except here it's not worth throwing over.
   */
  async setAllMessagesRead(): Promise<number> {
    const participantId = this.resolveOwnParticipantId();
    if (participantId == null || !this.lastMessage) return 0;

    await this.persistLastRead(participantId, this.lastMessage.index);
    this.lastReadMessageIndex = this.lastMessage.index;
    this.applyUnreadCount(0);
    this.emit(ConversationEvent.Updated, {
      conversation: this,
      updateReasons: [ConversationUpdateReason.LastReadMessageIndex],
    });
    return 0;
  }

  /** Persists "nothing read yet" server-side — see setAllMessagesRead's own comment. The
   * resulting count is re-fetched from the backend (getUnreadMessagesCount), not computed
   * locally, since only the server actually knows the chat's true total message count. */
  async setAllMessagesUnread(): Promise<number> {
    const participantId = this.resolveOwnParticipantId();
    // Sin participante no hay nada que persistir ni nada que contar: se devuelve 0 sin tocar
    // nada, igual que setAllMessagesRead. Antes, esta rama movía lastReadMessageIndex a -1 SIN
    // emitir `updated`, así que la propiedad pública y el flujo de eventos se contradecían y la
    // etiqueta del menú marcar-como-leído/no-leído del consumidor (ChatItemMenuComponent.tsx:41)
    // se invertía por una escritura que nunca ocurrió.
    if (participantId == null) return 0;

    await this.persistLastRead(participantId, null);
    this.lastReadMessageIndex = -1;
    this.unreadCountIsFresh = false;
    this.emit(ConversationEvent.Updated, {
      conversation: this,
      updateReasons: [ConversationUpdateReason.LastReadMessageIndex],
    });
    return (await this.getUnreadMessagesCount()) ?? 0;
  }

  /** Matches Twilio's own MessageBuilder entry point — see MessageBuilder's own comment for
   * exactly which subset of the real builder API is implemented. */
  prepareMessage(): MessageBuilder {
    return new MessageBuilder(this);
  }

  /**
   * Text: unchanged, resolves once the message.new echo round-trips over the socket (see
   * WsTransport#sendMessage). Media: proxied through zavu's own `POST /web_chats/:id/messages`
   * (see the README) — resolves immediately from that REST response, no need to wait for the WS
   * echo since the endpoint already returns the created message. Requires this agent to have a
   * participant record in this chat already (the same requirement the WS text-send path enforces
   * server-side); `attributes` on a media send isn't persisted yet — a narrow, documented v1 gap
   * (recordMessage's shared insert path doesn't accept custom metadata at creation time today).
   */
  async sendMessage(body: SendMessageBody, attributes?: JSONValue): Promise<number> {
    if (typeof body === "string") {
      void attributes;
      // El id del participante propio deja que el transporte reconozca SU eco: dos lados de un
      // chat mandan el mismo texto corto ("ok", "gracias") a la vez con toda normalidad.
      return await this.transport.sendMessage(this.chatId, body, this.resolveOwnParticipantId());
    }
    const participantId = this.resolveOwnParticipantId();
    if (participantId == null) {
      throw new Error("sbx-omnichannel-conversations: no participant record for this agent in this chat — cannot send media");
    }
    const created = await RestApi.sendMedia(this.currentToken, this.chatId, participantId, body.media, body.filename, body.contentType, undefined);
    return created.id;
  }
}
