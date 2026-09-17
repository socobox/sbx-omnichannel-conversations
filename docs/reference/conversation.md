# `Conversation`

Archivo fuente: `src/Conversation.ts`. Espejo de `@twilio/conversations`' propio `Conversation` —
un chat. `sid` es la columna `conversation_sid` de zavu (con el id numérico como respaldo);
`attributes` es `chats.metadata` directamente (así viajan `due_time`, `phone`, `name`, etc.).

> **Eco** — cuando envías un mensaje de texto, no hay una confirmación HTTP síncrona: la
> confirmación es el mismo `message.new` que le llega a todo el chat por WebSocket. `sendMessage()`
> espera ese eco antes de resolver — ver la sección dedicada más abajo.

## Propiedades

| Propiedad | Tipo | Notas |
|---|---|---|
| `sid` | `string` | `conversation_sid` del backend, o el id numérico como `string` si es `null` (`Conversation.ts:59`). |
| `friendlyName` | `string \| null` | `chats.name`. |
| `dateCreated` / `dateUpdated` | `Date` | Del `created_at`/`updated_at` del chat. |
| `attributes` | `JSONValue` | `chats.metadata` tal cual — objeto arbitrario de campos custom. |
| `status` | `string` | Ej. `"in_progress"`, `"finish"`. Cambia vía `refreshFromRest` en cada reconexión. |
| `lastMessage` | `{ index: number; dateCreated: Date } \| null` | El último mensaje conocido. `index` es un id de fila de base de datos — ver `message.md`. |
| `lastReadMessageIndex` | `number \| null` | Persistido server-side desde la v0.3.0 — sobrevive un reload de página. Se deriva del `unread_count` que devuelve el backend en cada snapshot; ver la sección de no leídos más abajo. |

## Eventos de instancia

Ya están en la tabla completa de `README.md` (`updated`, `messageAdded`, `messageUpdated`) — acá
el detalle de qué `ConversationUpdateReason` corresponde a cada disparador de `updated`:

| `updateReasons` incluye | Se dispara cuando… | Línea |
|---|---|---|
| `"lastMessage"` | Llega un mensaje nuevo (`message.new`) o, en una reconexión, el `lastMessage.index` cambió respecto al que tenías antes de refrescar. | `Conversation.ts:142`, `192` |
| `"attributes"` | En una reconexión, `chats.metadata` cambió respecto a lo que tenías cacheado; o alguien llama `applyAttributesUpdate` directamente. | `Conversation.ts:173`, `202` |
| `"status"` | En una reconexión, `chats.status` cambió (ej. de `"in_progress"` a `"finish"`). | `Conversation.ts:177` |
| `"lastReadMessageIndex"` | Llamaste `setAllMessagesRead()` o `setAllMessagesUnread()` y el backend aceptó el guardado. **Nunca** se emite desde `refreshFromRest()` (reconexión) aunque el valor derivado haya cambiado — a propósito, ver la nota de esa función. | `Conversation.ts:358`, `380` |

`ConversationUpdateReason` también declara `"dateCreated"`, `"dateUpdated"`, `"friendlyName"` y
`"state"` (ver `types.md`) — ninguno de los cuatro se emite hoy en ninguna parte del código; están
en el catálogo por paridad con Twilio, no porque este paquete los dispare.

## Métodos

### `getMessages(pageSize)`

**Qué hace.** Devuelve un `Paginator` con los `pageSize` mensajes MÁS RECIENTES del chat,
cargando y cacheando el historial completo la primera vez que se llama.

**Cuándo la usas.** Al abrir un chat y pintar los últimos mensajes — el uso típico en
`ChatBodyMessagesComponent.tsx`.

**Firma.**
```ts
async getMessages(pageSize?: number): Promise<Paginator<Message>>; // pageSize por defecto: 30
```

