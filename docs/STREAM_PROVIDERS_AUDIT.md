# Auditoría de proveedores de streams

## Resultado

`NO SAFE LATINO PROVIDER FOUND` para integración productiva automática en esta fase. No se añadió ninguna fuente externa ni se modificó scraping, Turnstile, Vidfast, anti-bot o DRM. El fallback funcional sigue siendo audio original más subtítulos en español cuando están disponibles.

## Inventario activo

| Campo | ProviderC |
|---|---|
| `provider_id` | `provider_c` |
| `strategy` | `browser` |
| Películas / episodios | Sí / sí |
| Audio observado/esperado | Original/inglés; no garantiza Latino |
| Calidad esperada | Preferencia 1080p con fallback, no garantía contractual |
| `requires_browser` | Sí |
| Latencia | Alta: navegación y espera de player |
| Cacheability | Sólo mediante lifecycle/TTL del backend |
| Expiración | No declarada; TTL local de 60 min por defecto |
| Fallo | Devuelve null/error normalizado; retry y circuit breaker externos |
| Coste operativo | Alto (Chromium, CPU/RAM/red) |
| Rol | `expensive=true`, `fallback=true` |

Ruta productiva: worker → ProviderManager → slot PostgreSQL → ResolverExecutor → child → adapter → ProviderC. API y worker padre no importan Puppeteer ni ProviderC.

## Providers implementados en 3A

No se implementó un provider directo productivo. `ProviderRegistry` y `ProviderManager` aceptan contratos inyectables para fuentes autorizadas futuras y fixtures CI. Las estrategias directas se prueban antes de browser; ProviderC queda último. Cada resultado se valida como HLS con protección SSRF y se clasifica pasivamente antes de persistirse.

## Candidatos documentados, no integrados

| Candidato | Motivo para no integrarlo ahora |
|---|---|
| Wikimedia Commons | Su API es pública, pero la reutilización exige verificar licencia y atribución de cada archivo; no es un catálogo Latino equivalente. Véase [Content reuse](https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse) y [API access policy](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy). |
| Internet Archive | Tiene APIs documentadas y metadata de licencia por ítem, pero no concede derechos uniformes ni mapeo directo al catálogo de Kanchita. Véase [Internet Archive APIs](https://archive.org/services/docs/api/). |

Antes de registrar uno harían falta autorización/licencia por contenido, política de atribución, mapping estable a TMDB, contrato de expiración, pruebas HLS controladas y revisión de términos. No basta que una URL sea públicamente accesible.

## Fuentes rechazadas

Servicios comerciales protegidos, endpoints privados, players basados en evasión, cookies/tokens extraídos y cualquier fuente que exija bypass DRM/Widevine o ingeniería inversa no son candidatos. No se investigan ni implementan.

## Subtítulos

SubDL sigue habilitado por defecto. OpenSubtitles REST es fallback opcional y apagado; exige clave y credenciales configuradas externamente. La selección favorece Latino/es-419, coincidencia de episodio y release WEB, con español genérico como fallback. Las pruebas no usan Internet.
