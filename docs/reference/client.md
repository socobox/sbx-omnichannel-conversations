# `Client`

Archivo fuente: `src/Client.ts`. Espejo de `@twilio/conversations`' propio `Client`: mismo nombre
de clase, mismos eventos, mismo `new Client(token)` como punto de entrada — pero por debajo habla
con el WebSocket/REST propio de SBX Omnichannel (`src/internal/wsTransport.ts`,
`src/internal/restApi.ts`), no con la infraestructura de Twilio.

> **WebSocket** — la conexión persistente y bidireccional que mantiene vivo el estado en tiempo
> real (mensajes nuevos, chats asignados/terminados). `Client` no la maneja directamente: la
> delega en `WsTransport` y traduce sus eventos internos a la superficie pública documentada aquí.
>
> **JWT** — el token que recibes de `POST /agents/:id/login` (alias `/agents/:id/ws_token`). Es el
> mismo que usabas con Twilio; `Client` lo decodifica localmente (sin verificar firma, porque ya
> viene de tu propio backend) para leer dos claims: `agent_id` (quién eres, para el envío de
> media) y `exp` (cuándo expira, para `tokenAboutToExpire`/`tokenExpired`).
>
> **Hidratación** — cargar el contenido completo (`GET /chats/:id`) de cada chat en
> `subscribed_chat_ids` antes de considerar al cliente listo. Es el concepto central de esta
> página — ver la sección siguiente.

## `new Client(token)` vs `Client.create(token)`

Las dos formas de construir un `Client` arrancan la misma conexión y el mismo proceso de
hidratación por debajo. La diferencia es **cuándo devuelven el control al que llama**:

- **`new Client(token)`** devuelve la instancia **de inmediato**, antes de que exista una sola
  conversación cargada. Es el comportamiento histórico (Twilio siempre funcionó así) y sigue
  intacto — nada se rompe si ya lo usas. Pero significa que justo después de construirlo,
  `client.getSubscribedConversations()` puede resolver una lista vacía simplemente porque la red
  todavía no respondió, no porque el agente no tenga chats.
- **`Client.create(token)`** (nuevo en v0.3.0) es `async` y **resuelve solo cuando la hidratación
  inicial ya terminó** — sea con éxito total, parcial (algunos chats fallaron pero al menos uno
  cargó), o rechaza con un `ConnectionError` **terminal** si la hidratación falló del todo o se
  agotó el timeout de 10 segundos (`HYDRATION_TIMEOUT_MS`, `Client.ts:50`). Cuando `create()`
  resuelve, `getSubscribedConversations()` YA tiene la lista completa — sin carreras.

**Concurrencia de la hidratación (desde 2026-09-24).** Cada chat en `subscribed_chat_ids` dispara
su propio `GET /chats/:id` completo (`chat_messages[]`/`participants[]` incluidos). Hasta esta
fecha esto salía TODO a la vez, sin ningún límite — un agente con 100 chats abiertos disparaba 100
requests simultáneos en cada conexión, reconexión, y renovación de token. Reportado desde
sbx-omnichannel-ui (item G, 2026-09-24): riesgo real de saturar el backend, sobre todo si varios
agentes reconectan a la vez tras una caída compartida (la misma clase de "thundering herd" que
`wsTransport.ts`'s propio jitter de reconexión ya mitiga, pero solo para CUÁNDO reconectan, no
para cuánta carga genera cada uno al hacerlo). `syncConversations` ahora corre esos `GET`s con un
tope fijo de 5 a la vez (`HYDRATION_CONCURRENCY`, `Client.ts`) — sigue cargando cada chat, solo que
nunca más de 5 al mismo tiempo. Es una mitigación puramente del lado del cliente: no reduce
CUÁNTOS requests hace, solo cuántos van en paralelo. La solución de fondo (un endpoint de resumen
por agente que evite el `GET` completo por chat en el listado) depende del backend y sigue en
discusión.

En la práctica: si tu código construye el `Client` y de inmediato necesita la lista de
conversaciones (una pantalla de bandeja de entrada, por ejemplo), usa `Client.create()`. Si tu
código construye el `Client` y reacciona a eventos según van llegando (el patrón histórico de
`ChatContext.tsx`, escuchando `connectionStateChanged`), `new Client()` sigue siendo válido —y
desde v0.3.0 ese mismo patrón funciona mejor, porque `"connected"` ya no llega hasta que la
hidratación terminó (ver la tabla de eventos en `README.md`).

