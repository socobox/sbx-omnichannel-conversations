# `Media`

Archivo fuente: `src/Media.ts`. Espejo de `@twilio/conversations`' propio `Media` — un archivo
adjunto a un `Message`. `getContentTemporaryUrl()` resuelve de forma perezosa (una llamada de red
real, igual que en Twilio), nunca por adelantado para todos los mensajes de un chat.

## `Media.filename` siempre llega `null` en adjuntos entrantes

Esto sorprende porque el tipo dice `string | null`, sugiriendo que a veces trae el nombre real del
archivo — en la práctica, para cualquier adjunto que llega dentro de un `Message` ya existente,
**siempre es `null`**.

La causa está en cómo `Message.ts` construye el `Media` de un mensaje entrante:

```ts
// Message.ts:52-61
this.attachedMedia = raw.media
  ? [
      new Media({
        chatId: raw.chat_id,
        messageId: raw.id,
        contentType: raw.media_type ?? "application/octet-stream",
        getToken: () => conversation.currentToken,
        // <- no se pasa `filename` aquí
      }),
    ]
  : null;
```

El constructor de `Media` (`Media.ts:18-24`) sí acepta un `filename` opcional
(`opts.filename ?? null`), pero **nadie se lo pasa** cuando se construye a partir de un mensaje ya
recibido: la fila cruda del backend (`RestChatMessage`, `internal/restApi.ts:20-33`) no trae un
campo de nombre de archivo para el adjunto — solo `media` (la clave/URL interna) y `media_type`
(el content type). No hay un nombre de archivo original que leer del lado del backend para un
adjunto entrante, así que `Media.filename` queda `null` siempre en ese camino.

La única vez que un `filename` real sí viaja es en el **envío** de un adjunto —
`Conversation#sendMessage`/`MessageBuilder#addMedia` sí aceptan y mandan `filename` al backend
(`internal/restApi.ts:139-149`) — pero eso queda en la fila creada, no reaparece automáticamente
como `Media.filename` del lado de lectura salvo que el objeto `RestChatMessage` que vuelva por el
eco se re-mapee con esa información (hoy no ocurre).

**Práctico:** si necesitas mostrar un nombre de archivo en la UI para un adjunto recibido, no
puede salir de `message.attachedMedia[0].filename` — vas a necesitar derivarlo de otra fuente
(la URL, el `contentType`, o un nombre genérico), porque este campo no lo trae.

## Propiedades

| Propiedad | Tipo | Notas |
|---|---|---|
| `contentType` | `string` | Del `media_type` del mensaje, o `"application/octet-stream"` si viene vacío. |
| `filename` | `string \| null` | Ver la sección de arriba — `null` en todo adjunto entrante. |

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
