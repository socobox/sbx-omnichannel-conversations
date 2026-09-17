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
| `lastReadMessageIndex` | `number \| null` | Solo en memoria — ver la sección de no leídos más abajo. |

## Eventos de instancia

Ya están en la tabla completa de `README.md` (`updated`, `messageAdded`, `messageUpdated`) — acá
el detalle de qué `ConversationUpdateReason` corresponde a cada disparador de `updated`:

| `updateReasons` incluye | Se dispara cuando… | Línea |
|---|---|---|
| `"lastMessage"` | Llega un mensaje nuevo (`message.new`) o, en una reconexión, el `lastMessage.index` cambió respecto al que tenías antes de refrescar. | `Conversation.ts:142`, `192` |
| `"attributes"` | En una reconexión, `chats.metadata` cambió respecto a lo que tenías cacheado; o alguien llama `applyAttributesUpdate` directamente. | `Conversation.ts:173`, `202` |
| `"status"` | En una reconexión, `chats.status` cambió (ej. de `"in_progress"` a `"finish"`). | `Conversation.ts:177` |
| `"lastReadMessageIndex"` | Llamaste `setAllMessagesRead()` o `setAllMessagesUnread()`. | `Conversation.ts:277-279` |

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

**Qué hace.** Devuelve cuántos mensajes cacheados tienen un `index` mayor que
`lastReadMessageIndex`.

**Cuándo la usas.** Para pintar el badge de "no leídos" de un chat en la lista de conversaciones.

**Firma.**
```ts
async getUnreadMessagesCount(): Promise<number | null>;
```

**Ejemplo.**
```ts
const conversation = await client.getConversationBySid("CH-a83f1");
const unread = await conversation.getUnreadMessagesCount();
console.log(unread); // 2 — dos mensajes con index > lastReadMessageIndex
```

**Qué esperar.** Un número exacto si ya hay historial cargado (`cachedMessages` no es `null`), o
`null` si de verdad no se ha cargado nada todavía — eso sí es "no lo sé", no un cero disfrazado.

> **Cambio en v0.3.0.** Antes esta función SIEMPRE devolvía `null`, con el argumento de que nada se
> persiste server-side. Eso seguía siendo cierto (sigue sin haber una columna de "leído hasta el
> mensaje N" en el backend), pero confundía "no persistido" con "no calculable": mientras el
> objeto `Conversation` vive en memoria, la caché de mensajes más el último índice marcado como
> leído SÍ es una respuesta exacta. Antes de este cambio, la alternativa que le quedaba a quien
> llamaba esto era restar `lastMessage.index - lastReadMessageIndex` — y **eso no cuenta
> mensajes**, porque esos índices son ids de fila de base de datos compartidos entre TODOS los
> chats del tenant (ver `message.md`). Solo parecía funcionar antes porque ambos lados solían
> coincidir, dando cero.

**Qué puede salir mal.** No lanza. El error de uso más común es asumir que el resultado sobrevive
un reload de página — no sobrevive: `lastReadMessageIndex` es enteramente en memoria (ver la nota
de la propiedad de clase en `Conversation.ts:36-41`), así que tras recargar la página vuelve a
"todo leído" por defecto.

### `setAllMessagesRead()`

**Qué hace.** Marca `lastReadMessageIndex` como el índice del último mensaje conocido, y emite
`updated` con razón `"lastReadMessageIndex"`.

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

**Qué esperar.** Devuelve `0` siempre (coincide con el contrato de retorno de Twilio: "no leídos
resultantes"). Efecto secundario real: dispara `updated`/`conversationUpdated` con razón
`"lastReadMessageIndex"` — **antes de v0.3.0 este evento no se emitía en absoluto aquí**, así que
un handler que ya escribiste para reaccionar a esa razón nunca se disparaba y el badge se quedaba
pegado hasta el siguiente reload completo de página.

**Qué puede salir mal.** No lanza. Es enteramente en memoria — no hay nada que fallar contra un
backend.

### `setAllMessagesUnread()`

**Qué hace.** Marca todo el historial cacheado como no leído (`lastReadMessageIndex = -1`) y
devuelve el conteo real resultante.

**Cuándo la usas.** Poco común en un flujo normal de agente — típicamente una acción manual de
"marcar como no leído" en un menú contextual de la lista de chats.

**Firma.**
```ts
async setAllMessagesUnread(): Promise<number>;
```

**Ejemplo.**
```ts
const count = await conversation.setAllMessagesUnread();
console.log(count); // 3 — el total real de mensajes cacheados
```

**Qué esperar.** El conteo real de mensajes en caché.

> **Cambio en v0.3.0.** Antes esto devolvía `lastMessage.index + 1` — y ese `+1` sobre un id de
> fila de base de datos (ver `message.md`) nunca fue una cantidad de mensajes: si el último mensaje
> tenía `index: 4180`, el valor devuelto era `4181`, sin relación alguna con cuántos mensajes tenía
> realmente el chat. Ahora es un conteo genuino de elementos en `cachedMessages`.

También dispara `updated` con razón `"lastReadMessageIndex"`, igual que `setAllMessagesRead()`.

**Qué puede salir mal.** No lanza.

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
