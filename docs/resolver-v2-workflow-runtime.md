# Resolver V2: HTTP workflow runtime

## Pipeline

`MediaContext → ProviderMediaMappingResolver (mapping exacto) → mapped_http_workflow → EmbedCandidate[] → ResolverEngine → StreamCandidate[]`

El mapping aporta `externalId`; el workflow no busca por título. El catálogo valida la configuración y el runtime vuelve a normalizarla. Los resultados del workflow son candidatos, no streams ya validados: la validación y selección pertenecen al ResolverEngine.

## DSL

| Step | Entrada permitida → salida | Límites, provenance y fallos | Red / candidates |
| --- | --- | --- | --- |
| `request` | Método GET/POST, ruta relativa al `baseUrl` del mismo origen, query/headers/body con templates escalares → respuesta nombrada | Headers de petición permitidos; timeout, redirects y body acotados. Template inválido o 404: `[]`; otros HTTP fallidos: error. La respuesta sólo puede alimentar `extract`/`extractMany`. | Sí / no |
| `extract` | Respuesta previa → escalar JSON, HTML o captura literal de texto | JSON path y selector HTML restringidos; captura de texto con delimitadores estáticos de hasta 256 caracteres y valor de hasta 4096. Miss: `[]`; content-type/JSON inválido o captura excesiva: error. El escalar queda disponible para templates/`parseJsonMany`. | No / no |
| `extractMany` | Respuesta JSON previa y path a array, o respuesta HTML previa con selector y atributos estáticos (o `$text` para el texto del mismo elemento) → colección segura de campos escalares | Hasta 16 campos; 8 elementos por defecto, máximo 32; conserva orden y descarta elementos inválidos. Path ausente/no-array: `[]`; content-type inválido: error. Marca si hubo truncamiento. | No / no |
| `parseJsonMany` | Variable escalar string previa → parse JSON y colección segura | String de hasta 4096; mismas reglas de path, campos, orden y límite de `extractMany`. JSON inválido o path no-array: `[]`. No admite objetos arbitrarios como fuente. | No / no |
| `decodeBase64Many` | Colección segura anterior + campo Base64/Base64URL → nueva colección con un campo UTF-8 decodificado | Hasta 8 elementos por defecto, máximo 32; 2048 bytes decodificados por defecto, máximo 4096. Rechaza codificación no canónica, UTF-8 inválido y controles; descarta sólo el elemento inválido. Conserva orden, campos y provenance. | No / no |
| `filterMany` | Colección segura anterior + igualdad exacta contra template escalar, o comprobación de URL HTTPS → colección segura | 8 resultados por defecto, máximo 32; sin fuzzy matching ni coerción laxa; conserva orden y marca truncamiento. Sin coincidencias: colección vacía. | No / no |
| `bindOne` | Colección segura completa con exactamente un elemento → variables escalares nombradas | Hasta 16 bindings; colección truncada o ambigua: `SOURCE_WORKFLOW_AMBIGUOUS_COLLECTION`; vacía: `[]`. No convierte una colección arbitraria en segura. | No / no |
| `requestEach` | Colección segura completa → GET/POST secuencial por elemento; cada JSON se extrae a una colección agregada segura | `maxFanout` 4 por defecto/máximo 8; 8 elementos por respuesta por defecto/máximo 32; agregado máximo 32. Un solo `requestEach` por workflow. Miss de elemento (template inválido, 404, JSON/content-type no utilizable): continúa; SSRF/transporte/HTTP 403 o 5xx, presupuesto o límites: error. Mantiene orden y completitud. | Sí / no |
| `emit` | URL y metadata desde templates escalares → un `EmbedCandidate` normalizado | URL inválida o template sin valor: `[]`; headers de playback permitidos y metadata JSON-safe; respeta `maxCandidates`. | No / sí |
| `emitEach` | Colección segura + templates `{item.field}` y `metadataFields` opcional (clave de metadata → campo existente del mismo elemento) → un `EmbedCandidate` por elemento válido | Hasta 16 campos de metadata, sin colisión con metadata estática; mantiene orden, descarta candidatos individuales inválidos y respeta `maxCandidates`. | No / sí |

