# sbx-omnichannel-conversations

A drop-in replacement for [`@twilio/conversations`](https://www.npmjs.com/package/@twilio/conversations),
backed entirely by SBX Omnichannel's own WebSocket/REST API. Same classes, same events, same data
shapes — zero Twilio dependency, zero Twilio infrastructure.

Built for [`sbx-omnichannel-ui`](https://github.com/socobox) so the frontend's Twilio integration
can be swapped for zavu's own backend by changing **only the import and one bootstrap call** —
every other call site (`new Client(token)`, `conversation.sendMessage(...)`,
`client.on("messageAdded", ...)`, etc.) stays exactly as written today.

## Install

```bash
npm install sbx-omnichannel-conversations
```

## Migrating from `@twilio/conversations`

```diff
- import { Client } from "@twilio/conversations";
+ import { Client, configure } from "sbx-omnichannel-conversations";

+ // Call ONCE at app bootstrap, before constructing any Client. Twilio's own Client only ever
+ // needed a token because it always talked to Twilio's infrastructure — this one talks to your
+ // own backend, so it just needs to know where that is. Never pass your tenant's api_key here —
+ // that's a broad, server-side-only secret; shipping it in configure() would bake it into the
+ // browser bundle. This package instead reuses the SAME per-session token you already pass to
+ // `new Client(token)` for every REST call it makes, authenticated the same way as the socket.
+ configure({
+   apiBaseUrl: "https://your-omnichannel-api.example.com",
+ });

  const client = new Client(token); // unchanged — `token` is now zavu's own agent WS token
                                     // (POST /agents/:id/login or /agents/:id/ws_token — same JWT)
```

## Waiting for the client to be ready

`new Client(token)` returns immediately — before anything is loaded. It opens a socket, and the
conversations arrive over two more network round trips. Ask for them right after and you get an
empty list.

```ts
const client = await Client.create(token);        // resolves once conversations are loaded
const { items } = await client.getSubscribedConversations();   // complete, not a race
```

`new Client(token)` still works and is still supported; `create()` is an additional entry point,
not a replacement.

| Getter | Values | Meaning |
|---|---|---|
| `client.connectionState` | `connecting` · `connected` · `disconnecting` · `disconnected` · `denied` | The socket. Readable synchronously, so a listener that subscribes late can still learn the current value. |
| `client.state` | `null` → `initialized` \| `failed` | The Client object. It initializes exactly **once**; reconnections are reported through `connectionState` alone, so `initialized` is safe for one-shot bootstrap work. |

```ts
client.on("connectionError", ({ terminal, message }) => {
  if (terminal) reauthenticate();      // will not retry on its own
  else showBanner(message);            // transport is still retrying with backoff
});
```

> **Behaviour change in 0.3.0.** `connectionStateChanged("connected")` now fires *after* the
> subscribed conversations have been hydrated, so a consumer reading
> `getSubscribedConversations()` from that handler no longer races an empty cache. No signature
> changed.

Everything else — `client.on("conversationJoined", ...)`, `conversation.getMessages()`,
`message.attributes.reactions`, `participant.identity` — keeps the exact same shape and behavior
as `@twilio/conversations`. If your code doesn't reach into Twilio-specific internals (Chat Service
SIDs, Sync, Voice/Video), it should work unmodified after the two lines above.

## API surface

This package implements the subset of `@twilio/conversations` actually used by
`sbx-omnichannel-ui` — not the full SDK (no Sync, Voice, or Video channels).

- `configure({ apiBaseUrl })` — no credential of any kind; every REST call reuses the session
  token already passed to `new Client(token)`
- `Client` — `Client.create(token)` → `Promise<Client>` (recommended) or `new Client(token)`,
  getters `connectionState` / `state`, events `stateChanged` / `initialized` / `initFailed` /
  `connectionError` / `connectionStateChanged` / `tokenAboutToExpire` /
  `tokenExpired` / `conversationJoined` / `conversationLeft` / `conversationRemoved` /
  `conversationUpdated` / `messageAdded` / `messageUpdated({message, updateReasons})`, methods
  `getSubscribedConversations()` → `Promise<Paginator<Conversation>>` /
  `getConversationBySid(sid)` → `Promise<Conversation>` / `updateToken(token)` → `Promise<void>` /
  `removeAllListeners()` / `shutdown()`
- `Conversation` — `sid`, `attributes`, `status`, `dateCreated`, `dateUpdated`, `lastMessage`,
  `lastReadMessageIndex`, events `updated` / `messageAdded` / `messageUpdated({message, updateReasons})`,
  `getMessages(pageSize)`, `getUnreadMessagesCount()`, `setAllMessagesRead()`,
  `setAllMessagesUnread()`, `sendMessage(body, attributes)`, `prepareMessage()`, `getParticipants()`
- `Message` — `sid`, `index`, `body`, `author`, `attributes`, `type`, `media` (deprecated,
  single-attachment alias), `dateCreated`, `dateUpdated`, `conversation`, `attachedMedia`,
  `updateBody(body)`, `updateAttributes(attributes)`
- `MessageBuilder` — `prepareMessage()`'s return value: `setBody(text)`, `setAttributes(attrs)`,
  `addMedia(payload)`, `build().send()` — only the subset the reference frontend actually calls
  (single attachment; more than one throws a clear error, see below)
- `Participant` — `sid`, `identity`, `attributes`, `type`, `bindings` (best-effort, not strictly
  typed per channel)
- `Media` — `contentType`, `filename`, `getContentTemporaryUrl()`
- `Paginator<T>` — `items`, `hasNextPage`, `hasPrevPage`, `nextPage()`, `prevPage()`
- `ConnectionError` / `SendTimeoutError` — typed errors; `terminal` says whether the transport
  will retry on its own
- `ClientEvent` / `ConversationEvent` / `ConnectionState` / `ClientState` / `MessageType` —
  `as const` catalogues, so `ClientEvent.MessageAdded` works and the plain string still does
- `JSONValue` / `JSONObject` / `JSONArray` — matches `@twilio/conversations`' own types exactly,
  since `attributes` (and related methods) are typed against these, not a plain
  `Record<string, unknown>`

## Known limitations (v1)

These are real gaps versus the Twilio-backed frontend today, not oversights — each is a
deliberate scope decision, documented here so a caller doesn't discover them by surprise:

- **`MessageBuilder`/`prepareMessage()` only supports ONE attachment per message.** A real call
  site (an email compose UI) can attach several files to one message via repeated `addMedia()`
  calls — zavu's upload endpoint accepts exactly one file per message today, so `build().send()`
  throws a clear error rather than silently dropping every attachment past the first. `setSubject`,
  `setEmailBody`, `setEmailHistory`, and Content Template SIDs (real Twilio `MessageBuilder`
  features) aren't implemented at all — nothing in the migrated frontend calls them.
- **Outbound media/file sending works, but only for `client === 'web'` chats**, and only the
  attachment itself — `conversation.sendMessage({contentType, media, filename})` proxies the blob
  straight to zavu's own `POST /web_chats/:id/messages`, which uploads it to SBX and creates the
  message in one round trip. `attributes` passed alongside a media send are **not persisted yet**
  (the shared message-insert path zavu's backend uses everywhere doesn't accept custom metadata at
  creation time) — a narrow, deliberate v1 gap, not a silent drop: the media itself, filename, and
  content type all work. Requires this agent to already have a participant record in the chat
  (`sendMessage` rejects with a clear "no participant record for this agent in this chat" error
  otherwise — resolved automatically from the `agent_id` claim in the token passed to
  `new Client(token)`, no new parameters needed at any call site).
- **Message body editing works, but only for `client === 'web'` chats.** `message.updateBody(text)`
  persists the edit server-side and resolves once the `message.updated` broadcast round-trips back
  (there's no synchronous ack). For any other channel (whatsapp/sms/email/instagram) the backend
  rejects with a 422 — that channel's message has already gone out through an external provider
  and can't be retroactively edited there. `message.updateAttributes(attrs)` always works (a
  wholesale merge into the message's metadata), regardless of channel.
- **Read-tracking is persisted server-side (2026-09-17).** `setAllMessagesRead()`/
  `setAllMessagesUnread()` save "the last message this session's own participant has read" on the
  backend (`participants.last_read_message_id`/`last_read_at`) — it survives a page reload, unlike
  an earlier v1 that only kept this in memory. `getUnreadMessagesCount()` is backend-computed and
  never returns a value that could have gone stale: it re-fetches as soon as something could have
  moved it (a new message, or this session's own read/unread call) rather than repeating the
  `GET /chats/:id` that hydration just made for every chat on every reconnect. It resolves `null`
  only when the backend has nothing to compute it against — no agent identity on this session, or
  no participant record in this chat (the same "compute it yourself" signal Twilio's own SDK can
  return, which `sbx-omnichannel-ui`'s ChatContext already falls back on). A rejected read/unread
  write (HTTP error, or a `200` with `{success: false}`) throws — the local state and the
  `lastReadMessageIndex` event only ever reflect a write the backend actually accepted.
- **Client-side message pagination.** zavu's `GET /chats/:id` returns a chat's entire message
  history in one response (no cursor pagination exists on the backend). `Conversation.getMessages()`
  fetches that full list once, caches it, and `Paginator` slices the cache in memory. Fine for a
  chat's realistic message volume; would need a real backend cursor for very long-lived
  conversations.
- **`Message.attributes.reactions`** is populated from reading state, same as Twilio — but setting
  a reaction is NOT part of this package's API (it wasn't part of the real `@twilio/conversations`
  API either). The frontend's own existing reaction REST call is unaffected by this migration.
- **Web only.** No React Native / mobile transport has been built or validated yet.

## Documentation

Full docs live in [`docs/`](docs/) — they are written in Spanish for the SBX team.

| | |
|---|---|
| [Conceptos](docs/conceptos.md) | The mental model, with no function signatures at all |
| [Primeros pasos](docs/primeros-pasos.md) | From zero to a working chat |
| [Referencia](docs/reference/) | Every function: what it does, an example, what to expect, what can go wrong |
| [Solución de problemas](docs/solucion-de-problemas.md) | Symptom → cause → fix |
| [Cambios de la v0.3.0](docs/CAMBIOS-v0.3.0.md) | What changed, the evidence, and the risk register |

## Development

```bash
bun install
bun run build   # tsc -> lib/
bun test        # tests/
```
