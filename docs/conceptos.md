# Conceptos

Esto es lo primero que hay que leer. No lleva **ni una sola firma de función**: si al terminar
entiendes qué es una conversación, qué es el token y por qué hay dos canales de red, el resto de
la documentación se lee sola.

---

## Qué problema resuelve esta librería

Tu app necesita mostrar, en una sola bandeja y en vivo, chats que llegan por WhatsApp, SMS,
email, Instagram y el widget web. Esta librería es la pieza que habla con el servidor para que
eso sea posible: mantiene la lista de chats del agente al día, avisa cuando entra un mensaje, y
manda los que el agente escribe.

Antes ese trabajo lo hacía `@twilio/conversations`. Esta librería lo reemplaza hablando con el
backend propio, conservando los mismos nombres de clases, métodos y eventos. Por eso vas a
encontrar decisiones que solo se explican como «así lo hacía Twilio»: son deliberadas, para que
migrar costara cambiar un import y no reescribir la aplicación.

---

## Los cinco sustantivos

Todo el modelo son cinco cosas. Si las tienes claras, ya entendiste la librería.

### Conversación

Un chat. Una conversación con **una** persona por **un** canal. El mismo cliente escribiéndote
por WhatsApp y por email son dos conversaciones distintas.

Tiene un identificador (`sid`), un nombre para mostrar, un estado (abierta, finalizada), y una
bolsa de datos libres donde el backend guarda lo que necesite: el teléfono, la hora de
vencimiento, el nombre del contacto.

### Mensaje

Una línea del chat. Tiene texto, autor, fecha, y opcionalmente un adjunto.

> **Ojo con su `index`.** No es la posición en una lista. Es el identificador del mensaje en la
> base de datos, compartido con todos los chats de todos los clientes. Tiene su propia sección
> más abajo, porque es la confusión número uno.

### Participante

Quién está en la conversación. Normalmente dos: el cliente y el agente. A veces también un bot.
Es lo que permite saber si un mensaje lo escribió «el cliente» o «yo».

### Media

Un adjunto: una imagen, un PDF, un audio. No se descarga solo — la librería te da una URL
temporal cuando se la pides.

### Cliente

El objeto que lo sostiene todo. Se crea una vez al arrancar la app, mantiene la conexión abierta,
y es quien avisa de lo que pasa. Cuando el agente cierra sesión, se apaga.

---

## El token: qué es y de dónde sale

> **Token** — una credencial de sesión, con fecha de vencimiento. Prueba quién eres sin tener que
> mandar usuario y contraseña en cada petición.

El token del agente lo emite tu propio backend cuando el agente inicia sesión. La librería lo
recibe al crear el cliente y lo usa para todo: para abrir la conexión en vivo y para cada
petición que hace después.

> **JWT** — el formato de token más común. Son tres bloques separados por puntos; el del medio
> son datos legibles (cualquiera puede leerlos, pero nadie puede falsificarlos sin la clave del
> servidor).

De ese bloque legible la librería solo lee dos cosas:

- **`agent_id`**, para saber cuál de los participantes del chat eres tú. Lo necesita para mandar
  adjuntos y para reconocer el acuse de tus propios envíos.
- **`exp`**, la fecha de vencimiento, para avisarte **tres minutos antes** de que caduque y darte
  tiempo de pedir uno nuevo sin que el agente note nada.

### Lo que el token NO es

No es la `api_key` del tenant. Esa es una credencial amplia, de servidor, y **nunca debe llegar
al navegador**: cualquiera que abra las herramientas de desarrollo la vería. La librería está
construida explícitamente para no necesitarla — reutiliza el mismo token de sesión del agente
para todas sus peticiones, que es una credencial estrecha y con vencimiento.

---

## Por qué hay un WebSocket *y* también peticiones REST

Esta es la sección clave. La librería habla con el backend por dos caminos a la vez, y no es
redundancia: cada uno sirve para algo que el otro hace mal.

> **WebSocket** — una conexión que queda *abierta*. En vez de que tu app pregunte «¿hay algo
> nuevo?» cada cinco segundos, el servidor avisa en el momento.

**El WebSocket es el timbre.** Suena y dice frases muy cortas: «llegó un mensaje en el chat 41»,
«te asignaron el chat 58», «el chat 12 se cerró». Es instantáneo, pero no trae contexto: cuando
te asignan un chat nuevo, el timbre dice el número `58` y nada más. Ni el nombre del cliente, ni
los treinta mensajes anteriores.

