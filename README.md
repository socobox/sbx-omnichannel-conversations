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
+ // own backend, so it needs to know where that is.
+ configure({
+   apiBaseUrl: "https://your-omnichannel-api.example.com",
+   apiKey: YOUR_TENANT_API_KEY, // the same Bearer key your app already sends to every other omnichannel REST call
+ });

  const client = new Client(token); // unchanged — `token` is now zavu's own agent WS token
                                     // (POST /agents/:id/login or /agents/:id/ws_token — same JWT)
```

Everything else — `client.on("conversationJoined", ...)`, `conversation.getMessages()`,
`message.attributes.reactions`, `participant.identity` — keeps the exact same shape and behavior
as `@twilio/conversations`. If your code doesn't reach into Twilio-specific internals (Chat Service
SIDs, Sync, Voice/Video), it should work unmodified after the two lines above.

## API surface

This package implements the subset of `@twilio/conversations` actually used by
`sbx-omnichannel-ui` — not the full SDK (no Sync, Voice, or Video channels).

- `configure({ apiBaseUrl, apiKey })`
- `Client` — `new Client(token)`, events `connectionStateChanged` / `tokenAboutToExpire` /
  `tokenExpired` / `conversationJoined` / `conversationLeft` / `conversationRemoved` /
  `conversationUpdated` / `messageAdded` / `messageUpdated`, methods
  `getSubscribedConversations()` / `getConversationBySid(sid)` / `updateToken(token)` /
  `removeAllListeners()` / `shutdown()`
- `Conversation` — `sid`, `attributes`, `status`, `lastMessage`, `lastReadMessageIndex`,
  `getMessages(pageSize)`, `getUnreadMessagesCount()`, `setAllMessagesRead()`,
  `sendMessage(body, attributes)`, `getParticipants()`
- `Message` — `sid`, `index`, `body`, `author`, `attributes`, `dateCreated`, `dateUpdated`,
  `conversation`, `attachedMedia`
- `Participant` — `sid`, `identity`, `attributes`, `type`
- `Media` — `contentType`, `filename`, `getContentTemporaryUrl()`
- `Paginator<T>` — `items`, `hasNextPage`, `hasPrevPage`, `nextPage()`, `prevPage()`

## Known limitations (v1)

These are real gaps versus the Twilio-backed frontend today, not oversights — each is a
deliberate scope decision, documented here so a caller doesn't discover them by surprise:

- **No outbound media/file sending.** zavu's backend has no endpoint for an agent to send a file
  attachment; `conversation.sendMessage({ contentType, media })` rejects with a clear error.
  Plain-text `sendMessage(body)` works today. Inbound media (received from the customer) works
  fully, including `message.attachedMedia[0].getContentTemporaryUrl()`.
- **No persistent read-tracking.** `lastReadMessageIndex` / `getUnreadMessagesCount()` are
  in-memory only for the lifetime of the `Conversation` object — there's no backend column to
  persist "this agent has read up to message N" across reconnects. `getUnreadMessagesCount()`
  always resolves `null` (the same "compute it yourself" signal Twilio's own SDK can return).
- **Client-side message pagination.** zavu's `GET /chats/:id` returns a chat's entire message
  history in one response (no cursor pagination exists on the backend). `Conversation.getMessages()`
  fetches that full list once, caches it, and `Paginator` slices the cache in memory. Fine for a
  chat's realistic message volume; would need a real backend cursor for very long-lived
  conversations.
- **`Message.attributes.reactions`** is populated from reading state, same as Twilio — but setting
  a reaction is NOT part of this package's API (it wasn't part of the real `@twilio/conversations`
  API either). The frontend's own existing reaction REST call is unaffected by this migration.
- **Web only.** No React Native / mobile transport has been built or validated yet.

## Development

```bash
bun install
bun run build   # tsc -> lib/
bun test        # tests/
```
