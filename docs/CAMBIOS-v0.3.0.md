# Cambios de la v0.3.0

Documento para revisar el PR. Dice qué cambia, qué evidencia hay, qué riesgo tiene cada cosa, y
**qué decidimos NO cambiar y por qué**.

---

## El problema que originó todo

`new Client(token)` devuelve un objeto al instante, pero ese objeto todavía no sabe nada: acaba de
abrir un socket y las conversaciones no están cargadas. La secuencia real era:

```
t=0ms     new Client(token) retorna, vacío por dentro
t≈50ms    conecta el socket; el servidor manda la lista de chats
t≈50ms    se emite connectionStateChanged("connected")
          ↑ AQUÍ el consumidor preguntaba cuántas conversaciones había: CERO
t≈51ms    recién ahora salen las peticiones de cada chat, sin que nadie las espere
t≈300ms   llegan y se emite conversationJoined
```

En `sbx-omnichannel-ui`, `ChatContext.tsx:271-281` hace exactamente esa pregunta en ese momento.
Recibía siempre `0`, marcaba la UI como montada antes de tiempo, y de ahí el parpadeo de lista
vacía al arrancar. El `setTimeout(300)` de la línea 266 era un parche del síntoma.

**No había ninguna forma de escribir «espera a que el cliente esté listo».**

---

## Qué cambia

### Lo nuevo, todo aditivo

| Qué | Para qué |
|---|---|
| `Client.create(token)` | Fábrica asíncrona que resuelve cuando las conversaciones ya están cargadas |
| `client.connectionState` | Getter síncrono: quien se suscribe tarde puede leer el estado actual |
| `client.state` | Ciclo de vida del objeto (`initialized` / `failed`), distinto del socket |
| `connectionError` | Los errores del servidor ya no mueren en un `console.warn` |
| `stateChanged`, `initialized`, `initFailed` | Ciclo de vida, con los nombres reales de Twilio |
| `ConnectionError`, `SendTimeoutError` | Errores tipados, filtrables por separado en Sentry |
| Catálogos `as const` | Los strings de eventos, estados y protocolo dejan de estar sueltos |

**`new Client(token)` sigue funcionando exactamente igual.** Nada de lo anterior se rompe.

### Correcciones de comportamiento

1. **`connectionStateChanged("connected")` se emite después de hidratar.** Es el único cambio
   observable del release, y es el que arregla el bug de arriba **incluso sin que el consumidor
   migre a `create()`**.
2. **Al reconectar se vuelve a pedir cada chat**, aplicándolo sobre la misma instancia. Antes los
   mensajes llegados durante un corte se perdían hasta recargar.
3. **Los envíos ya no cuelgan.** Rechazan al caer el socket, al rotar token y al apagar.
4. **El acuse se correlaciona por texto y participante.** Antes cualquier mensaje entrante
   resolvía el envío del agente con el id del cliente.
5. **La rotación de token ya no duplica sockets.** El cierre tardío del socket viejo agendaba una
   reconexión encima de la sana, dejando uno huérfano que procesaba cada frame dos veces.
6. **El backoff escala de verdad.** Se reiniciaba con la apertura del socket, así que un servidor
   que aceptaba y cerraba enseguida lo dejaba clavado en un segundo para siempre.
7. **`conversationLeft` se emite** por primera vez, con la instancia cacheada.
8. **Los no leídos se cuentan de verdad**, y marcar como leído avisa.
9. **Un `throw` al abrir el socket ya no mata la reconexión para siempre.** `open()`
   (`src/internal/wsTransport.ts`) construye `new WebSocket(...)` y registra sus listeners dentro
   de un `try/catch`. Antes, cualquier excepción ahí — el constructor lanzando, un listener
   rompiendo el registro — dejaba `reconnectTimer` sin programar y el estado clavado en
   `"connecting"`, sin ningún indicio de que el transporte había dejado de intentarlo. Un
   consumidor (el banner de conexión de `sbx-omnichannel-ui`) mostraría "reconectando" congelado
   para siempre. Ahora el catch llama a `scheduleReconnect()` igual que un `close` normal.
   Test: `tests/transport.test.ts:241`.
