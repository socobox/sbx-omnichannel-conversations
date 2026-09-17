# Solución de problemas

Ordenado por síntoma, tal como lo ves. Cada entrada dice qué está pasando por dentro, cómo
confirmarlo, y qué hacer.

---

## «La lista de chats sale vacía al arrancar»

**Qué está pasando.** Preguntaste demasiado pronto.

`getSubscribedConversations()` no hace ninguna petición: devuelve lo que hay en memoria en ese
instante. Y esa memoria se llena en dos pasos que tardan — primero el socket avisa qué chats hay,
después la librería va a buscar cada uno. `new Client(token)` devuelve inmediatamente, mucho
antes de todo eso.

**Cómo confirmarlo.** Si esto imprime `0` y luego `2`, es exactamente este caso:

```ts
const client = new Client(token);
console.log((await client.getSubscribedConversations()).items.length); // → 0
setTimeout(async () => {
  console.log((await client.getSubscribedConversations()).items.length); // → 2
}, 2000);
```

**Arreglo, desde la v0.3.0.** Usa la fábrica asíncrona, que espera por ti:

```ts
const client = await Client.create(token);
const { items } = await client.getSubscribedConversations();
console.log(items.length); // → 2
```

**Arreglo alternativo, si tu UI ya es reactiva.** No esperes: pinta la lista vacía y deja que
crezca sola.

```ts
const client = new Client(token);
client.on("conversationJoined", (c) => agregarALaLista(c));
client.on("initialized", () => ocultarSpinner());
```

**Lo que NO arregla nada:** poner un `setTimeout` de tres segundos. Con red lenta o cuarenta chats
suscritos, tres segundos no alcanzan, y es exactamente el bug que vuelve el mes siguiente.

---

## «Perdí mensajes después de que se cayó el wifi»

**Qué está pasando.** Hasta la v0.2.0, al reconectar la librería no volvía a pedir nada.

El servidor reenvía la lista de chats suscritos en cada reconexión, pero la librería, al ver que
ya conocía esos chats, no hacía nada. Todo lo que hubiera pasado durante el corte —mensajes
nuevos, cambios de estado— se perdía hasta que recargabas la página.

**Arreglo.** Desde la v0.3.0 cada reconexión vuelve a pedir el expediente de cada chat y lo
reaplica **sobre el mismo objeto**, así que las referencias que tu UI ya tenía siguen sirviendo y
la conversación abierta no se cierra sola.

**Si sigues en 0.2.0**, el único remedio es apagar el cliente y crear uno nuevo, que es caro y
pierde el estado de la UI.

---

## «Mi promesa de envío nunca resuelve» / «el botón de enviar se queda deshabilitado»

**Qué está pasando.** Mandar texto va por el socket, y el socket **no manda un acuse de recibo**.
La confirmación real es el eco: el mismo mensaje volviendo. Así que el envío queda esperando ese
eco.

Si el socket se cae entre el envío y el eco, ese eco no llega nunca. Hasta la v0.2.0 no había
timeout: la promesa se quedaba pendiente para siempre. Si tu botón está deshabilitado hasta que
resuelva, el agente se queda bloqueado.

**Arreglo.** Desde la v0.3.0 el envío rechaza en cuanto el socket cae —en milisegundos, no en
treinta segundos— y también por timeout si el servidor se lo traga con la conexión viva. El error
es un `SendTimeoutError`, que puedes filtrar aparte en tu sistema de errores.

**Lo que tienes que hacer tú:** capturarlo. Si tu código hace `await enviar()` sin `try/catch` y
sin `finally`, el rechazo se convierte en un error no capturado y el botón sigue trabado igual.

```ts
try {
  await conversation.sendMessage(texto);
} catch (e) {
  mostrarReintentar();   // el mensaje pudo haber llegado igual: no lo borres de la pantalla
} finally {
  habilitarBoton();      // esto es lo que faltaba
}
```

---

## «El envío me devolvió el id de otro mensaje»

**Qué está pasando.** Hasta la v0.2.0 la librería resolvía el envío con **el primer mensaje que
llegara** para ese chat. Si el cliente escribía mientras tu envío estaba en vuelo, tu promesa
resolvía con el id del mensaje del cliente.

**Arreglo.** Desde la v0.3.0 el acuse se correlaciona por el texto **y** por el participante, así
que solo lo resuelve tu propio eco. Da igual que los dos manden «ok» a la vez.

---

## «Se reconecta infinitamente»

**Qué está pasando.** La librería reintenta sola, con esperas crecientes (1, 2, 5, 10 y 15
segundos, y de ahí en adelante cada 15). **No hay límite de intentos**: si el servidor está caído
una hora, lo va a seguir intentando durante esa hora.