### `new Client(token)`

**Qué hace.** Abre la conexión WebSocket, decodifica el JWT para extraer `agent_id`/`exp`, y
arranca la hidratación de las conversaciones suscritas en segundo plano.

**Cuándo la usas.** Reemplazo directo de tu `new Client(token)` de Twilio — en el bootstrap del
contexto de chat (`ChatContext.tsx`), inmediatamente después de llamar `configure()` una sola vez
al inicio de la app.

**Firma.**
```ts
class Client extends TypedEventEmitter<ClientEvents> {
  constructor(token: string);
}
```

**Ejemplo.**
```ts
import { configure, Client, ClientEvent } from "sbx-omnichannel-conversations";

configure({ apiBaseUrl: "https://omnichannel.sbxcloud.com" });

const client = new Client(agentWsToken);

client.on(ClientEvent.ConnectionStateChanged, (state) => {
  if (state !== "connected") return;
  // Desde v0.3.0 esto YA incluye los chats hidratados — antes podía llegar vacío.
  client.getSubscribedConversations().then((page) => {
    console.log(`chats suscritos: ${page.items.length}`);
  });
});
```

**Qué esperar.** Una instancia de `Client` utilizable de inmediato para registrar listeners
(`client.on(...)`), pero cuyo estado (`client.state`) es `null` hasta que la hidratación termine.
Efectos secundarios: abre un socket real, agenda los timers de `tokenAboutToExpire`/`tokenExpired`,
y empieza a emitir `conversationJoined` por cada chat a medida que su `GET /chats/:id` responde.

**Qué puede salir mal.** Si el WebSocket nunca llega a abrir (token rechazado, red caída), no hay
una excepción síncrona — el fallo se reporta vía eventos (`connectionError`, `initFailed`) o, si
nadie los escucha, queda silencioso salvo por el estado interno. Si tu código necesita SABER que
falló para decidir un flujo (mostrar un error de login en vez de una pantalla de carga infinita),
usa `Client.create()` en su lugar, que sí rechaza una promesa.

### `Client.create(token)`

**Qué hace.** Construye un `Client` igual que `new Client()`, pero espera a que la hidratación
inicial termine antes de devolver el control — con éxito total, parcial, o un rechazo si falló del
todo.

**Cuándo la usas.** Cuando necesitas la lista de conversaciones lista en el mismo `await`, sin
escribir un handler de `connectionStateChanged` — por ejemplo al montar una pantalla de bandeja de
entrada que hace `const client = await Client.create(token); const { items } = await client.getSubscribedConversations();`.

**Firma.**
```ts
static async create(token: string): Promise<Client>;
```

**Ejemplo.**
```ts
import { configure, Client, ConnectionError } from "sbx-omnichannel-conversations";

configure({ apiBaseUrl: "https://omnichannel.sbxcloud.com" });

try {
  const client = await Client.create(agentWsToken);
  const { items: conversations } = await client.getSubscribedConversations();
  console.log(`agente listo con ${conversations.length} conversaciones`);
} catch (error) {
  if (error instanceof ConnectionError && error.terminal) {
    // Ningún chat cargó, o se agotaron los 10s de HYDRATION_TIMEOUT_MS.
    showLoginError(error.message);
  }
}
```

**Qué esperar.** Una `Promise<Client>` que resuelve con `client.connectionState === "connected"` y
`client.state === "initialized"`, y donde `getSubscribedConversations()` ya devuelve la lista
completa — sin esperar nada más. Si la hidratación fue **parcial** (algún `GET /chats/:id` falló
pero al menos uno cargó), la promesa **igual resuelve** (no rechaza) y por separado se emite un
`connectionError` no terminal reportando cuántos fallaron — ver `Client.ts:195-208`.

**Qué puede salir mal.** Rechaza con un `ConnectionError` en dos casos:
- **Timeout total**: ningún `GET /chats/:id` respondió dentro de los 10 segundos de
  `HYDRATION_TIMEOUT_MS` — mensaje `"sbx-omnichannel-conversations: loading the subscribed
  conversations timed out after 10000ms"` (`Client.ts:187`).