**Ejemplo.**
```ts
const conversation = await client.getConversationBySid("CH-a83f1");
const page = await conversation.getMessages(30);
console.log(page.items.map((m) => m.index)); // [4102, 4109, 4180] — ver message.md sobre por qué hay huecos
console.log(page.hasPrevPage); // true si hay más historial hacia atrás
```

**Qué esperar.** Un `Paginator<Message>` ordenado del más antiguo al más reciente dentro de la
página. La primera llamada dispara un `GET /chats/:id` completo (`Conversation.ts:205-211`); las
siguientes reutilizan la caché en memoria — a diferencia de `getParticipants()`, que **siempre**
va a red (ver más abajo).

**Qué puede salir mal.** Si el `GET /chats/:id` falla (chat borrado, token sin acceso), rechaza
con el mismo formato de error REST de siempre:
```
sbx-omnichannel-conversations: GET /chats/CH-a83f1 failed (404): <cuerpo>
```

### `getParticipants()`

**Qué hace.** Devuelve la lista de participantes del chat, refrescando también la identidad
interna que usa `Message.author`.

**Cuándo la usas.** Al pintar quién está en el chat (cliente + agentes), o justo antes de mandar un
mensaje si necesitas confirmar que ya existe un registro de participante para este agente.

**Firma.**
```ts
async getParticipants(): Promise<Participant[]>;
```

**Ejemplo.**
```ts
const participants = await conversation.getParticipants();
console.log(participants.map((p) => p.identity)); // ["customer_4471", "agent_182"]
```

**Qué esperar.** Un array de `Participant` fresco. **Importante: esta llamada SIEMPRE va a red**
(`Conversation.ts:223-227` hace un `GET /chats/:id` nuevo cada vez), a diferencia de
`getMessages()`, que cachea después de la primera carga. Si la llamas en un loop de render sin
memoizar, vas a generar una petición HTTP por render — no es un descuido, es que hoy no existe un
endpoint más liviano solo-participantes en el backend.

**Qué puede salir mal.** Mismo formato de error REST que cualquier otra llamada a `GET /chats/:id`
si el chat no existe o el token no tiene acceso.

### `getUnreadMessagesCount()`

**Qué hace.** Devuelve el conteo de no leídos que computa el backend, cacheado hasta que algo
pudiera haberlo movido (ver "Qué esperar" abajo).

**Cuándo la usas.** Para pintar el badge de "no leídos" de un chat en la lista de conversaciones.

**Firma.**
```ts
async getUnreadMessagesCount(): Promise<number | null>;
```

**Ejemplo.**
```ts
const conversation = await client.getConversationBySid("CH-a83f1");
const unread = await conversation.getUnreadMessagesCount();
console.log(unread); // 2 — el unread_count que devolvió el backend
```

**Qué esperar.** Un número exacto si el backend tenía contra qué computarlo, o `null` si no tenía
identidad de agente en esta sesión o esta sesión no tiene registro de participante en el chat —
eso sí es "no lo sé", no un cero disfrazado.

No es una llamada de red incondicional: la primera vez (tras hidratar o reconectar) devuelve el
`unread_count` que ya vino en ESE snapshot, sin pedir nada — recién vuelve a golpear
`GET /chats/:id` cuando algo pudo haberlo movido (llegó un mensaje nuevo, o esta misma sesión
marcó leído/no leído). Sin esto, cada llamada duplicaba el `GET /chats/:id` que la hidratación de
esa conversación ya acababa de hacer un instante antes — multiplicado por cada chat del agente, en
cada reconexión.

> **Cambio en v0.3.0.** Antes esta función SIEMPRE devolvía `null` (nada se persistía server-side).
> Un primer paso computaba el conteo localmente desde `cachedMessages` — exacto, pero se perdía en
> cada recarga completa de página, porque no había dónde guardarlo entre cargas. Desde entonces el
> backend persiste `participants.last_read_message_id`/`last_read_at` de verdad
> (`PUT /web_chats/:id/participants/:id`, ver `setAllMessagesRead()`), así que el conteo sobrevive
> un reload: `getUnreadMessagesCount()` computa contra ESE valor, no contra memoria efímera.

