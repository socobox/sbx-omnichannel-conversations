# Tipos y catálogos (`types.ts`, `events.ts`, `Message.ts`)

Archivos fuente: `src/types.ts`, `src/events.ts`, y el `MessageType`/`MessageReaction` declarados
en `src/Message.ts`. Ninguno de estos catálogos es un `enum` de TypeScript — todos siguen el mismo
patrón `as const`. Esta página explica el patrón una sola vez; cada catálogo concreto se detalla
abajo.

## El patrón `as const` — y por qué NO son `enum`

Cada catálogo se declara como un objeto congelado por tipo, seguido de un tipo derivado de sus
valores:

```ts
export const ConnectionState = {
  Connecting: "connecting",
  Connected: "connected",
  Disconnecting: "disconnecting",
  Disconnected: "disconnected",
  Denied: "denied",
} as const;
export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];
```

Esto da DOS cosas con el mismo nombre `ConnectionState`: un objeto en runtime
(`ConnectionState.Connected === "connected"`) y un tipo (`ConnectionState` como unión de literales
`"connecting" | "connected" | "disconnecting" | "disconnected" | "denied"`). Puedes usar cualquiera
de los dos según el contexto — como valor (`ConnectionState.Connected`) o como anotación de tipo
(`function f(s: ConnectionState) {}`).

**Por qué no un `enum` de TypeScript.** Un `enum` es un tipo NOMINAL: `ConnectionState.Connected`
sería un valor de un tipo que TypeScript considera distinto de la cadena literal `"connected"`,
aunque en runtime sean el mismo string. Eso rompería exactamente el escenario que este paquete
existe para soportar: alguien migrando desde `@twilio/conversations` (o comparando contra
`sbx-omnichannel-ui/src/types/Chat.ts`, que ya declara sus propios literales `"connected"` etc.)
necesita que comparar `client.connectionState === "connected"` siga siendo válido para TypeScript
sin un cast. Con un `enum`, esa comparación sería un error de tipos: "esta comparación parece no
tener intersección". El objeto `as const` no tiene ese problema — el tipo derivado ES la unión de
los literales reales, así que un string literal siempre es asignable y comparable.

`tests/contract.test.ts` verifica esto en runtime, no solo en el tipo: lee `Object.values(...)` de
cada catálogo y lo compara contra una lista congelada de strings, precisamente porque estos
catálogos son objetos reales en tiempo de ejecución (exportados como valores, no solo como tipos)
que `sbx-omnichannel-ui` importa con una cláusula de import de VALOR
(`ChatBodyMessagesComponent.tsx:2`), no solo de tipo.

## `ConnectionState`

Estado del socket — ver `client.md` para el ciclo de vida completo.

```ts
const ConnectionState = {
  Connecting: "connecting",
  Connected: "connected",
  Disconnecting: "disconnecting",
  Disconnected: "disconnected",
  Denied: "denied",
} as const;
```

## `ClientState`

Estado del OBJETO `Client` (distinto del socket) — `null` hasta que la inicialización se resuelve.

```ts
const ClientState = {
  Initialized: "initialized",
  Failed: "failed",
} as const;
```

Nombrado `ClientState`, no `State`, a propósito — `State` es un nombre común que un consumidor
probablemente ya tiene declarado, y colisionar en el import le costaría un alias sin ningún
beneficio.

## `ConversationUpdateReason`

Las razones que puede traer `updateReasons` en el evento `updated`/`conversationUpdated` — ver la
tabla de disparadores reales en `conversation.md`.

```ts
const ConversationUpdateReason = {
  Attributes: "attributes",
  DateCreated: "dateCreated",
  DateUpdated: "dateUpdated",
  FriendlyName: "friendlyName",
  LastReadMessageIndex: "lastReadMessageIndex",
  LastMessage: "lastMessage",
  State: "state",
  Status: "status",
} as const;
```

`"dateCreated"`, `"dateUpdated"` y `"state"` están declarados por paridad con el catálogo de
Twilio, pero **el código de este paquete nunca los emite hoy**. `"friendlyName"` SÍ se emite desde
2026-09-23 (antes estaba en la misma situación que estos tres) — ver `conversation.md` para
quién lo dispara (`refreshFromRest` en una reconexión, `applyRestChatUpdate` en vivo vía el frame
`chat.updated`). Si tu código espera reaccionar a `"dateCreated"`/`"dateUpdated"`/`"state"`, no vas
a ver ese evento disparado por nada de lo que hace este paquete actualmente.

## `MessageUpdateReason`

Las razones que trae `updateReasons` en `messageUpdated` — distingue una edición de texto de un
cambio de metadata/reacciones (ver `message.md`).

```ts
const MessageUpdateReason = {
  Body: "body",
  Attributes: "attributes",
  DateUpdated: "dateUpdated",
  DeliveryReceipt: "deliveryReceipt",
} as const;
```

Solo `"body"` y `"attributes"` se emiten realmente (`Conversation.ts:131-133`) — el diffing
compara la copia previa contra la nueva y decide cuál de los dos aplica, o `"attributes"` por
defecto si no detecta ningún cambio reconocible. `"dateUpdated"` y `"deliveryReceipt"` están
declarados por paridad con Twilio pero no se emiten en el código actual.

## `MessageType` (declarado en `Message.ts`, no en `types.ts`)

```ts
const MessageType = {
  Text: "text",
  Media: "media",
} as const;
```

Se deriva de si el mensaje tiene `attachedMedia` — ver `message.md`.

## `MessageReaction` (interfaz, no catálogo)

```ts
interface MessageReaction {
  author: string;
  value: string;
  updated_at: string;
}
```

La forma de cada elemento de `message.attributes.reactions` — ver `message.md` para de dónde sale
exactamente ese campo.

## `JSONValue` / `JSONObject` / `JSONArray`

Coinciden exactamente con los tipos propios de `@twilio/conversations` (no un simple
`Record<string, unknown>`), porque algunos call sites del frontend migrado pasan este tipo sin
cast:

```ts
type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
interface JSONObject { [x: string]: JSONValue; }
type JSONArray = JSONValue[];
```

Todo `attributes` de `Conversation`/`Message`/`Participant`, y cualquier método que reciba
`attributes`, está tipado contra `JSONValue` — no contra un objeto genérico.

## `SendMediaOptions` / `SendMessageBody`

Los tipos que aceptan `Conversation#sendMessage`/`MessageBuilder#addMedia` — ver `conversation.md`
y `message-builder.md` para los ejemplos de uso.

```ts
interface SendMediaOptions {
  contentType: string | null;
  media: Blob;
  filename?: string;
}
type SendMessageBody = string | SendMediaOptions;
```
