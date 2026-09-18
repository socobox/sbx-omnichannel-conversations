# `configure`

Archivo fuente: `src/config.ts`.

`configure()` es el único paso de arranque que este paquete añade sobre `@twilio/conversations`:
Twilio nunca necesitaba decirle a su SDK dónde vivía el backend porque siempre hablaba con la
infraestructura de Twilio. Este paquete habla con tu propio backend de SBX Omnichannel, así que
necesita saber su `apiBaseUrl` antes de construir cualquier `Client`.

### `configure(config)`

**Qué hace.** Guarda la URL base del API de SBX Omnichannel en un módulo interno, para que todas
las llamadas REST y la conexión WebSocket que este paquete hace internamente sepan a dónde ir.

**Cuándo la usas.** Una sola vez, al arrancar la aplicación — por ejemplo en el `main.tsx` o el
punto de entrada de `sbx-omnichannel-ui`, antes de que cualquier componente construya un
`Client`. No se llama por chat ni por sesión: es configuración de proceso, no de usuario.

**Firma.**
```ts
interface SbxConversationsConfig {
  /** URL base del API de SBX Omnichannel (ej. "https://omnichannel.example.com"). Sin slash final. */
  apiBaseUrl: string;
}

function configure(config: SbxConversationsConfig): void;
```

**Ejemplo.**
```ts
import { configure, Client } from "sbx-omnichannel-conversations";

configure({
  apiBaseUrl: "https://omnichannel.sbxcloud.com",
});

// Recién ahora es seguro construir un Client — ver client.md.
const client = new Client(agentWsToken);
```

**Qué esperar.** No devuelve nada (`void`). El efecto secundario es interno: queda guardada una
configuración en memoria de proceso que usan `internal/restApi.ts` (cada llamada `fetch`) y
`internal/wsTransport.ts` (la URL del WebSocket, derivada reemplazando `http` por `ws` —
`src/config.ts:31-36`, función `wsUrlFor`, exportada solo para pruebas). Un `apiBaseUrl` con slash
final se normaliza quitándoselo (`config.ts:19`), así que `"https://omnichannel.example.com/"` y
`"https://omnichannel.example.com"` producen el mismo resultado.

**Qué puede salir mal.** Si construyes un `Client` (o llamas cualquier método que toque red) antes
de llamar `configure()`, cualquier llamada a `getConfig()` interno lanza:

```
sbx-omnichannel-conversations: configure({apiBaseUrl}) must be called once before creating a Client — see the README.
```

(`src/config.ts:24-27`). La causa casi siempre es un orden de imports/inicialización: algún
código de arranque construye el `Client` (o importa un módulo que lo hace de forma eager) antes de
que `configure()` se ejecute. El arreglo es mover la llamada a `configure()` al principio absoluto
del bootstrap, antes de cualquier `import` que pueda disparar la construcción de un `Client`.

Nota deliberada: **`configure()` nunca acepta un `api_key`** ni ninguna otra credencial de
servidor. El único dato de autenticación que este paquete usa es el mismo token de sesión por
agente que ya se pasa a `new Client(token)` — ese token es el que viaja en cada llamada REST
interna (`internal/restApi.ts:79-81`, header `Authorization: Bearer <token>`). Pasar el
`api_key` del tenant aquí lo horneraría en el bundle del navegador, que es exactamente lo que este
diseño evita.