**Qué puede salir mal.** Si el `GET /chats/:id` de refresco falla (chat borrado, token sin acceso,
red caída), rechaza con el mismo formato de error REST de siempre — a diferencia de la v0.3.0
original, esta ya no es una operación que "no lanza nunca": depende de una llamada de red real
cuando el conteo cacheado dejó de ser válido.

### `setAllMessagesRead()`

**Qué hace.** Persiste "leído hasta el último mensaje" en el backend
(`PUT /web_chats/:id/participants/:id`, campo `last_read_message_id`), actualiza
`lastReadMessageIndex` localmente, y emite `updated` con razón `"lastReadMessageIndex"`.

**Cuándo la usas.** Cuando el agente abre o enfoca un chat y quieres limpiar su badge de no
leídos.

**Firma.**
```ts
async setAllMessagesRead(): Promise<number>;
```

**Ejemplo.**
```ts
conversation.on("updated", ({ updateReasons }) => {
  if (updateReasons.includes("lastReadMessageIndex")) clearUnreadBadge(conversation.sid);
});

await conversation.setAllMessagesRead();
```

**Qué esperar.** Devuelve `0` siempre que el guardado se acepte (coincide con el contrato de
retorno de Twilio: "no leídos resultantes"). Efecto secundario real: dispara
`updated`/`conversationUpdated` con razón `"lastReadMessageIndex"` — **antes de v0.3.0 este evento
no se emitía en absoluto aquí**, así que un handler que ya escribiste para reaccionar a esa razón
nunca se disparaba y el badge se quedaba pegado hasta el siguiente reload completo de página.

Sin efecto (resuelve `0` sin llamar al backend) si esta sesión no tiene un participante resoluble
en este chat, o si todavía no hay ningún mensaje conocido.

> **Cambio posterior.** El guardado ahora persiste server-side de verdad (antes era enteramente en
> memoria, se perdía en cada recarga de página). Si el backend rechaza el guardado — un `PUT` con
> `{success: false}`, distinto de un error HTTP — esta llamada **lanza**, y ni el estado local ni
> el evento `updated` avanzan: antes de este ajuste, un rechazo así se ignoraba en silencio y el
> consumidor limpiaba su badge por una escritura que nunca aterrizó.

**Qué puede salir mal.**
- El backend rechaza el `PUT` (HTTP no-2xx, o `200` con `{success: false}`): rechaza con
  `"...the backend rejected the read-state update for participant <id> in chat <id>..."`.
- Si el `PUT` sale bien pero la sesión no tiene participante resoluble o no hay mensaje conocido:
  no lanza, simplemente no hace nada (ver "Qué esperar").

### `setAllMessagesUnread()`

**Qué hace.** Persiste "nada leído todavía" en el backend (`last_read_message_id: null`), marca
`lastReadMessageIndex = -1` localmente, emite `updated`, y devuelve el conteo real resultante
(re-consultado al backend).

**Cuándo la usas.** Poco común en un flujo normal de agente — típicamente una acción manual de
"marcar como no leído" en un menú contextual de la lista de chats.

**Firma.**
```ts
async setAllMessagesUnread(): Promise<number>;
```

**Ejemplo.**
```ts
const count = await conversation.setAllMessagesUnread();
console.log(count); // 3 — el unread_count que devuelve el backend tras el guardado
```

**Qué esperar.** El conteo real que computa el backend después de marcar todo como no leído. Sin
participante resoluble en este chat: no llama al backend, no toca `lastReadMessageIndex`, y
resuelve `0` — simétrico con `setAllMessagesRead()` en ese mismo caso.

> **Cambio en v0.3.0 y después.** Primero pasó de devolver `lastMessage.index + 1` (un id de fila
> de base de datos con un uno sumado, nunca una cantidad de mensajes) a un conteo local genuino.
> Ahora persiste server-side y el conteo devuelto viene del backend, no de `cachedMessages`.

