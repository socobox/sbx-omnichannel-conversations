# Referencia de API — sbx-omnichannel-conversations

Esta es la referencia técnica para el equipo de SBX. Documenta la v0.3.0 del working tree (sin
commitear a la fecha de escritura). El `README.md` del repo (en inglés) sigue siendo la guía de
instalación y migración; esto es el detalle por clase y, sobre todo, **la tabla de eventos**, que
hoy no existe documentada en ningún otro lado.

> **Nota de versión.** `package.json` todavía declara `"version": "0.2.0"` aunque el código ya
> tiene los cambios de la v0.3.0 descritos abajo (`Client.create()`, conteo real de no leídos,
> `connectionStateChanged("connected")` después de hidratar). Es una discrepancia del working
> tree, no de esta documentación — repórtalo si te toca hacer el bump de versión.

## Índice

- [`configure.md`](./configure.md) — `configure({apiBaseUrl})`, el único paso de arranque nuevo
- [`client.md`](./client.md) — `Client`: `new Client(token)` vs `Client.create(token)`, eventos, métodos
- [`conversation.md`](./conversation.md) — `Conversation`: mensajes, participantes, no leídos, envío
- [`message.md`](./message.md) — `Message`: `index` (no es una posición), `attributes`, edición
- [`message-builder.md`](./message-builder.md) — `MessageBuilder`: `prepareMessage().addMedia(...).build().send()`
- [`participant.md`](./participant.md) — `Participant`: `identity` (con la errata `indentify` del backend)
- [`media.md`](./media.md) — `Media`: adjuntos, `filename` casi siempre `null`
- [`paginator.md`](./paginator.md) — `Paginator<T>`: paginado en memoria, no en el backend
- [`types.md`](./types.md) — catálogos `as const` (`ConnectionState`, `ClientState`, los `UpdateReason`)

## Glosario rápido

> **WebSocket** — conexión bidireccional persistente entre el navegador y el servidor; a
> diferencia de una petición HTTP normal, queda abierta y cualquiera de los dos lados puede
> mandar datos en cualquier momento. Es el transporte de tiempo real de este paquete
> (`src/internal/wsTransport.ts`).
>
> **Hidratación** — cargar desde el backend (`GET /chats/:id`) el estado completo de las
> conversaciones suscritas antes de anunciar que el cliente ya está listo, en vez de dejar que la
> UI arranque con una caché vacía y se vaya llenando sola.
>
> **Backoff** — esperar cada vez más tiempo entre un reintento de conexión y el siguiente, para no
> golpear al servidor con reconexiones instantáneas en cadena tras una caída.
>
> **JWT** (JSON Web Token) — el token de sesión del agente (el mismo que ya usa
> `new Client(token)`); trae claims legibles como `agent_id` y `exp` sin necesidad de verificar la
> firma en el cliente.
>
> **Paginador** — objeto con `items`, `hasNextPage`/`hasPrevPage` y `nextPage()`/`prevPage()`; en
> este paquete pagina en memoria, no contra el backend (ver `paginator.md`).
>
> **Eco** — la confirmación de un mensaje enviado no llega como respuesta directa: llega como el
> mismo `message.new` que el resto de la conversación recibe por WebSocket. "Esperar el eco" es
> esperar ese mensaje de vuelta para resolver la promesa de envío.

## Tabla completa de eventos

Todos los eventos son objetos `as const` (ver `types.md`), nunca `enum` de TypeScript. Los nombres
de cadena — `"messageAdded"`, `"connected"`, etc. — están congelados por
`tests/contract.test.ts`, que lee `Client.ts`/`Conversation.ts` como texto plano para asegurar que
nadie los cambie sin darse cuenta: `sbx-omnichannel-ui` depende de escribirlos exactamente así.

### Eventos de `Client`

| Evento | Quién lo emite | Payload | Cuándo se dispara |
|---|---|---|---|
| `connectionStateChanged` | `Client` (relay de `WsTransport`) | `ConnectionState`: `"connecting"` \| `"connected"` \| `"disconnecting"` \| `"disconnected"` \| `"denied"` | En cada transición real del socket. **Cambio de v0.3.0**: `"connected"` ahora se emite DESPUÉS de que termina la hidratación inicial (`Client.ts:183`, vía `WsTransport#confirmConnected`) — antes se emitía en cuanto el socket abría, y un handler que reaccionaba a `"connected"` (el patrón que usa `ChatContext.tsx`) veía `getSubscribedConversations()` todavía vacío. |
| `connectionError` | `Client` | `ConnectionError` | Timeout de hidratación (10s, `HYDRATION_TIMEOUT_MS`), hidratación parcial o total fallida, un frame `error` del servidor, o un `GET /chats/:id` que falla al reaccionar a `chat.assigned`. |
| `stateChanged` | `Client` | `ClientState`: `"initialized"` \| `"failed"` | Cuando cambia el estado del objeto `Client` — normalmente una sola vez en su vida (ver `initialized`/`initFailed` abajo). |
| `initialized` | `Client` | *(sin payload)* | Una sola vez, cuando la hidratación inicial termina con éxito (total o parcial). NO se re-emite en reconexiones posteriores — esas solo se ven en `connectionStateChanged`. |
| `initFailed` | `Client` | `{ error?: ConnectionError }` | Cuando la hidratación inicial falla del todo: timeout total, o fallan TODOS los `GET /chats/:id` de la lista inicial. |
| `tokenAboutToExpire` | `Client` | *(sin payload)* | 3 minutos antes de que expire el JWT (claim `exp`), calculado en `scheduleExpiryTimers`. |
| `tokenExpired` | `Client` | *(sin payload)* | Exactamente en el instante `exp` del JWT. |
| `conversationJoined` | `Client` | `Conversation` | Un chat entra al set de suscritos: en la hidratación inicial/reconexión (`syncConversations`), o por un frame `chat.assigned` de un chat que este `Client` no tenía cacheado. |
| `conversationLeft` | `Client` | `Conversation` (instancia **cacheada**, no una nueva) | El chat **sigue existiendo** pero ya no es tuyo — típicamente porque te lo reasignaron a otro agente. **Desde v0.3.0-beta.2**: llega EN VIVO por un frame `chat.unassigned` (sin esperar a la próxima reconexión); antes de eso solo se disparaba al reconectar, cuando `subscribed_chat_ids` ya no incluía el chat. Ver la nota "conversationLeft vs conversationRemoved" más abajo. |
| `conversationRemoved` | `Client` | `Conversation` | Llega un frame `chat.finished` — el chat **terminó** (su `status` pasa a `"finish"`). Ver la misma nota. |
| `conversationUpdated` | `Client` (relay del `updated` de la `Conversation` afectada) | `{ conversation: Conversation, updateReasons: ConversationUpdateReason[] }` | Cualquier cambio detectado en una conversación ya unida: último mensaje, atributos, status, o el índice de última lectura. El detalle de qué dispara cada `updateReason` está en `conversation.md`. |
| `messageAdded` | `Client` | `Message` | Frame `message.new` para un chat ya unido (si el chat no está unido, el mensaje se ignora silenciosamente — igual que Twilio). |
| `messageUpdated` | `Client` | `{ message: Message, updateReasons: MessageUpdateReason[] }` | Frame `message.updated`. `updateReasons` distingue una edición de texto (`["body"]`) de un cambio de metadata/reacciones (`["attributes"]`), comparando contra la copia previamente cacheada. |

