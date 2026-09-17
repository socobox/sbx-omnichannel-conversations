# Cambios de la v0.3.0

Documento para revisar el PR. Dice qué cambia, qué evidencia hay, qué riesgo tiene cada cosa, y
**qué decidimos NO cambiar y por qué**.

---

## Nota sobre el merge con `main` (2026-09-17)

Esta rama y `main` avanzaron en paralelo desde la misma base vieja (`6dc076f`), sin conocimiento
mutuo. `main` trajo `feat: persist read-tracking server-side (last_read_message_id/last_read_at)`
— persistencia real en el backend (`PUT /web_chats/:id/participants/:id`, campo `unread_count` en
`GET /chats/:id`) para el mismo problema de fondo que esta rama ya había resuelto de forma más
limitada (en memoria, se perdía en cada recarga completa de página). Es la dirección correcta y
se conservó — el punto 8 de "Correcciones de comportamiento" y la sección de no-leídos completa
más abajo describen el resultado ya reconciliado, no el estado previo al merge.

El merge en sí (`git merge`) no marcó conflictos, pero ambos lados tocaban las mismas funciones
(`getUnreadMessagesCount`, `setAllMessagesRead`, `setAllMessagesUnread`, `refreshFromRest`) por
razones relacionadas. Reconciliarlo de verdad (no solo "que compile") encontró y corrigió:

- **Un guardado rechazado por el backend (`{success: false}`) se ignoraba** — el estado local
  avanzaba y se emitía `updated` igual, así que la UI limpiaba su badge por una escritura que
  nunca aterrizó. Ver `setAllMessagesRead()`/`setAllMessagesUnread()` más abajo.
- **`getUnreadMessagesCount()` duplicaba el `GET /chats/:id` que la hidratación de esa misma
  conversación ya acababa de hacer** — una vez por chat, en cada reconexión. Ver "de-duplicación"
  en la sección de no-leídos.
- **El merge perdió el `ownParticipantId` del token en `getConversationBySid()`** (`Client.ts`) —
  main lo agregó en los dos sitios donde se construye una `Conversation`, y el merge automático
  solo conservó uno. Una sesión de cliente que resolviera su chat por sid (en vez de recibirlo por
  `conversationJoined`) quedaba sin participante, y sus marcados de leído no-opeaban en silencio
  para siempre.
- **`refreshFromRest()` seguía preservando `lastReadMessageIndex` "porque el estado es en
  memoria"** — un comentario que main volvió falso sin tocar esa función. Ahora se deriva del
  `unread_count` de cada snapshot en vez de preservar un valor local.
- **Dos tests de esta rama (`readiness.test.ts`, `unread.test.ts`) quedaron rojos** porque sus
  mocks de servidor no conocían el campo/endpoint nuevos — nadie los actualiza solo con un merge.
  Ver "Evidencia".
- **2 fallos más, en `transport.test.ts`, que parecían flakiness y no lo eran**: los 3 tests rotos
  de `unread.test.ts` fallaban ANTES de su `client.shutdown()`, y ese archivo no tenía un
  `afterEach` que limpiara — los clientes zombis seguían reconectando y, como `configure()` es
  estado global de proceso, terminaban haciendo `upgrade` contra el servidor de `transport.test.ts`
  cuando ese archivo corría después. Se agregó el `afterEach` que faltaba.

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
8. **El estado de leído se persiste server-side y sobrevive un reload de página.**
   `setAllMessagesRead()`/`setAllMessagesUnread()` guardan "hasta qué mensaje leyó este
   participante" en el backend (`PUT /web_chats/:id/participants/:id`,
   `participants.last_read_message_id`/`last_read_at`) y emiten `updated` con razón
   `lastReadMessageIndex` cuando el backend acepta el guardado — nunca si lo rechaza (ver más
   abajo). `getUnreadMessagesCount()` computa contra ese valor persistido en vez de devolver
   siempre `null`, y `lastReadMessageIndex` se deriva del `unread_count` de cada snapshot en vez
   de asumir "todo leído" en cada hidratación — lo cual habría contradicho el hecho de que el
   valor ahora sobrevive un reload. Un guardado rechazado por el backend (`{success: false}`, no
   necesariamente un error HTTP) lanza en vez de avanzar el estado local en silencio.
   `getUnreadMessagesCount()` no repite el `GET /chats/:id` que la hidratación de esa conversación
   ya acaba de hacer — solo vuelve a preguntar cuando algo pudo haber movido el conteo (un mensaje
   nuevo, o un marcado propio). Cliente (token `scope: "chat"`) y agente resuelven su propio
   participante por caminos distintos (`participant_id` del token vs. `agent_id` + el mapa de
   participantes del chat) — ambos cubiertos.
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

