# `Paginator<T>`

Archivo fuente: `src/Paginator.ts`. Espejo exacto de la forma de `@twilio/conversations`' propio
`Paginator<T>`: `items`, `hasNextPage`/`hasPrevPage`, `nextPage()`/`prevPage()`.

> **Paginador** — un objeto que representa "una página" de una lista más grande: trae los
> elementos de esa página (`items`) y sabe si hay más antes/después (`hasPrevPage`/`hasNextPage`),
> sin necesidad de que quien lo usa conozca el mecanismo de paginación por debajo.

## No pagina contra el backend — pagina en memoria sobre una lista ya completa

Esto importa porque el nombre sugiere "cada página es una petición nueva", y aquí no es así.

El backend de zavu **no pagina el historial de mensajes**: `GET /chats/:id` devuelve TODOS los
mensajes del chat en una sola respuesta (`internal/restApi.ts:109-111`). `Conversation#getMessages()`
pide esa lista completa una sola vez, la cachea, y este `Paginator` simplemente hace `.slice()`
sobre esa lista en memoria (`Paginator.ts:21`). Lo mismo aplica a
`Client#getSubscribedConversations()`, que envuelve el set completo de conversaciones suscritas en
una única página.

Consecuencia práctica: `nextPage()`/`prevPage()` **no disparan red** — son instantáneos, porque
solo recalculan el slice. Es razonable para el volumen realista de mensajes de un chat de soporte;
para una conversación excepcionalmente larga, esto significa que el `GET /chats/:id` inicial trae
todo el historial de una sola vez, sin un cursor real de backend — una limitación conocida del v1,
documentada también en el `README.md` del repo.

## Propiedades

| Propiedad | Tipo | Notas |
|---|---|---|
| `items` | `T[]` | El slice de esta página. |
| `hasNextPage` | `boolean` | `true` si `startIndex + pageSize < total`. |
| `hasPrevPage` | `boolean` | `true` si `startIndex > 0`. |

## Métodos

### `nextPage()`

**Qué hace.** Devuelve un nuevo `Paginator` con el siguiente bloque de `pageSize` elementos.

**Cuándo la usas.** Al hacer scroll hacia mensajes más recientes que los que ya tienes cargados en
pantalla (poco común: `getMessages()` ya trae los más recientes por defecto — esto es más
relevante para `prevPage()`, ver abajo).

**Firma.**
```ts
async nextPage(): Promise<Paginator<T>>;
```

**Ejemplo.**
```ts
const page = await conversation.getMessages(2);
console.log(page.items.map((m) => m.index)); // [4109, 4180]
console.log(page.hasNextPage); // false — ya estamos en el final (los más recientes)
```

**Qué esperar.** Un `Paginator<T>` nuevo (no muta el actual), calculado sobre la MISMA lista en
memoria. Es `async` solo por paridad de firma con Twilio — no hay await real que importe, resuelve
en el mismo tick.

**Qué puede salir mal.** Nada lanza. Pedir `nextPage()` cuando `hasNextPage` ya es `false` no
truena — simplemente devuelve una página vacía o la misma cola de la lista.

### `prevPage()`

**Qué hace.** Devuelve un nuevo `Paginator` con el bloque anterior de `pageSize` elementos —
mensajes más antiguos.

**Cuándo la usas.** El caso real: un agente hace scroll hacia arriba en el historial de un chat
para ver mensajes más viejos que los `pageSize` iniciales.

**Firma.**
```ts
async prevPage(): Promise<Paginator<T>>;
```

**Ejemplo.**
```ts
const page = await conversation.getMessages(2); // los 2 más recientes: [4109, 4180]
const older = await page.prevPage();
console.log(older.items.map((m) => m.index)); // [4102, 4109] — bloque anterior
console.log(older.hasPrevPage); // false si 4102 es el mensaje más antiguo del chat
```

**Qué esperar.** Un `Paginator<T>` nuevo con el bloque anterior, recortado a `Math.max(0, ...)` —
nunca un `startIndex` negativo aunque pidas `prevPage()` más veces de las que hay historial.

**Qué puede salir mal.** Nada lanza. Llamar `prevPage()` repetidamente una vez que
`hasPrevPage` es `false` simplemente sigue devolviendo la misma primera página, sin error.
