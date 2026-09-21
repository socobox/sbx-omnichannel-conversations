# `Participant`

Archivo fuente: `src/Participant.ts`. Espejo de `@twilio/conversations`' propio `Participant` — el
frontend de referencia solo lee unos pocos campos de aquí para mostrarlos, nunca lo muta
directamente. No tiene métodos públicos, solo propiedades de solo lectura; se construye siempre
internamente (constructor `@internal`), nunca a mano.

## `Participant.identity` se lee de `raw.indentify` — la errata del backend se conserva a propósito

Esto es lo más fácil de pisar mal en toda esta clase.

El backend de zavu tiene una **errata real** en el nombre del campo: en vez de `identify`, la fila
de participante trae `indentify` (con una "n" de más). No es un error de este paquete — es
literalmente cómo lo manda el backend. `Participant.ts:21` lo lee tal cual:

```ts
this.identity = raw.indentify; // Participant.ts:21 — así, con la "n", porque así llega
```

y `internal/restApi.ts:38` declara el tipo `RestParticipant` con el mismo nombre:

```ts
export interface RestParticipant {
  // ...
  indentify: string | null; // restApi.ts:38 — la errata del backend, conservada a propósito
  // ...
}
```

**Por qué se conserva en vez de "arreglarse":** arreglarlo aquí significaría leer un campo que el
backend real nunca manda, y `identity` quedaría silenciosamente `undefined` para absolutamente
todos los participantes — sin ningún error visible que lo delate.

**La trampa práctica:** si estás escribiendo un fixture de prueba, un mock, o un seed de datos y
escribes `identify` (bien escrito, sin la "n") en vez de `indentify`, el participante SÍ se
construye, pero:

```ts
// mal — "identify" bien escrito, que es justo el error:
const raw = { id: 11, agent_id: 99, identify: "agent_99", /* ... */ };
new Participant(raw as any).identity; // null — no undefined, null

// y en Conversation, cuando el fallback de identidad entra en juego (Conversation.ts:88):
// `agent_${p.agent_id ?? p.id}` -> "agent_undefined" si agent_id también viene mal
```

`Conversation.ts:88` tiene su propio fallback (`p.indentify ?? \`agent_${p.agent_id ?? p.id}\``),
así que un `indentify` ausente no siempre se ve como `null` — puede aparecer como un
`author`/`identity` con forma `agent_undefined`, sin ningún mensaje de error que apunte al typo.
Si ves eso en una prueba o en un log, la primera sospecha debe ser: el fixture escribió
`identify` en vez de `indentify`.

## Propiedades

| Propiedad | Tipo | De dónde sale |
|---|---|---|
| `sid` | `string` | `raw.sid`, o `raw.conversation_sid`, o el `id` como `string` — el primero que exista. |
| `identity` | `string \| null` | `raw.indentify` — ver la sección de arriba. |
| `name` | `string \| null` | **Desde v0.3.0-beta.4.** El nombre real para mostrar (`"Admin Admin"`), no el id opaco de `identity`. `raw.name`, con respaldo a `raw.agent?.name` si viene vacío (defensa en profundidad, no el camino normal — el backend ya manda `name` directo para un `HUMAN_AGENT`). `null` si el backend no tiene ningún nombre para este participante. |
| `attributes` | `JSONValue` | `raw.metadata` tal cual. |
| `type` | `string` | `raw.participant_type` (ej. `"USER"`, `"HUMAN_AGENT"`). |
| `bindings` | `JSONValue` | También `raw.metadata` — ver la nota siguiente. |

### Nota sobre `bindings`

En Twilio real, `bindings` es específico por canal (solo `email` está siquiera tipado), y todo
call site real en el frontend de referencia ya lo lee con un cast `as any`. Este paquete no
replica esa forma por canal — simplemente expone la misma `metadata` cruda del participante como
`bindings`, a modo de reemplazo "mejor que nada", no como una forma fiel por canal.

### Ejemplo

```ts
const participants = await conversation.getParticipants(); // ver conversation.md: siempre va a red

const customer = participants.find((p) => p.type === "USER")!;
console.log(customer.identity); // "customer_4471"

const agent = participants.find((p) => p.type === "HUMAN_AGENT")!;
console.log(agent.identity); // "agent_182"
console.log(agent.attributes); // {} — o lo que traiga metadata para ese participante
```

**Qué esperar.** Un `Participant` de solo lectura, reconstruido cada vez que `getParticipants()`
(o la hidratación/reconexión de la `Conversation`) trae una fila fresca — no hay una identidad de
objeto estable entre llamadas sucesivas de `getParticipants()`.

**Qué puede salir mal.** No hay métodos que lancen aquí. El único "error" real es el silencioso
que describe la sección de arriba: un `indentify` ausente o mal escrito en el origen de datos
produce `identity: null` o un fallback tipo `agent_undefined`, sin excepción ni mensaje.