10. **El backoff de reconexión suma jitter (±30%).** Antes de este release, todos los clientes
    reconectando tras un mismo corte (una caída de wifi de oficina, un deploy de backend) golpeaban
    `/chats/:id` en el mismo segundo exacto. `RECONNECT_JITTER = 0.3` en `wsTransport.ts` dispersa
    ese reintento. **Sin test dedicado**: no hay ninguna aserción en `tests/transport.test.ts` que
    fije el rango del jitter — a diferencia de todo lo demás en este documento, este punto no está
    verificado por mutación. Queda anotado como hueco de cobertura conocido, no como bug.
11. **`getConversationBySid()` ya no puede construir una URL rota.** `RestApi.getChat()` resuelve
    por id numérico, `conversation_sid` o `custom_id` (comentario en `src/internal/restApi.ts`), y
    `getConversationBySid(sid)` le pasa el `sid` tal cual. Un `custom_id` con `/`, `?` o `#`
    generaba una ruta REST distinta de la pedida. Las rutas ahora viven centralizadas en un objeto
    `paths` (mismo archivo) y `paths.chat()` aplica `encodeURIComponent`. Sin test dedicado
    tampoco — es una corrección defensiva, no un bug reproducido con evidencia de producción.

---

## Evidencia

57 tests, 0 fallos, 156 expect() calls, en 5 archivos (`client.test.ts`, `contract.test.ts`,
`readiness.test.ts`, `transport.test.ts`, `unread.test.ts`). Los 18 originales pasan **sin
tocarse**, salvo la misma única aserción ya documentada más abajo.

Todo lo que se afirma aquí está verificado **por mutación**, no solo porque los tests pasen: se
rompió a propósito cada cosa que los tests dicen proteger, y se confirmó que fallan. Eso incluye
reintroducir el bug original —confirmar la conexión antes de hidratar—, que hace fallar cuatro
tests.

Durante ese proceso se encontraron tres agujeros reales de cobertura, ya cerrados:

- Congelar los nombres de eventos leyendo la interfaz no impedía que el **valor** del catálogo
  cambiara. Ahora se afirman las dos representaciones contra la misma lista.
- Un test comprobaba que el contador de reintentos crecía, lo cual seguía siendo cierto si el
  reinicio desaparecía por completo. Se añadió el test complementario.
- Una espera sin límite podía **colgar** la suite en vez de fallarla. Todas las esperas están
  acotadas.
- El fix de `open()` (try/catch) y la corrección de `getConversationBySid()` (encode de rutas)
  tienen o no tienen test dedicado — ver los puntos 9 y 11 de "Correcciones de comportamiento". El
  jitter de reconexión (punto 10) es el único cambio de comportamiento de este release que no está
  verificado por mutación; queda pendiente para quien tome el PR después.

---

## Registro de riesgo

El código actual funciona en producción, y esa es precisamente la razón para tener cuidado: el
consumidor se adaptó a él.

| Cambio | Riesgo | Por qué se acepta |
|---|---|---|
| API nueva | Bajo | Puramente aditiva. Se usó `ClientState` y no `State` para no chocar con el enum propio del consumidor |
| `connected` tras hidratar | Medio | Hidratación tolerante (`allSettled`) y acotada a 10 s: un chat que falle no impide arrancar, y uno colgado no deja la pantalla de carga infinita |
| Re-hidratar al reconectar | Medio | Se muta la instancia existente. Reemplazarla rompería el filtrado por identidad de `ChatContext.tsx:414` |
| `conversationLeft` real | Medio-alto | Se emite la instancia cacheada, con un test que lo afirma por identidad |
| Envíos que rechazan | Medio | El síntoma en pantalla es el mismo que hoy (botón trabado), más un error diagnosticable |
| `open()` con try/catch | Bajo | Solo cambia el camino de error (throw síncrono al construir el socket); el camino feliz es idéntico. Test dedicado que reproduce el throw y confirma que `scheduleReconnect()` sigue corriendo |
| Jitter de reconexión (±30%) | Bajo-medio | Dispersa el reintento tras un corte compartido; sin test que fije el rango — si el jitter se rompiera silenciosamente, nada lo detectaría hoy |

