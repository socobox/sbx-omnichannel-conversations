# `Message`

Archivo fuente: `src/Message.ts`. Espejo de `@twilio/conversations`' propio `Message` — un mensaje
dentro de una `Conversation`.

## `Message.index` NO es una posición de array — es el id de la fila en base de datos

Esto es lo que más confunde de esta clase, así que va primero y con ejemplo real.

En Twilio, `index` era una secuencia POR CONVERSACIÓN que arrancaba en 0: el primer mensaje de un
chat era `index: 0`, el segundo `index: 1`, etc. Este paquete **no tiene ese concepto** — zavu no
guarda un contador por chat, así que `Message.ts:39` asigna `this.index = raw.id`, el id real de
la fila `chat_messages` en la base de datos:

```ts
this.index = raw.id; // Message.ts:39 — el id de la fila, no una posición
```

Ese id es **global a todos los chats del tenant**, no por conversación. Si pides los mensajes de un
chat con pocos mensajes intercalados entre la actividad de otros chats, vas a ver algo así:

```ts
const page = await conversation.getMessages();
console.log(page.items.map((m) => m.index));
// [4102, 4109, 4180]
```

Tres mensajes, con huecos de 7 y 71 entre ellos — esos huecos son mensajes de OTROS chats que se
insertaron en el medio, no mensajes borrados de este chat. Dos consecuencias prácticas:

1. **Restar dos índices no cuenta mensajes.** `4180 - 4102 = 78`, y este chat tiene 3 mensajes, no
   78. Es exactamente el error que corrigió `setAllMessagesUnread()`/`getUnreadMessagesCount()` en
   v0.3.0 — ver `conversation.md`.
2. **`index` sigue sirviendo para ordenar y comparar** (es estrictamente creciente), que es todo lo
   que cualquier llamador real necesita — solo no lo trates como "posición N en esta conversación".

## Propiedades

| Propiedad | Tipo | Notas |
|---|---|---|
| `sid` | `string` | `raw.sid`, o el `id` como `string` si `sid` es `null`. |
| `index` | `number` | El id de fila de base de datos — ver la sección de arriba. |
| `body` | `string \| null` | Texto del mensaje. `null` en un mensaje puramente de adjunto. |
| `author` | `string \| null` | La `identity` del participante que lo mandó — resuelta sin red, ver `Conversation#participantIdentity`. |
| `attributes` | `JSONValue` | El contenido REAL de `metadata` del mensaje + `reactions` como campo hermano — ver nota abajo sobre `custom_metadata`. |
| `dateCreated` / `dateUpdated` | `Date` | — |
| `conversation` | `Conversation` | La conversación dueña de este mensaje. |
| `attachedMedia` | `Media[] \| null` | `null` si no hay adjunto; si lo hay, un array de **un solo** `Media` — zavu no soporta múltiples adjuntos por mensaje hoy. |
| `type` | `MessageType` | `"text"` o `"media"`, derivado de si hay `attachedMedia`. |
| `media` | `Media \| null` | **Deprecated** — alias de `attachedMedia?.[0]`, mantenido por paridad con el getter deprecado de Twilio. |

### Ejemplo — leyendo un mensaje con reacción

```ts
const page = await conversation.getMessages();
const message = page.items.find((m) => m.index === 4180)!;

console.log(message.body); // "Perfecto, muchas gracias"
console.log(message.author); // "customer_4471"
console.log(message.attributes);
// { reactions: [{ author: "agent_182", value: "👍", updated_at: "2026-09-10T14:02:11.000Z" }] }
```

Nota sobre `attributes.reactions`: el backend manda `reactions` como un campo HERMANO de
`metadata` en la fila cruda (`internal/restApi.ts:16-19`, `RestChatMessage`), no anidado dentro.
El constructor de `Message` lo eleva al nivel superior de `attributes` para que
`message.attributes.reactions` funcione tal como un componente ya lo espera.