Las colecciones seguras sólo nacen de `extractMany`, `parseJsonMany` o `requestEach`; `decodeBase64Many` y `filterMany` preservan esa provenance. `bindOne` y `emitEach` sólo consumen dichas colecciones. Las variables de contexto expuestas son únicamente `externalId`, `tmdbId`, `season`, `episode`, `contentType` y `region`; no hay acceso arbitrario a `MediaContext`.

En opciones HTML, los atributos y `$text` se capturan en una misma fila. `decodeBase64Many` añade el campo decodificado sin perder los demás; `filterMany` conserva la fila y `emitEach.metadataFields` transporta sus escalares al candidato. El runtime no deduce idioma ni número de variante de texto libre como «Opción 2 · Latino»: para ello deben existir campos estructurados explícitos. Los atributos HTML conservan su tipo string; no hay coerción numérica implícita.

## Límites y seguridad

- Workflow: 5 pasos por defecto, máximo 8; máximo 8 peticiones HTTP totales, incluidas las de `requestEach`. Las peticiones del fanout son secuenciales y comparten un deadline global (3 s por defecto; máximo configurable 10 s).
- Respuesta HTTP: 512 KiB por defecto, máximo configurable 2 MiB; redirects 3 por defecto, máximo 10. Todo HTTP pasa por `SafeHttpClient`, con validación SSRF/DNS en cada destino/redirect y conexión a las direcciones verificadas. Las rutas del workflow permanecen en el mismo origen del `baseUrl`.
- Colecciones: 8 elementos por defecto, máximo 32; hasta 16 campos. Escalares y templates: 4096 caracteres; `maxCandidates` 8 por defecto, máximo 32. Se rechazan rutas JSON con claves de prototipo, wildcards o recorrido recursivo.
- No hay JS/eval, código dinámico, regex configurables, expresiones arbitrarias, browser ni loops generales. El parser HTML y las comprobaciones internas acotadas no son un motor de regex para providers. Base64 se limita a una decodificación UTF-8 por elemento, sin transformaciones encadenadas arbitrarias.

## Conformidad offline

Las pruebas locales de `test/provider-flow-conformance.test.js` terminan con `StreamCandidate` HLS validado para las cinco familias:

| Familia | Pasos | Peticiones workflow | Embed candidates | Streams validados |
| --- | ---: | ---: | ---: | ---: |
| A: JSON_LIST_TO_STREAMS | 3 | 1 | 2 | 2 |
| B: EXACT_EPISODE_API_CHAIN | 7 | 2 | 1 | 1 |
| C: HTML_SINGLE_EMBED | 3 | 1 | 1 | 1 |
| D: EMBEDDED_JSON_ARRAY_IN_HTML | 4 | 1 | 2 | 2 |
| E: MULTI_STEP_COLLECTION_FANOUT (una capa) | 4 | 3 | 2 | 2 |

Las peticiones de validación HLS son posteriores y no cuentan en el presupuesto HTTP del workflow. Estas pruebas demuestran capacidad del motor con fixtures, no disponibilidad de un proveedor externo.

## Frontera deliberada

No se soportan `requestEach` anidados, `foreach` arbitrario, recursión, paginación ilimitada, transforms JS, browser automation, captcha/anti-bot bypass, DRM/autenticación protegida, regex/rewrite/decode arbitrarios, sesión/cookie persistente del workflow ni playback genérico Direct MP4.

Para añadir un provider, preferir primero un mapping exacto y una entrada validada de catálogo/configuración con capacidades existentes. Una clase específica requiere justificar una capacidad que el DSL no representa; no ampliar el runtime por condiciones de hostname.