### Qué NO entra, a propósito

**Emitir `"denied"`** y **emitir `"disconnected"` en el primer reintento**. Las dos parecen
limpieza inofensiva y las dos habrían causado una regresión peor que el bug que arreglan.

La cadena, verificada línea por línea en el consumidor:

1. `src/types/Chat.ts:41-47` declara `DISCONNECTING` y `DISCONNECTED` como valores distintos.
2. `ChatContext.tsx:265-268`: **todo** cambio de estado se copia a `chatStatus`.
3. `ChatContext.tsx:539`: si `chatStatus` es `DENIED` o `DISCONNECTED`, se apaga y se descarta el
   cliente. **`"disconnecting"` no está en esa lista** — por eso hoy un micro-corte se reconecta
   en silencio.
4. El efecto de arranque tiene `chatStatus` entre sus dependencias, así que al cambiar vuelve a
   correr y construye un cliente nuevo.

Emitir `"disconnected"` en el primer reintento haría que **cada micro-corte destruya y reconstruya
el cliente entero**, perdiendo el backoff: el cliente nuevo arranca en cero intentos. Ante un
backend caído sería recreación continua en vez de reintentos cada quince segundos.

Emitir `"denied"` es peor: `DENIED` **sí** está en la lista, así que un token inválido daría
teardown → cliente nuevo con el mismo token inválido → bucle infinito sin backoff.

Ambos se mueven a la 0.4.0, **después** de que el consumidor deje de disparar teardown desde un
string de estado transitorio. Es el único caso de todo el plan donde el orden correcto es
consumidor primero, librería después.

---

## Para el equipo: dos ramas de código que nunca se ejecutaron

Encontradas al revisar, **sin tocar**. Conviene que alguien decida qué hacer con ellas.

**`ChatStatus.DENIED` nunca corrió en producción.** El enum del consumidor declara los cinco
estados, pero la librería jamás emitió `"denied"`. La rama de teardown de `ChatContext.tsx:539`
que reacciona a él no se ha ejecutado nunca. Se escribió para el comportamiento de Twilio, que sí
lo emitía, y se arrastró en la migración sin validarse.

**`updateReasons.includes("lastReadMessageIndex")` en `ChatContext.tsx:359` tampoco.** La librería
solo emitía dos motivos, y ése no era uno. **Esta rama sí se activa con la v0.3.0**: era el
handler correcto esperando un evento que nunca llegaba, y es lo que va a limpiar el badge de no
leídos.

---

## El cambio de retorno que rompió un test

`setAllMessagesUnread()` devolvía `lastMessage.index + 1`. Como ese índice es un identificador de
base de datos, el valor era un id con un uno sumado — nunca fue un conteo. Para un chat con dos
mensajes devolvía algo como `4188`.

Ahora devuelve el conteo real. El contrato de Twilio dice «the resulting unread count», así que
dos mensajes marcados como no leídos son `2`.

Fue necesario cambiar una aserción de `tests/client.test.ts`, la única de todo el release. Se
documentó en el propio test. **Impacto en el consumidor: cero** — el único sitio que lo llama
(`ChatItemMenuComponent.tsx:56`) descarta el valor de retorno.

---

## Nota sobre `.idea/`

4 archivos de configuración de WebStorm (`.idea/.gitignore`, `.idea/modules.xml`,
`.idea/sbx-omnichannel-conversations.iml`, `.idea/vcs.xml`) habían quedado `git add`-eados por
accidente en una sesión anterior. Ya se sacaron del staging y `.idea/` se agregó a `.gitignore`
(commit `chore(node)`) para que no vuelva a pasar — no requieren ninguna acción antes de abrir
el PR.

---

## Despliegue

1. Publicar como `0.3.0-beta.0` con `npm publish --tag beta`. Al ser `0.x`, un rango con caret no
   sube solo; el dist-tag es la segunda barrera.