Nota sobre `metadata.custom_metadata`: el serializador de zavu (`toChatMessagePublic`, puerto fiel
de `ChatMessageSerializer` de Rails) envuelve el `metadata` realmente guardado un nivel más
adentro, bajo su propia clave `custom_metadata` — es decir, `metadata` en la fila cruda es
`{ ...stored, custom_metadata: stored }`. `attributes` se construye a partir del CONTENIDO de esa
clave anidada (no del nivel superior), porque es la única copia que sigue siendo fiel a lo último
que se escribió — ver el comentario en `Message.ts` (constructor) para el porqué exacto. Para un
mensaje que nunca fue editado, `stored` es `{}`, así que `attributes` queda en `{}` (más
`reactions`).

## Métodos

### `updateBody(body)`

**Qué hace.** Persiste una edición del texto del mensaje en el backend, y resuelve cuando el eco
`message.updated` confirma el cambio.

**Cuándo la usas.** Un agente corrige un mensaje de texto que ya envió, en un chat cuyo `client`
sea `"web"` — capacidad genuinamente nueva, sin equivalente real en Twilio (su propio
`updateBody()` nunca era durable, solo vivía en la sesión de Twilio).

**Firma.**
```ts
async updateBody(body: string): Promise<Message>;
```

**Ejemplo.**
```ts
const message = page.items.find((m) => m.index === 4180)!;
const updated = await message.updateBody("Perfecto, muchísimas gracias");
console.log(updated.body); // "Perfecto, muchísimas gracias"
```

**Qué esperar.** Una nueva instancia de `Message` con el `body` actualizado, una vez que el
`message.updated` correspondiente vuelve por el WebSocket (`Message.ts:72-75`,
`Conversation#awaitMessageUpdate`). No hay confirmación más rápida que esa — no existe ack
síncrono en el protocolo.

**Qué puede salir mal.** Si el chat no es `client === 'web'`, el backend rechaza con **422**, que
llega como:
```
sbx-omnichannel-conversations: PUT /web_chats/1/messages/4180 failed (422): <cuerpo>
```
La causa es que ese mensaje ya salió por un canal externo (WhatsApp, SMS, email, Instagram) y no
se puede editar retroactivamente ahí — es una limitación real del canal, no un bug de este
paquete.

### `updateAttributes(attributes)`

**Qué hace.** Fusiona (merge, no reemplaza) los atributos dados dentro de `metadata` del mensaje,
server-side.

**Cuándo la usas.** Para adjuntar metadata custom a un mensaje ya existente — funciona en
CUALQUIER canal, a diferencia de `updateBody`.

**Firma.**
```ts
async updateAttributes(attributes: JSONValue): Promise<Message>;
```

**Ejemplo.**
```ts
const updated = await message.updateAttributes({ flagged: true, reviewedBy: "agent_182" });
console.log(updated.attributes); // { ...lo que ya había, flagged: true, reviewedBy: "agent_182" }
```

**Qué esperar.** Igual que `updateBody`: una nueva instancia de `Message`, resuelta cuando el eco
`message.updated` llega. El merge es server-side (`web_chat.repo.ts#updateMessage` en zavu) — lo
que ya tenías en `metadata` no se pierde, solo se le agregan/sobrescriben las claves que mandaste.

**El merge es superficial (shallow), no profundo.** Solo se preservan las claves de PRIMER NIVEL
que no mandaste — si mandas `{ custom_metadata: { foo: 1 } }` y ya existía
`custom_metadata: { bar: 2 }`, el resultado es `custom_metadata: { foo: 1 }` (pierde `bar`), NO
`{ foo: 1, bar: 2 }`. Esto importa para cualquier feature que acumule datos dentro de una sola
clave anidada (p. ej. un historial de ediciones bajo `custom_metadata.update_history`): cada
llamada a `updateAttributes` debe mandar el objeto COMPLETO y ya acumulado bajo esa clave, leyendo
primero `message.attributes` — nunca asumir que el backend lo acumula por ti.

**Qué puede salir mal.** Este método sí funciona para todos los canales — no tiene la restricción
`client === 'web'` de `updateBody`. Cualquier falla que veas aquí es un error REST genérico
(token inválido, chat inexistente), no una restricción de canal.