Eso es deliberado — un agente que dejó el navegador abierto durante un despliegue quiere que
vuelva solo. El problema es distinguir «se está reconectando» de «esto ya no va a volver».

**Cómo distinguirlo.** Escucha `connectionError` y mira `terminal`:

```ts
client.on("connectionError", (error) => {
  if (error.terminal) {
    // No va a reconectar solo. Pide token nuevo o manda al login.
  } else {
    mostrarAviso("Sin conexión, reintentando…");
  }
});
```

**Un caso que hasta la v0.3.0 no escalaba.** Si el servidor aceptaba la conexión y la cerraba
enseguida —un token rechazado después del saludo inicial, o un backend drenando un despliegue— la
espera volvía a un segundo en cada ciclo y nunca crecía. Ya está arreglado: la espera solo se
reinicia cuando la conexión de verdad funciona.

---

## «Error: configure({apiBaseUrl}) must be called once before creating a Client»

**Qué está pasando.** Se creó un cliente sin haber configurado antes a qué servidor hablar.

Tres causas posibles, en orden de frecuencia:

1. **Orden de llamadas.** `configure()` tiene que ir antes de `new Client()`.
2. **Dos copias del paquete en el bundle.** La configuración vive en una variable de módulo, así
   que si hay dos copias, configuras una y el cliente lee la otra. Compruébalo con
   `npm ls sbx-omnichannel-conversations`.
3. **Recarga en caliente durante el desarrollo**, que reevalúa el módulo y borra la variable.

---

## «El autor de los mensajes sale como `agent_undefined` o `participant_57`»

**Qué está pasando.** Dos causas distintas:

- **En un test**: escribiste el campo de identidad con la ortografía correcta en tus datos falsos.
  El backend lo tiene con una errata y la librería lee esa forma. Ver
  [Conceptos](conceptos.md#una-errata-que-se-conserva-a-propósito).
- **En producción**: llegó un mensaje de un participante que no estaba cuando se cargó el chat —
  un bot o un agente agregado después. La librería usa un nombre de respaldo en vez de volver a
  pedir todo el expediente solo para resolver una etiqueta.

---

## «El badge de no leídos no se limpia al abrir el chat»

**Qué está pasando.** Hasta la v0.2.0, marcar como leído no avisaba a nadie: cambiaba un valor en
memoria y ya. Tu UI no tenía forma de enterarse, así que el badge conservaba su número hasta la
siguiente recarga completa de la página.

**Arreglo.** Desde la v0.3.0, marcar como leído emite un evento de conversación actualizada con el
motivo `lastReadMessageIndex`, que es lo que Twilio hacía. Escúchalo y pon el contador en el valor
real:

```ts
client.on("conversationUpdated", async ({ conversation, updateReasons }) => {
  if (!updateReasons.includes("lastReadMessageIndex")) return;
  setBadge(conversation.sid, (await conversation.getUnreadMessagesCount()) ?? 0);
});
```

---

## «`getUnreadMessagesCount()` me devuelve null»

**Hasta la v0.2.0** devolvía `null` siempre, a propósito.

**Desde la v0.3.0** devuelve el conteo real, y solo `null` cuando de verdad no lo sabe: si todavía
no se cargó el historial de ese chat.

**Lo que no debes hacer si te devuelve `null`:** restar `lastMessage.index` menos el último índice
leído. Esos son identificadores de base de datos, no posiciones, y su diferencia no es una
cantidad de mensajes. Cuenta los elementos del historial.

---

## «El adjunto no tiene nombre de archivo»

Los adjuntos que **recibes** siempre traen el nombre vacío: la librería no lo propaga al construir
el objeto del adjunto. Los que **mandas** sí conservan el nombre que le pasaste.

Es una limitación conocida, no un error de tu código.

---

## «Después de rotar el token empecé a ver mensajes duplicados»

**Qué está pasando.** Hasta la v0.2.0, rotar el token cerraba el socket viejo y abría uno nuevo,
pero el cierre del viejo llegaba tarde y hacía que la librería agendara *otra* reconexión encima
de la conexión sana. El socket intermedio quedaba huérfano con sus escuchas puestas, así que cada
mensaje se procesaba dos veces.

**Arreglo.** Desde la v0.3.0 cada socket lleva un número de generación y las escuchas de un socket
reemplazado no hacen nada. También se arregló el caso inverso: rotar el token después de apagar el
cliente reabría un socket que nadie escuchaba y reconectaba para siempre, invisible.
