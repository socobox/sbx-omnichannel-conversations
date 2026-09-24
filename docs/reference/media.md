# `Media`

Archivo fuente: `src/Media.ts`. Espejo de `@twilio/conversations`' propio `Media` — un archivo
adjunto a un `Message`. `getContentTemporaryUrl()` resuelve de forma perezosa (una llamada de red
real, igual que en Twilio), nunca por adelantado para todos los mensajes de un chat.

## `message.attachedMedia` puede traer más de un `Media` (desde 2026-09-22)

Antes, un mensaje tenía como máximo un adjunto. Ahora `message.attachedMedia` es un array con UN
`Media` por cada entrada de `metadata.attachments` — cada uno resuelve su propia URL por separado
(`getContentTemporaryUrl()` internamente pasa `?key=<la clave de ESE adjunto>` a
`GET .../media_url`, no la del mensaje entero). `message.media` (deprecated) sigue siendo un alias
del PRIMERO nada más, igual que su equivalente deprecado en Twilio.

## `Media.filename` — real desde 2026-09-22, `null` solo para un mensaje viejo o de un solo adjunto sin nombre

Antes de 2026-09-22, `Media.filename` era **siempre `null`** en un adjunto entrante: el backend no
mandaba ningún campo de nombre de archivo, solo `media` (la clave/URL interna) y `media_type`.

Desde que zavu soporta varios adjuntos por mensaje (`metadata.attachments`, un array de
`{key, filename, content_type}` — ver `schema.ts`'s `AttachmentPublicRow` del lado del backend),
`RestChatMessage.attachments` SÍ trae el nombre real de cada archivo, y `Message.ts` lo usa
directamente al construir cada `Media`:

```ts
// Message.ts — una fila por attachment cuando `raw.attachments` no está vacío
this.attachedMedia = raw.attachments?.length
  ? raw.attachments.map((a) => new Media({
      chatId: raw.chat_id, messageId: raw.id,
      contentType: a.content_type ?? "application/octet-stream",
      filename: a.filename ?? a.name ?? null, // `name` = clave legacy, solo mensajes de antes del 2026-09-24
      key: a.key,
      getToken: () => conversation.currentToken,
    }))
  : /* fallback a la fila legacy — ver abajo */;
```

**Desde 2026-09-24** esto también aplica a adjuntos ENTRANTES (whatsapp/instagram/sms) — antes solo
un adjunto que el propio agente mandaba (`sendMessage`/`MessageBuilder`) construía `attachments`;
uno que llegaba de un cliente real solo tenía `media`/`media_type`, sin nombre. El email entrante
es el único canal que todavía no arma `attachments` (el webhook de SBX Mail no trae datos de
adjunto utilizables) — ver `messagePipeline.service.ts`'s propio comentario.

**Sigue siendo `null`** solo en el camino legacy real: un mensaje de ANTES de esta fecha, o del
canal de email entrante, sin `metadata.attachments` — ese `Media` se construye sin `filename`,
igual que siempre.

**Práctico:** para casi cualquier mensaje con adjunto hoy, `message.attachedMedia![i].filename` ya
trae el nombre real. Solo hace falta un fallback genérico para mensajes viejos o email entrante.

## Propiedades

| Propiedad | Tipo | Notas |
|---|---|---|
| `contentType` | `string` | Del `content_type` del attachment (o `media_type` del mensaje en el camino legacy), o `"application/octet-stream"` si viene vacío. |
| `filename` | `string \| null` | El nombre real del archivo desde 2026-09-22 (ver la sección de arriba) — `null` solo para un mensaje de antes de esa fecha. |

## Métodos

### `getContentTemporaryUrl()`

**Qué hace.** Pide al backend una URL temporal para descargar/mostrar el adjunto, y la cachea en
memoria para llamadas repetidas.

**Cuándo la usas.** Justo antes de renderizar una imagen o un enlace de descarga en la burbuja de
un mensaje con adjunto — nunca por adelantado para todos los mensajes de la lista (por eso es
perezoso).

**Firma.**
```ts
async getContentTemporaryUrl(): Promise<string | null>;
```

**Ejemplo.**
```ts
const message = page.items.find((m) => m.type === "media")!;
const media = message.attachedMedia![0];

const url = await media.getContentTemporaryUrl();
console.log(url); // "https://cdn.sbxcloud.com/attachments/4180.png"

// una segunda llamada no repite la petición de red:
const cached = await media.getContentTemporaryUrl();
console.log(cached === url); // true
```

**Qué esperar.** La URL temporal (`string`) que devuelve `GET /web_chats/:chatId/messages/:messageId/media_url`
(`internal/restApi.ts:128-130`), o `null` si el backend no tiene una URL para ese adjunto. El
resultado se cachea (`Media.ts:26-31`) — incluso un `null` se cachea, así que una vez resuelto no
se vuelve a golpear la red por ese mismo `Media`, aunque la respuesta haya sido "no hay URL".

**Qué puede salir mal.** Si el `GET` subyacente falla (mensaje o chat inexistente, token sin
acceso), rechaza con el formato de error REST habitual:
```
sbx-omnichannel-conversations: GET /web_chats/1/messages/4180/media_url failed (404): <cuerpo>
```
El token usado es el vigente AL MOMENTO de resolver, no el que existía cuando se construyó el
`Message` (`Media.ts:14` lo lee vía una función, no un valor capturado) — así que un
`Client#updateToken()` entre medio no invalida una llamada a `getContentTemporaryUrl()` en curso.