2. El consumidor lo fija **exacto**, sin caret, en una rama. Deploy a staging.
3. Probar a mano: cortar el wifi diez segundos con un chat abierto, rotar el token, enviar con
   el backend pausado, reasignar un chat desde el backoffice.
4. Canary con dos o tres agentes reales durante 48 horas. Solo después, `0.3.0` estable.

### Qué observar en producción

| Señal | Baseline | Alerta |
|---|---|---|
| Montajes de `ConversationsClient` por sesión | ~1 | p95 > 3 |
| Frecuencia de `chatStatus === 'disconnected'` | casi cero | cualquier valor no trivial |
| Peticiones a `/chats/:id` tras reiniciar el backend | — | picos correlacionados con caídas |
| `SendTimeoutError` no capturados | no-cero desde el día 1 | que crezca |
| p95 hasta el primer `connected` | — | > 3 s |

### Rollback

**Fijar `"0.2.0"` y desplegar el frontend basta.** Tiempo de recuperación igual al tiempo de
deploy, sin coordinación con backend ni ventana de mantenimiento.

Por qué es seguro, verificado: no hay `localStorage` ni `sessionStorage` en el contexto del chat;
todo el estado del cliente es en memoria; y **ningún cambio toca el protocolo del socket ni el
esquema REST**, así que clientes 0.2.0 y 0.3.0 pueden convivir contra el mismo backend
simultáneamente.

Si el problema es acotado, es preferible publicar una `0.3.1` revirtiendo solo el commit culpable.
Por eso cada cambio de comportamiento observable va en su propio commit.

---

## Inventario: qué cambia en este PR, archivo por archivo

Fuente: `git status --short` en la raíz de la librería. Cada fila existe para que ningún cambio
quede sin una razón explícita.

### `src/` — modificados

| Archivo | Por qué cambió |
|---|---|
| `src/Client.ts` | `Client.create()`, getters `connectionState`/`state`, secuencia hidratar-antes-de-`connected` (`handleConnected`/`hydrate`/`syncConversations`), `conversationLeft` real, `joinConversation` ahora refresca en vez de no-opear si el chat ya está cacheado, migración de eventos a los catálogos `ClientEvent`/`TransportEvent` |
| `src/Conversation.ts` | `refreshFromRest()` para re-sincronizar al reconectar, `getUnreadMessagesCount()`/`setAllMessagesRead()` con conteo real y evento `updated`, `sendMessage()` pasa el `participantId` propio para la correlación de eco, migración a `ConversationEvent`/`ConversationUpdateReason`/`MessageUpdateReason` |
| `src/Message.ts` | `MessageType` pasa de union type a objeto `as const` (consistencia con el resto de catálogos) |
| `src/index.ts` | Exporta la superficie pública nueva: `ConnectionError`, `SendTimeoutError`, `ClientEvent`, `ConversationEvent`, `ClientState`, `MessageType`; `ConnectionState`/`ConversationUpdateReason`/`MessageUpdateReason` pasan de solo-tipo a también-valor |
| `src/internal/restApi.ts` | Rutas centralizadas en un objeto `paths`; `paths.chat()` aplica `encodeURIComponent` para que un `custom_id` con `/`, `?` o `#` no rompa la URL en `getConversationBySid()` |
| `src/internal/wsTransport.ts` | Fix de esta sesión: `open()` blindado con try/catch para que un throw al construir el `WebSocket` no mate el ciclo de reconexión. Además: contador de generación para descartar callbacks de un socket ya reemplazado, `confirmConnected(generation)` (conexión en dos fases), jitter ±30% en el backoff, correlación de envíos por cuerpo+participante, timeout de 30s de acuse, `failPendingSends` en close/updateToken/shutdown, flag `disposed` para que `updateToken()` no reabra un transporte ya apagado, `reconnectAttempt` solo se resetea en el frame `connected` real (no en el `open` del socket) |
| `src/types.ts` | `ConnectionState`, `ConversationUpdateReason`, `MessageUpdateReason` pasan de union type a catálogos `as const`; `ClientState` nuevo (`initialized`/`failed`) |