También dispara `updated` con razón `"lastReadMessageIndex"`, igual que `setAllMessagesRead()`.

**Qué puede salir mal.** Mismo camino de rechazo que `setAllMessagesRead()` si el backend rechaza
el guardado.

### `prepareMessage()`

**Qué hace.** Devuelve un `MessageBuilder` nuevo, atado a esta conversación.

**Cuándo la usas.** Para armar un mensaje con adjunto — ver `message-builder.md` para el detalle
completo (`setBody`/`addMedia`/`setAttributes`/`build().send()`).

**Firma.**
```ts
prepareMessage(): MessageBuilder;
```

**Ejemplo.** Ver `message-builder.md`.

**Qué esperar.** Un `MessageBuilder` vacío — no dispara red por sí solo, solo al final llamar
`.build().send()`.

**Qué puede salir mal.** Nada aquí; los fallos posibles viven en `.build().send()` — ver
`message-builder.md`.

### `sendMessage(body, attributes)`

**Qué hace.** Envía un mensaje de texto o un adjunto de media a este chat.

**Cuándo la usas.** El envío directo de texto plano (la mayoría de los casos) — para adjuntos con
más control usa `prepareMessage()` en su lugar, aunque ambos terminan aquí por debajo.

**Firma.**
```ts
async sendMessage(body: SendMessageBody, attributes?: JSONValue): Promise<number>;
// SendMessageBody = string | { contentType: string | null; media: Blob; filename?: string }
```

**Ejemplo — texto:**
```ts
const messageIndex = await conversation.sendMessage("Hola, ¿en qué puedo ayudarte?");
console.log(messageIndex); // 4181 — el id real que asignó el backend, vía el eco de message.new
```

**Ejemplo — adjunto:**
```ts
const file = new Blob([bytes], { type: "image/png" });
const messageIndex = await conversation.sendMessage({
  contentType: "image/png",
  media: file,
  filename: "comprobante.png",
});
```

**Qué esperar.** El `index` del mensaje creado (un id de base de datos, no una posición — ver
`message.md`).
- **Texto**: la promesa resuelve solo cuando llega el **eco** — el mismo `message.new` que recibe
  todo el chat (`Conversation.ts:297-303`, `WsTransport#sendMessage`). No hay confirmación
  síncrona más rápida que esa.
- **Media**: resuelve de inmediato con la respuesta de `POST /web_chats/:id/messages`
  (`Conversation.ts:308`) — no espera ningún eco, porque ese endpoint ya devuelve el mensaje creado
  en la misma respuesta.

Nota: en un envío de media, el parámetro `attributes` **se ignora, no se persiste** —
`Conversation.ts:294-296` documenta que la ruta de inserción compartida del backend no acepta
metadata custom al crear el mensaje. No es un descuido silencioso: el adjunto, el `filename` y el
`contentType` sí se guardan bien.

**Qué puede salir mal.**
- Enviar un adjunto sin que este agente tenga un registro de participante en el chat:
  ```
  sbx-omnichannel-conversations: no participant record for this agent in this chat — cannot send media
  ```
  (`Conversation.ts:306`). El participante se resuelve automáticamente del `agent_id` del JWT — si
  ves este error, el agente autenticado genuinamente no está en la lista de participantes de ESE
  chat todavía (revisa `getParticipants()`).
- Un texto cuyo eco nunca llega (socket caído a medio envío) rechaza con `SendTimeoutError`
  (ver `internal/wsTransport.ts` y `ConnectionError`), no con un error genérico — puedes distinguir
  este caso con `error instanceof SendTimeoutError`.
- Enviar mientras el socket está desconectado rechaza de inmediato con
  `"sbx-omnichannel-conversations: cannot send a message while disconnected"`
  (`internal/wsTransport.ts:244`), sin esperar ningún timeout.
