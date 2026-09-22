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

**Qué esperar (actualizado 2026-09-22).** Estos atributos SÍ se persisten en un envío de media —
antes era un gap real y documentado (el endpoint de subida compartido de zavu no aceptaba metadata
custom al crear el mensaje); ya se corrigió tanto en el backend (`recordMessage` ahora acepta
`attributes`) como en esta librería (`RestApi#sendMedia` los manda como un campo `attributes`
JSON-codificado del multipart, ya que un form no tiene un tipo de campo objeto anidado nativo).

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
ocurre en `.build().send()`. Podés llamar `addMedia()` varias veces (desde 2026-09-22): todos los
adjuntos en la cola se mandan juntos, como UN solo mensaje con varios attachments — antes esto
rechazaba en `.build().send()` (ver más abajo).

**Qué puede salir mal.** Nada en esta llamada.

### `build().send()`

**Qué hace.** Cierra el builder y envía el mensaje: si hay uno o más adjuntos en la cola, los sube
TODOS juntos (un solo mensaje, varios attachments — desde 2026-09-22) vía el mismo camino de media
de `Conversation#sendMessage`; si no hay ninguno, envía el texto de `setBody()` como mensaje de
texto plano.

**Cuándo la usas.** El paso final, siempre después de al menos un `setBody()`/`addMedia()`.

**Firma.**
```ts
build(): { send: () => Promise<number | null> };
```

**Ejemplo — un adjunto con texto (el texto se ignora — ver la nota abajo):**
```ts
const index = await conversation.prepareMessage()
  .setBody("este texto se ignora porque hay un adjunto")
  .addMedia({ contentType: "image/png", media: new Blob([bytes], { type: "image/png" }), filename: "comprobante.png" })
  .build()
  .send();

console.log(index); // 4181 — el id real del mensaje creado
```

**Ejemplo — varios adjuntos en un solo mensaje (desde 2026-09-22):**
```ts
const index = await conversation.prepareMessage()
  .addMedia({ contentType: "image/png", media: fotoFrente, filename: "frente.png" })
  .addMedia({ contentType: "image/png", media: fotoDorso, filename: "dorso.png" })
  .setAttributes({ document_type: "cedula" })
  .build()
  .send();
```

**Ejemplo — solo texto:**
```ts
const index = await conversation.prepareMessage()
  .setBody("Confirmado, gracias por tu paciencia")
  .build()
  .send();
```

**Qué esperar.** El `index` (id de base de datos, ver `message.md`) del mensaje creado — igual
contrato que `Conversation#sendMessage`, porque por debajo es exactamente esa misma llamada. Con
uno o más adjuntos en la cola, TODOS se mandan juntos como attachments del mismo mensaje.

**Gap conocido, todavía sin corregir:** con un adjunto en la cola, el `body` de `setBody()` se
sigue descartando por completo (`MessageBuilder.ts`'s `build().send()` nunca pasa `this.bodyText`
al camino de media) — es decir, hoy no hay forma de mandar un texto/caption junto con un adjunto a
través de esta clase. `setAttributes()` sí llega (ver arriba); un caption de texto, no. Si tu caso
de uso necesita esto, repórtalo — no está armado deliberadamente así, es un gap real encontrado al
revisar este archivo, no una decisión de producto.

**Qué puede salir mal.** Los fallos posibles (sin participante registrado, subida fallida, socket
desconectado) son los mismos que documenta `conversation.md#sendMessage`, porque terminan en la
misma llamada.