### `src/` — nuevos

| Archivo | Por qué existe |
|---|---|
| `src/ConnectionError.ts` | Clases `ConnectionError` y `SendTimeoutError` — errores tipados con flag `terminal`, con `Object.setPrototypeOf` para que `instanceof` siga funcionando si un bundler downlevela la clase |
| `src/events.ts` | Catálogos `as const` `ClientEvent`/`ConversationEvent` para quien llame `.on()`/`.emit()`; las interfaces `ClientEvents`/`ConversationEvents` deliberadamente NO usan claves computadas desde estos catálogos porque `tests/contract.test.ts` las parsea como texto |
| `src/internal/wireProtocol.ts` | Catálogos internos `ServerFrameType`/`ClientFrameType`/`TransportEvent` del protocolo de wire — no se exportan desde `index.ts` |

### `tests/` — modificados

| Archivo | Por qué cambió |
|---|---|
| `tests/client.test.ts` | Una aserción de `setAllMessagesUnread()` actualizada: devuelve el conteo real (`1`) en vez de `lastMessage.index + 1` — ver "El cambio de retorno que rompió un test" arriba |

### `tests/` — nuevos

| Archivo | Por qué existe |
|---|---|
| `tests/contract.test.ts` | Congela los nombres y valores exactos de eventos que `sbx-omnichannel-ui` usa por string, leyendo las interfaces como texto — para que un refactor interno rompa ACÁ, no en producción |
| `tests/readiness.test.ts` | Cubre `Client.create()`, la secuencia hidratar-antes-de-`connected`, falla parcial/total de hidratación y el timeout — el núcleo del bug que originó el release |
| `tests/transport.test.ts` | Cobertura a nivel `WsTransport`: guarda de generación, correlación/timeout de envíos, y el test del fix de esta sesión (`open()` con throw no mata la reconexión) |
| `tests/unread.test.ts` | Cobertura de `getUnreadMessagesCount()`/`setAllMessagesRead()`: conteo real y emisión del evento `updated` |

### `docs/` — nuevos (15 archivos, documentación educativa del release)

`docs/README.md`, `docs/conceptos.md`, `docs/primeros-pasos.md`, `docs/solucion-de-problemas.md`,
`docs/CAMBIOS-v0.3.0.md` (este mismo documento), `docs/reference/README.md`,
`docs/reference/client.md`, `docs/reference/configure.md`, `docs/reference/conversation.md`,
`docs/reference/media.md`, `docs/reference/message-builder.md`, `docs/reference/message.md`,
`docs/reference/paginator.md`, `docs/reference/participant.md`, `docs/reference/types.md`.

### Raíz / config

| Archivo | Por qué cambió |
|---|---|
| `package.json` | Versión → `0.3.0-beta.0`; `engines.node` `>=18` → `>=22`; `prepublishOnly` corre los tests antes del build |
| `README.md` | Sección nueva "Waiting for the client to be ready" (`Client.create()`, `connectionState`, `state`, `connectionError`); lista de superficie pública actualizada; sección de no-leídos actualizada (ya no siempre `null`); sección "Documentation" nueva enlazando `docs/` |
| `.github/workflows/ci.yml` | Agrega `actions/setup-node` con `node-version-file: ".nvmrc"` — guard barato para que un `.nvmrc` inválido se detecte en CI, no recién al publicar |
| `.github/workflows/publish.yml` | `node-version: "20"` (hardcodeado) → `node-version-file: ".nvmrc"`, para que CI y publish usen el mismo pin |
| `.nvmrc` (nuevo) | Pin de Node `24.19.0`, consistente con `engines.node >=22` de `package.json` |

### `.idea/` — NO subir (ver advertencia arriba)

`.idea/.gitignore`, `.idea/modules.xml`, `.idea/sbx-omnichannel-conversations.iml`,
`.idea/vcs.xml` — configuración de WebStorm, quedaron staged por accidente, sacar con
`git reset .idea/` antes de abrir el PR.