### Eventos de `Conversation`

Cada `Conversation` emite su propio subconjunto de eventos, alcance a ESA conversación — útil
para un componente que solo escucha el chat actualmente abierto (`ChatBodyMessagesComponent.tsx`),
sin filtrar el feed agregado de `Client`.

| Evento | Quién lo emite | Payload | Cuándo se dispara |
|---|---|---|---|
| `updated` | La `Conversation` misma | `{ conversation: Conversation, updateReasons: ConversationUpdateReason[] }` | Lo mismo que dispara `conversationUpdated` en `Client`, pero solo se escucha si te suscribes directamente a esta instancia. |
| `messageAdded` | La `Conversation` misma | `Message` | Mismo disparador que el `messageAdded` de `Client`, acotado a los mensajes de esta conversación. |
| `messageUpdated` | La `Conversation` misma | `{ message: Message, updateReasons: MessageUpdateReason[] }` | Mismo disparador que el `messageUpdated` de `Client`, acotado a esta conversación. |

### `conversationLeft` vs `conversationRemoved` — no es obvio

Ambos hacen que el chat desaparezca de `getSubscribedConversations()`, pero por razones opuestas:

- **`conversationLeft`** — "**te reasignaron el chat**". El chat sigue vivo en el backend
  (`status` puede seguir siendo `"in_progress"`), simplemente ya no es tuyo. Llega por dos
  caminos: en vivo, por un frame `chat.unassigned` (desde v0.3.0-beta.2) en cuanto el backend
  transfiere el chat a otro agente; y como red de respaldo, al reconectar, si
  `subscribed_chat_ids` ya no incluye ese chat (`Client.ts:234-243`, `syncConversations`) — por
  si el frame en vivo se perdió por lo que sea. Nadie decidió que el chat terminó — este agente
  perdió el acceso.
- **`conversationRemoved`** — "**el chat terminó**". Llega un frame `chat.finished` explícito
  (`Client.ts:140,316-322`); la conversación pasa su `status` a `"finish"` antes de emitir el
  evento.

Práctico: si tu UI muestra "este chat se cerró" vs "este chat ya no es tuyo", son mensajes
distintos y necesitas escuchar eventos distintos — no puedes inferir cuál pasó a partir de que
"la conversación desapareció de la lista".

### Eventos internos (no públicos)

`src/internal/wsTransport.ts` tiene su propio `WsTransportEvents` (`connectionStateChanged`,
`connected`, `message.new`, `message.updated`, `chat.finished`, `chat.assigned`,
`chat.unassigned`, `serverError`) y `src/internal/wireProtocol.ts` define los nombres de los
frames que realmente viajan por el WebSocket (`connected`, `message.new`, `message.updated`,
`chat.finished`, `chat.assigned`, `chat.unassigned`, `error`). Ninguno de los dos se exporta desde
`src/index.ts` ni debería usarse desde fuera del paquete — `Client` es quien traduce todo esto a
la superficie pública documentada arriba.

## Cambios de comportamiento en v0.3.0

Estos cuatro son fáciles de asumir mal si solo leíste versiones anteriores del código o el README
en inglés:

1. **`getUnreadMessagesCount()` ahora cuenta de verdad.** Antes siempre devolvía `null`. Ver el
   detalle completo en `conversation.md`.
2. **`setAllMessagesUnread()` devuelve un conteo real de mensajes**, no `lastMessage.index + 1`
   (ese `+1` sobre un id de fila de base de datos nunca fue una cantidad de mensajes — ver
   `message.md`, sección sobre `Message.index`).
3. **`connectionStateChanged("connected")` se emite después de hidratar**, no en cuanto abre el
   socket — ver la fila correspondiente en la tabla de arriba.
4. **`Client.create()` es nuevo.** `new Client(token)` sigue funcionando igual que siempre, pero
   ahora existe una forma de esperar a que el cliente esté realmente listo antes de usarlo. Ver la
   sección dedicada en `client.md`.