- **Fallo total**: TODOS los `GET /chats/:id` de la hidratación inicial fallaron — mensaje
  `"sbx-omnichannel-conversations: failed to load N of N subscribed conversations: <primer error>"`
  (`Client.ts:200`).

En ambos casos el `Client` interno ya quedó apagado (`client.shutdown()` se llama automáticamente
dentro de `create()`, `Client.ts:106`) — no reutilices la instancia que capturaste en el
`catch`, simplemente reintenta `Client.create()` con un token válido.

Si en cambio llamas `client.shutdown()` tú mismo mientras `create()` sigue esperando, la promesa
rechaza con `"sbx-omnichannel-conversations: the client was shut down before it finished
initializing"` (`Client.ts:372-375`) — es el mismo mecanismo, expuesto para el caso de un
componente que se desmonta a medio arranque.

## Propiedades

### `client.connectionState`

**Qué hace.** Expone el estado actual del socket, de forma síncrona.

**Cuándo la usas.** Al montar un componente que necesita pintar el estado de conexión sin esperar
al próximo evento — por ejemplo un indicador "conectando…"/"desconectado" que se muestra desde el
primer render, antes de que se dispare ningún `connectionStateChanged`.

**Firma.**
```ts
get connectionState(): ConnectionState; // "connecting" | "connected" | "disconnecting" | "disconnected" | "denied"
```

**Ejemplo.**
```ts
const client = new Client(agentWsToken);
console.log(client.connectionState); // "connecting" — recién construido, socket aún abriendo
```

**Qué esperar.** Uno de los cinco valores de `ConnectionState` (ver `types.md`). No dispara red ni
efectos secundarios — es una simple lectura.

**Qué puede salir mal.** Nada lanza aquí. El error común es asumir que `"connected"` implica
"conversaciones ya cargadas" ANTES de v0.3.0 — desde esta versión sí lo implica, porque
`"connected"` se emite después de hidratar (ver `README.md`).

### `client.state`

**Qué hace.** Expone el estado del OBJETO `Client` (distinto del socket): `null` hasta que la
inicialización se resuelve, luego `"initialized"` o `"failed"`.

**Cuándo la usas.** Para distinguir "todavía inicializando" de "inicialización terminó, con éxito
o sin él" — útil en una guardia que decide si renderizar la bandeja de entrada o una pantalla de
error, en vez de fiarte solo de `connectionState`.

**Firma.**
```ts
get state(): ClientState | null; // null | "initialized" | "failed"
```

**Ejemplo.**
```ts
const client = new Client(agentWsToken);
console.log(client.state); // null

await new Promise((resolve) => client.on("stateChanged", resolve));
console.log(client.state); // "initialized" (o "failed")
```

**Qué esperar.** `null`, `"initialized"` o `"failed"`. `"failed"` -> `"initialized"` SÍ es una
transición posible (un cliente que falló se recupera vía `updateToken(freshToken)`,
`Client.ts:295-301`) — pero la promesa de `Client.create()` original ya quedó rechazada para
siempre; lo que se recupera es el objeto, no esa promesa puntual.

**Qué puede salir mal.** Nada lanza. El error común es leer `state` inmediatamente después de
`new Client()` esperando `"initialized"` — todavía es `null`, hay que esperar `stateChanged`,
`initialized`/`initFailed`, o usar `Client.create()`.

## Métodos

### `getSubscribedConversations()`

**Qué hace.** Devuelve un `Paginator` con todas las conversaciones actualmente suscritas y
cacheadas en este `Client`.

**Cuándo la usas.** Al pintar la lista de chats de un agente — el análogo a
`(await client.getSubscribedConversations()).items` que ya usa el frontend de referencia.

**Firma.**
```ts
async getSubscribedConversations(): Promise<Paginator<Conversation>>;
```

**Ejemplo.**
```ts
const client = await Client.create(agentWsToken);
const page = await client.getSubscribedConversations();
console.log(page.items.map((c) => c.sid)); // ["CH-a83f1", "CH-2b19c"]
console.log(page.hasNextPage); // false — no hay paginación real en el backend, ver paginator.md
```

**Qué esperar.** Un `Paginator<Conversation>` de una sola página (`hasNextPage`/`hasPrevPage`
siempre `false`): el servidor manda el set completo de `subscribed_chat_ids` en un solo mensaje
`connected`, así que no existe paginación real de este lado (`Client.ts:336-344`).

