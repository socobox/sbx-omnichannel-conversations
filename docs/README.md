# Documentación

> These docs are in Spanish; the code and the project README are in English.

## Si es la primera vez que ves esta librería

En este orden. Son unos veinte minutos y después no vas a tener que adivinar nada.

1. **[Conceptos](conceptos.md)** — qué es una conversación, qué es el token, y por qué hay un
   WebSocket *y* también peticiones REST. **No lleva ni una firma de función.**
2. **[Primeros pasos](primeros-pasos.md)** — un chat funcionando, con lo que pasa por dentro.
3. **[Referencia](reference/)** — cuando ya sabes qué buscar.

## Si vienes a resolver algo concreto

| Tengo que… | Ve a |
|---|---|
| saber qué devuelve exactamente una función | [Referencia](reference/) |
| entender por qué se cayó o se reconectó | [Conceptos](conceptos.md#por-qué-hay-un-websocket-y-también-peticiones-rest) |
| arreglar algo que no funciona | [Solución de problemas](solucion-de-problemas.md) |
| revisar el PR de la v0.3.0 | [Cambios de la v0.3.0](CAMBIOS-v0.3.0.md) |
| entender una palabra rara | Está glosada la primera vez que aparece en cada archivo |

## Las tres confusiones más comunes

Si tienes cinco minutos, lee solo esto:

1. **[`index` no es una posición](conceptos.md#el-índice-de-un-mensaje-no-es-una-posición)** —
   es un id de base de datos, y restar dos no cuenta mensajes.
2. **[La errata `indentify`](conceptos.md#una-errata-que-se-conserva-a-propósito)** — está mal
   escrita a propósito y no se arregla.
3. **[La lista vacía al arrancar](solucion-de-problemas.md#la-lista-de-chats-sale-vacía-al-arrancar)**
   — preguntaste antes de que terminara de cargar.

---

> Verificado contra **v0.3.0**. Si instalaste otra versión, revisa
> [Cambios de la v0.3.0](CAMBIOS-v0.3.0.md) antes de confiar en un ejemplo.
