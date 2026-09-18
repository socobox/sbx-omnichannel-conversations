# `MessageBuilder`

Archivo fuente: `src/MessageBuilder.ts`. Espejo PARCIAL de `@twilio/conversations`' propio
`MessageBuilder`/`UnsentMessage` — solo el subconjunto que el frontend de referencia realmente
usa (`EmailChatInputComponent.tsx`): `setBody`/`addMedia`/`setAttributes`/`build().send()`.
Twilio también soporta `setSubject`, `setEmailBody`, `setEmailHistory` y Content Template SIDs —
ninguno de esos está implementado aquí; llamarlos sería simplemente un método inexistente, igual
que cualquier otra superficie de Twilio no auditada por este paquete.

Se obtiene siempre desde `conversation.prepareMessage()` (ver `conversation.md`), nunca
instanciando la clase directamente — el constructor es `@internal`.

### `setBody(text)`

**Qué hace.** Guarda el texto del mensaje a enviar.

**Cuándo la usas.** Para acompañar un adjunto con un comentario de texto, o para armar un mensaje
de puro texto con la misma API fluida que un adjunto.

**Firma.**
```ts
setBody(text: string): MessageBuilder;
```

**Ejemplo.**
```ts
const builder = conversation.prepareMessage().setBody("Aquí tienes el comprobante");
```

**Qué esperar.** El mismo `MessageBuilder` (encadenable). No dispara red — solo guarda estado
hasta que llames `.build().send()`.

**Qué puede salir mal.** Nada aquí. Ojo: si el mensaje final incluye un adjunto, el texto que
pusiste con `setBody()` se **ignora** — ver la nota en `build().send()` más abajo.

### `setAttributes(attributes)`

**Qué hace.** Guarda los atributos (`JSONValue`) que se adjuntarán al mensaje.

**Cuándo la usas.** Para marcar metadata custom en el momento de crear el mensaje — por ejemplo
una categoría o un flag interno.

**Firma.**
```ts
setAttributes(attributes: JSONValue): MessageBuilder;
```

**Ejemplo.**
```ts
const builder = conversation.prepareMessage()
  .setBody("Mensaje interno")
  .setAttributes({ internal: true });
```

**Qué esperar.** El mismo `MessageBuilder` (encadenable). No dispara red.

**Qué puede salir mal.** Si el mensaje final resulta ser un envío de media, estos atributos **no
se persisten** — ver la nota de `conversation.md#sendMessage` sobre por qué un envío de media
ignora `attributes` (el endpoint de subida compartido de zavu no acepta metadata custom al crear).

### `addMedia(payload)`

**Qué hace.** Agrega un adjunto a la cola de envío del builder.

**Cuándo la usas.** Para adjuntar un archivo (imagen, PDF, etc.) al mensaje que estás armando.

**Firma.**
```ts
addMedia(payload: SendMediaOptions): MessageBuilder;
// SendMediaOptions = { contentType: string | null; media: Blob; filename?: string }
```

**Ejemplo.**
```ts
const file = new Blob([bytes], { type: "application/pdf" });
const builder = conversation.prepareMessage()
  .addMedia({ contentType: "application/pdf", media: file, filename: "factura_4471.pdf" });
```

**Qué esperar.** El mismo `MessageBuilder` (encadenable). No sube nada todavía — la subida real
ocurre en `.build().send()`.

**Qué puede salir mal.** Nada en esta llamada — el límite de un solo adjunto se valida recién en
`.build().send()`, no aquí, así que puedes llamar `addMedia()` varias veces sin que truene de
inmediato.

### `build().send()`

**Qué hace.** Cierra el builder y envía el mensaje: si hay exactamente un adjunto en la cola, lo
sube vía el mismo camino de media de `Conversation#sendMessage`; si no hay ninguno, envía el texto
de `setBody()` como mensaje de texto plano.

**Cuándo la usas.** El paso final, siempre después de al menos un `setBody()`/`addMedia()`.

**Firma.**
```ts
build(): { send: () => Promise<number | null> };
```

**Ejemplo — un adjunto con texto (el texto se ignora):**
```ts
const index = await conversation.prepareMessage()
  .setBody("este texto se ignora porque hay un adjunto")
  .addMedia({ contentType: "image/png", media: new Blob([bytes], { type: "image/png" }), filename: "comprobante.png" })
  .build()
  .send();

console.log(index); // 4181 — el id real del mensaje creado
```

**Ejemplo — solo texto:**
```ts
const index = await conversation.prepareMessage()
  .setBody("Confirmado, gracias por tu paciencia")
  .build()
  .send();
```

**Qué esperar.** El `index` (id de base de datos, ver `message.md`) del mensaje creado — igual
contrato que `Conversation#sendMessage`, porque por debajo es exactamente esa misma llamada
(`MessageBuilder.ts:41-45`). **Con un adjunto en la cola, el `body` de `setBody()` se descarta por
completo** — `MessageBuilder.ts:42` manda el adjunto solo, ignorando `this.bodyText`; es el mismo
comportamiento de "media gana sobre texto" que tiene `Conversation#sendMessage` cuando el `body`
es un objeto de media en vez de un `string`.

**Qué puede salir mal.** Si llamaste `addMedia()` más de una vez, rechaza ANTES de tocar red:
```
sbx-omnichannel-conversations: sending more than one attachment in a single message isn't supported yet — send each as its own message.
```
(`MessageBuilder.ts:37-39`). No es un límite arbitrario de esta librería: el endpoint de subida de
zavu acepta exactamente un archivo por mensaje hoy. El arreglo es literal — mandar cada adjunto
como su propio `prepareMessage()...build().send()`, uno por uno.

Los demás fallos posibles (sin participante registrado, canal que no soporta media, socket
desconectado) son los mismos que documenta `conversation.md#sendMessage`, porque terminan en la
misma llamada.