**El REST es el archivador.** Cuando necesitas el expediente completo de un chat —sus
participantes, todo su historial, sus datos— la librería va a buscarlo y lo recibe entero.

### El arranque combina los dos, en este orden

1. Se abre el WebSocket. El servidor responde con la lista de chats a los que el agente está
   suscrito: `[41, 42, 58]`. Números, nada más.
2. Por cada número, la librería va al archivador a buscar el expediente.

> **Hidratar** — convertir un identificador suelto (`58`) en un objeto completo y usable: una
> conversación con nombre, participantes e historial.

Solo cuando terminan esos dos pasos tu app tiene algo que pintar. **Ésta es la razón número uno
por la que a alguien «le sale la lista vacía»**: preguntó por las conversaciones antes de que la
hidratación terminara.

Desde la v0.3.0 hay una forma de esperar a que termine, y el evento de «conectado» ya no se emite
hasta que hay datos. Antes se emitía en cuanto el timbre sonaba, cuando todavía no había nada.

---

## El índice de un mensaje NO es una posición

En el SDK original de Twilio, `index` era un contador **por conversación** que empezaba en cero:
el primer mensaje del chat era el `0`, el segundo el `1`. Podías usarlo para buscar en un array y
funcionaba.

**Aquí no.** El backend no tiene ese contador. Lo que sí tiene es el identificador de la fila en
la base de datos, y eso es exactamente lo que se expone. Es un número **global a toda la base**,
compartido entre todos los chats de todos los clientes.

Así que en la práctica vas a ver esto:

```
[4102, 4109, 4180, 4187]
```

No empieza en cero, y tiene huecos: los números `4103` a `4108` son mensajes de **otros** chats.

### Qué sí puedes hacer con él

- **Comparar dos mensajes del mismo chat** para saber cuál es más nuevo. El número siempre crece,
  así que «mayor» siempre significa «posterior».
- **Identificar un mensaje**, que es para lo que la librería lo usa internamente.

### Qué NO puedes hacer

- **Usarlo como posición en una lista.** Te vas fuera del array.
- **Restar dos índices para contar mensajes.** Ésta es la trampa peligrosa, porque *parece*
  funcionar. La diferencia entre dos identificadores de base de datos no es una cantidad de
  mensajes: puede dar 400 aunque haya tres mensajes sin leer, según cuánto tráfico haya habido en
  otros chats mientras tanto.

  Si tu app hace esa resta —es un patrón heredado de la época de Twilio— está mal. Desde la
  v0.3.0 la librería devuelve el conteo real y no hace falta calcularlo.

---

## Una errata que se conserva a propósito

El backend escribió mal el campo que guarda la identidad de un participante: dice `indentify` en
vez de `identify`. Está así en las bases de datos de varios clientes en producción.

La librería lo traduce: por fuera el campo se llama bien, y la errata queda encerrada en la capa
que habla con el servidor. **Tú nunca escribes la palabra mal escrita**, salvo en dos sitios:
mirando la pestaña de red del navegador, y escribiendo datos falsos para un test. Si en un test
escribes la forma correcta, el participante sale sin identidad y no vas a entender por qué.

No se «arregla» porque arreglarlo aquí rompería a todos los clientes que ya tienen ese dato
guardado así.

---

## Qué NO hace esta librería

Para que no la busques donde no está:

- **No guarda qué leíste entre recargas.** Sabe cuántos mensajes llevas sin leer mientras la
  página está abierta, pero al recargar empieza de cero. No hay dónde guardarlo en el backend.
- **No pagina de verdad.** Trae el historial completo de un chat de una vez y luego lo recorta en
  memoria. Suficiente para el volumen real de un chat, insuficiente para uno de años.
- **Un adjunto por mensaje.** Mandar varios archivos son varios mensajes.
- **Editar mensajes y mandar adjuntos solo funciona en chats del widget web.** Un mensaje que ya
  salió por WhatsApp no se puede editar: ya está en el teléfono de alguien.
- **Solo navegador.** No se ha construido ni probado nada para móvil nativo.

---

## Y ahora

- [Primeros pasos](primeros-pasos.md) — un chat funcionando en tu máquina.
- [Referencia](reference/) — qué hace cada función, con ejemplos.
- [Solución de problemas](solucion-de-problemas.md) — síntoma, causa, arreglo.