69 tests, 0 fallos, 189 expect() calls, en 5 archivos (`client.test.ts`, `contract.test.ts`,
`readiness.test.ts`, `transport.test.ts`, `unread.test.ts`). Los 18 originales pasan **sin
tocarse**, salvo la misma única aserción ya documentada más abajo.

`unread.test.ts` y `readiness.test.ts` fueron reescritos tras el merge con `main` (ver "Nota sobre
el merge" al principio de este documento) para reflejar el modelo de persistencia server-side —
ninguno de los dos protege ya el modelo en-memoria original.

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
- El merge con `main` reveló un cuarto: `ownParticipantId` perdido en `getConversationBySid()`
  (ver "Nota sobre el merge") no tenía ningún test que lo protegiera en ninguna de las dos ramas —
  se agregó uno, verificado por mutación (quitar el argumento hace fallar
  `client.test.ts > getConversationBySid conserva el participant_id del token`).

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
| Persistencia server-side de leído | Medio | Cambia de "nunca falla" (en memoria) a "puede fallar" (llamada de red real) — `setAllMessagesRead`/`Unread` ahora pueden rechazar. Test dedicado para el rechazo (`{success: false}`); ver también "Qué hay que hacer en el consumidor" |
| `lastReadMessageIndex` derivado del `unread_count` | Medio | Reemplaza "asumir todo leído" por una derivación exacta contra el snapshot que ya trae el conteo. 3 tests dedicados, verificados por mutación |
| De-duplicación de `getUnreadMessagesCount()` | Medio | Cachea el último `unread_count` hasta que un mensaje nuevo o un marcado propio lo invalide — nunca sirve un valor de una sesión *distinta* que haya marcado leído en otra pestaña (hueco ya documentado, sin push por WS para ese caso). 2 tests dedicados (la de-duplicación y su invalidación) |
| `ownParticipantId` restaurado en `getConversationBySid` | Bajo | Una línea, revierte una pérdida real del merge. Test dedicado |

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

**Orden de avance, distinto al resto del release**: el backend (`PUT /web_chats/:id/participants/:id`
y el campo `unread_count` en `GET /chats/:id`) tiene que estar desplegado en cada entorno **antes**
de que el frontend fije esta versión ahí. Es la única dependencia de orden de todo el release — el
resto de los cambios de esta librería no requieren nada del backend por adelantado.

1. Confirmar que el backend de ese entorno ya sirve `PUT /web_chats/:id/participants/:id` y
   `unread_count`.
2. Publicar como `0.3.0-beta.0` con `npm publish --tag beta`. Al ser `0.x`, un rango con caret no
   sube solo; el dist-tag es la segunda barrera.
3. El consumidor lo fija **exacto**, sin caret, en una rama. Deploy a staging.
4. Probar a mano: cortar el wifi diez segundos con un chat abierto, rotar el token, enviar con
   el backend pausado, reasignar un chat desde el backoffice, y marcar leído/no leído con el
   backend momentáneamente devolviendo un rechazo (confirmar que no se limpia el badge).
5. Canary con dos o tres agentes reales durante 48 horas. Solo después, `0.3.0` estable.

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

Por qué es seguro, verificado: no hay `localStorage` ni `sessionStorage` en el contexto del chat.
**Esto ya no es cierto sin matices para el esquema REST**: la 0.3.0 depende de un endpoint nuevo
(`PUT /web_chats/:id/participants/:id`) y un campo nuevo (`unread_count`) que no existían para la
0.2.0. El rollback a 0.2.0 sigue siendo seguro igual — la 0.2.0 nunca llama ese endpoint ni lee ese
campo, así que no le afecta que el backend ya los tenga desplegados — pero la relación ya no es
simétrica: el backend puede quedarse desplegado con los cambios nuevos mientras el frontend
retrocede a 0.2.0, nunca al revés.

Si el problema es acotado, es preferible publicar una `0.3.1` revirtiendo solo el commit culpable.
Por eso cada cambio de comportamiento observable va en su propio commit.

---

## Qué hay que hacer en el consumidor (`sbx-omnichannel-ui`), fuera de este repo

Ahora que `setAllMessagesRead()`/`setAllMessagesUnread()` pueden **rechazar** (antes eran
enteramente en memoria, nunca lanzaban), dos call sites quedan expuestos a una rejection no
manejada — el peligro ya existe hoy en menor medida (cualquier fallo real del `PUT` produce lo
mismo desde que `main` agregó la persistencia), este release solo lo hace más alcanzable en la
práctica:

- `ChatComponent.tsx:382` llama `setAllMessagesRead()` **sin `await` y sin `.catch()`**, dentro de
  un `onClick`.
- `ChatItemMenuComponent.tsx:54-56` lo `await`ea dentro de un handler de click de React, también
  sin `.catch()`.

`ChatContext.tsx:207-214` sí lo envuelve en `try/catch` — ese call site ya está bien. No se toca
nada de esto en este PR (es otro repo); queda documentado para que el equipo de
`sbx-omnichannel-ui` lo revise.

---

## Inventario: qué cambia en este PR, archivo por archivo

Fuente: `git status --short` en la raíz de la librería. Cada fila existe para que ningún cambio
quede sin una razón explícita.

### `src/` — modificados

| Archivo | Por qué cambió |
|---|---|
| `src/Client.ts` | `Client.create()`, getters `connectionState`/`state`, secuencia hidratar-antes-de-`connected` (`handleConnected`/`hydrate`/`syncConversations`), `conversationLeft` real, `joinConversation` ahora refresca en vez de no-opear si el chat ya está cacheado, migración de eventos a los catálogos `ClientEvent`/`TransportEvent`; de `main`: decodifica `participant_id` de un token `scope: "chat"` (`ownParticipantId`); reconciliación: `getConversationBySid()` había perdido ese `ownParticipantId` en el merge, restaurado |
| `src/Conversation.ts` | `refreshFromRest()` para re-sincronizar al reconectar, `sendMessage()` pasa el `participantId` propio para la correlación de eco, migración a `ConversationEvent`/`ConversationUpdateReason`/`MessageUpdateReason`; de `main`: `getUnreadMessagesCount()`/`setAllMessagesRead()`/`setAllMessagesUnread()` persisten server-side; reconciliación: `lastReadMessageIndex` ahora se deriva del `unread_count` del snapshot en vez de asumir "todo leído" (`deriveLastReadIndex`), `getUnreadMessagesCount()` cachea el último conteo del servidor y solo re-pide cuando algo pudo haberlo movido (`applyUnreadCount`/`unreadCountIsFresh`), un guardado rechazado (`{success: false}`) lanza en vez de avanzar el estado en silencio (`persistLastRead`), `refreshFromRest()` ya no preserva un valor local (ahora deriva del snapshot) ni emite `lastReadMessageIndex` |
| `src/Message.ts` | `MessageType` pasa de union type a objeto `as const` (consistencia con el resto de catálogos) |
| `src/index.ts` | Exporta la superficie pública nueva: `ConnectionError`, `SendTimeoutError`, `ClientEvent`, `ConversationEvent`, `ClientState`, `MessageType`; `ConnectionState`/`ConversationUpdateReason`/`MessageUpdateReason` pasan de solo-tipo a también-valor |
| `src/internal/restApi.ts` | Rutas centralizadas en un objeto `paths`; `paths.chat()` aplica `encodeURIComponent` para que un `custom_id` con `/`, `?` o `#` no rompa la URL en `getConversationBySid()`; de `main`: `RestChat.unread_count`, `updateParticipant()` (`PUT /web_chats/:id/participants/:id`); reconciliación: la ruta de `updateParticipant` se centralizó en `paths.webChatParticipant()`, igual que las demás |
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
| `tests/client.test.ts` | Una aserción de `setAllMessagesUnread()` actualizada: devuelve el conteo real (`1`) en vez de `lastMessage.index + 1` — ver "El cambio de retorno que rompió un test" arriba. De `main`: mocks de `unread_count`/`PUT .../participants/:id` y 3 tests del camino feliz de persistencia; reconciliación: +1 test (`getConversationBySid conserva el participant_id del token`) |
| `tests/readiness.test.ts` | Reconciliación: el fixture `chat()` acepta un `unread_count` explícito; el test "preserva el estado de no leídos al re-hidratar" reescrito para el modelo server-side (antes probaba la preservación en memoria, que ya no existe); +1 test nuevo (`re-hidratar NO emite lastReadMessageIndex`) |
| `tests/transport.test.ts` | Sin cambios de código — los 2 fallos que mostraba no eran del transporte, ver "Nota sobre el merge" |

### `tests/` — nuevos

| Archivo | Por qué existe |
|---|---|
| `tests/contract.test.ts` | Congela los nombres y valores exactos de eventos que `sbx-omnichannel-ui` usa por string, leyendo las interfaces como texto — para que un refactor interno rompa ACÁ, no en producción |
| `tests/readiness.test.ts` | Cubre `Client.create()`, la secuencia hidratar-antes-de-`connected`, falla parcial/total de hidratación y el timeout — el núcleo del bug que originó el release |
| `tests/transport.test.ts` | Cobertura a nivel `WsTransport`: guarda de generación, correlación/timeout de envíos, y el test del fix de esta sesión (`open()` con throw no mata la reconexión) |
| `tests/unread.test.ts` | Reescrito completo tras el merge para el modelo de persistencia server-side: conteo real vía `unread_count`, derivación de `lastReadMessageIndex`, de-duplicación de `getUnreadMessagesCount()` (2 tests), rechazo del backend no avanza el estado, simetría sin participante resoluble, y un `afterEach` que apaga los clientes de cada test (el leak que contaminaba `transport.test.ts`) |

### `docs/` — nuevos (15 archivos, documentación educativa del release)

`docs/README.md`, `docs/conceptos.md`, `docs/primeros-pasos.md`, `docs/solucion-de-problemas.md`,
`docs/CAMBIOS-v0.3.0.md` (este mismo documento), `docs/reference/README.md`,
`docs/reference/client.md`, `docs/reference/configure.md`, `docs/reference/conversation.md`,
`docs/reference/media.md`, `docs/reference/message-builder.md`, `docs/reference/message.md`,
`docs/reference/paginator.md`, `docs/reference/participant.md`, `docs/reference/types.md`.

### Raíz / config

| Archivo | Por qué cambió |
|---|---|
| `package.json` | Versión → `0.3.0-beta.0`; `engines.node` `>=18` → `>=22`; `prepublishOnly` corre los tests antes del build. De `main`: `typescript` → `^7.0.2` (`build` pasa a `bun node_modules/typescript/bin/tsc`); reconciliación: `main` proponía pin a Node 20, se mantuvo el `>=22`/`.nvmrc 24.19.0` de esta rama — TypeScript 7 y el pin de Node de esta rama son compatibles, verificado (`tsc --noEmit` limpio) |
| `README.md` | Sección nueva "Waiting for the client to be ready" (`Client.create()`, `connectionState`, `state`, `connectionError`); lista de superficie pública actualizada; sección de no-leídos actualizada (ya no siempre `null`); sección "Documentation" nueva enlazando `docs/` |
| `.github/workflows/ci.yml` | Agrega `actions/setup-node` con `node-version-file: ".nvmrc"` — guard barato para que un `.nvmrc` inválido se detecte en CI, no recién al publicar |
| `.github/workflows/publish.yml` | `node-version: "20"` (hardcodeado) → `node-version-file: ".nvmrc"`, para que CI y publish usen el mismo pin |
| `.nvmrc` (nuevo) | Pin de Node `24.19.0`, consistente con `engines.node >=22` de `package.json` |

### `.idea/` — NO subir (ver advertencia arriba)

`.idea/.gitignore`, `.idea/modules.xml`, `.idea/sbx-omnichannel-conversations.iml`,
`.idea/vcs.xml` — configuración de WebStorm, quedaron staged por accidente, sacar con
`git reset .idea/` antes de abrir el PR.