**Qué puede salir mal.** No lanza — si aún no hidrataste nada, devuelve una página vacía
(`items: []`), no un error. Si esperabas datos y ves `[]`, casi siempre es una carrera: llamaste
esto justo después de `new Client()` sin esperar la hidratación. Usa `Client.create()` o espera
`conversationJoined`/`initialized` primero.

### `getConversationBySid(sid)`

**Qué hace.** Devuelve la `Conversation` con ese `sid`, sirviéndola desde caché si ya está unida, o
pidiéndola por red si no.

**Cuándo la usas.** Cuando navegas directo a un chat por su identificador — por ejemplo un enlace
profundo `/chats/CH-a83f1` que abre esa conversación sin pasar antes por la lista.

**Firma.**
```ts
async getConversationBySid(sid: string): Promise<Conversation>;
```

**Ejemplo.**
```ts
const conversation = await client.getConversationBySid("CH-a83f1");
console.log(conversation.friendlyName); // "Ada Rodriguez"
```

**Qué esperar.** La `Conversation`, cacheada para llamadas futuras. El `GET /chats/:id` del
backend resuelve por id numérico, `conversation_sid`, O `custom_id` en una sola consulta
(`internal/restApi.ts:66-69`) — puedes pasar cualquiera de los tres y funciona igual.

**Qué puede salir mal.** Si el chat no existe (o el token no tiene acceso), la petición REST
subyacente rechaza con:
```
sbx-omnichannel-conversations: GET /chats/CH-a83f1 failed (404): <cuerpo de la respuesta>
```
(`internal/restApi.ts:85-88`) — mismo patrón que cualquier otro fallo REST de este paquete: el
mensaje incluye el método, el path y el código HTTP real.

### `updateToken(token)`

**Qué hace.** Reemplaza el token de sesión activo: reconecta el WebSocket con el nuevo, y
reprograma los timers de `tokenAboutToExpire`/`tokenExpired` según el nuevo `exp`.

**Cuándo la usas.** Cuando tu backend te da un token refrescado antes de que expire el actual —
normalmente en el propio handler de `tokenAboutToExpire`.

**Firma.**
```ts
async updateToken(token: string): Promise<void>;
```

**Ejemplo.**
```ts
client.on("tokenAboutToExpire", async () => {
  const freshToken = await fetchFreshAgentToken();
  await client.updateToken(freshToken);
});
```

**Qué esperar.** No devuelve nada útil (`Promise<void>`); el efecto es enteramente asíncrono: el
socket viejo se cierra, uno nuevo se abre con el token actualizado
(`internal/wsTransport.ts:218-238`), y `agent_id` se re-decodifica del nuevo JWT por si cambió.

**Qué puede salir mal.** No lanza directamente — cualquier problema de conexión con el nuevo token
se reporta después, vía los eventos normales (`connectionError`, `connectionStateChanged`), no
como un rechazo de esta llamada.

### `shutdown()`

**Qué hace.** Cierra el socket para siempre, cancela los timers de expiración, y quita todos los
listeners registrados en este `Client`.

**Cuándo la usas.** Al desmontar el contexto de chat (logout, cierre de sesión, o el componente que
posee el `Client` se destruye) — para no dejar un socket abierto reconectando indefinidamente en
segundo plano.

**Firma.**
```ts
shutdown(): void;
```

**Ejemplo.**
```ts
useEffect(() => {
  const client = new Client(agentWsToken);
  return () => client.shutdown();
}, [agentWsToken]);
```

**Qué esperar.** Ningún valor de retorno. Si `Client.create()` seguía pendiente cuando llamas
esto, esa promesa rechaza (ver la sección de `Client.create()` arriba) en vez de quedar colgada
para siempre. Después de `shutdown()`, la instancia queda inservible — no la reutilices ni la
reconstruyas, crea un `Client` nuevo si necesitas reconectar.

**Qué puede salir mal.** Nada lanza. El error común es llamar `shutdown()` y esperar que el
objeto se pueda "revivir" con `updateToken()` — no es así: `disposed` queda marcado para siempre
en el transporte interno (`internal/wsTransport.ts:76-80`) y cualquier llamada posterior a
`updateToken()` es un no-op silencioso.
