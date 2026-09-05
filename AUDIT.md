# Auditoría técnica de Kanchita Backend

## Resumen ejecutivo

El proyecto conserva una separación razonable entre rutas, controladores, servicios y consultas, y Express + PostgreSQL siguen siendo una base adecuada. Sin embargo, **no debe desplegarse públicamente en su estado actual**. Hay secretos reales o de apariencia operativa en un `.env` público, dos incompatibilidades entre código y esquema que rompen streams/subtítulos, una instalación limpia no reproducible y superficies de abuso capaces de agotar un VPS.

Alcance: rama `main`, commit `6844ef4`, 5.087 archivos versionados; 5.024 pertenecen a `node_modules` (aprox. 44 MB en el checkout). No se modificó el backend ni se probaron proveedores con las credenciales expuestas.

## CRÍTICO

### C-01 — Secretos versionados en un repositorio público

**Evidencia:** `.env` está en `main` desde el commit inicial y contiene valores no vacíos/no marcados como ejemplo para `DB_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `TMDB_API_KEY` y `SUBDL_API_KEY`. No se reproducen sus valores. `.gitignore` es una única cadena entre comillas que concatena patrones y, en la práctica, no ignora nada.

**Impacto:** acceso no autorizado a servicios, falsificación de JWT si los secretos son válidos, consumo de cuotas y persistencia del material en clones/cachés aun después de borrar el archivo actual.

**Acción inmediata:** asumir compromiso y rotar contraseña de PostgreSQL (y cualquier reutilización), ambos secretos JWT, clave TMDB y clave SubDL. Invalidar todos los refresh tokens. Retirar `.env` del índice, corregir `.gitignore`, revisar logs y uso de APIs, y sanear el historial con coordinación previa. Instrucciones seguras están en “Corrección del historial Git”.

## ALTO

### A-01 — El esquema no satisface el código de streams/subtítulos

- `subtitles.service.js` consulta e inserta en `subtitles`, pero `database/init.sql` no crea esa tabla.
- `streams.queries.js` usa `ON CONFLICT (content_type, content_id, server_name)`, pero `streams` no tiene esa restricción única. PostgreSQL responderá que no existe una restricción compatible.
- Los scripts de inicialización sólo corren al crear un volumen; no existe sistema de migraciones para corregir bases ya creadas.

**Impacto:** el primer acceso sin caché puede resolver externamente una URL y fallar al guardarla; cualquier acceso a subtítulos falla contra una base recién creada.

### A-02 — Endpoint de subtítulos sin autenticación y procesamiento remoto no acotado

`GET /api/subtitles/:tmdbId` no usa middleware de autenticación. Puede provocar consultas externas, descargas de archivos comprimidos, descompresión en memoria, escritura en disco y operaciones de base. Las respuestas remotas no tienen timeout, límite de bytes, límite de redirects ni validación robusta de estado/tipo. Esto se combina con una vulnerabilidad alta conocida de `adm-zip` ante ZIP construido para reservar memoria masiva.

**Impacto:** consumo de cuota, memoria y disco; caída del proceso o llenado del VPS.

### A-03 — URLs y credenciales sensibles terminan en logs

SubDL registra la URL que contiene `api_key`. ProviderC registra URLs completas `.m3u8`, que pueden contener tokens o firmas temporales, además de todos los frames visitados.

**Impacto:** las credenciales y URLs reproducibles pueden aparecer en stdout, agregadores de logs, backups o soporte.

### A-04 — Caché de streams incorrecta para URLs temporales

La tabla no tiene `expires_at`, `last_verified_at`, estado de fallo ni origen/versionado. Todo stream directo activo se considera válido para siempre. Un 403/404 aguas arriba no causa refresh y el API devuelve URLs potencialmente caducadas. El scraper puede iniciar varias resoluciones iguales en paralelo y escribir duplicados.

**Impacto:** reproducción que deja de funcionar de manera permanente hasta intervención manual; exposición prolongada de URLs firmadas.

### A-05 — Controles de abuso insuficientes para Puppeteer

El limitador global está montado después de las rutas. Registro de usuario está abierto aunque la aplicación será privada. Cualquier cuenta puede disparar búsquedas/ingestas y resoluciones que crean procesos Chromium. Sólo existe un mutex en memoria para el cron, no para scraping por contenido ni entre réplicas.

**Impacto:** agotamiento rápido de CPU/RAM/PIDs en un VPS y llamadas masivas a terceros.

### A-06 — Refresh token débilmente gestionado

El refresh token se guarda en texto claro, sólo se permite uno por usuario y `refresh()` ignora `is_active`; una cuenta deshabilitada con refresh válido puede seguir obteniendo access tokens. No hay `jti`, familia, reutilización detectada, sesiones por dispositivo, hash en reposo, issuer/audience ni algoritmo fijado explícitamente.

### A-07 — Docker no es apto para producción Linux

- El archivo se llama `dockerfile`; Compose no indica `dockerfile:` y Linux distingue mayúsculas, por lo que el build predeterminado espera `Dockerfile`.
- Compose fuerza `NODE_ENV=development`, exponiendo stack traces.
- PostgreSQL publica `5432` y usa credenciales fijas versionadas.
- El bind mount `.:/app` convierte el contenedor en entorno de desarrollo y oculta artefactos de imagen.
- `depends_on` no espera a que PostgreSQL acepte conexiones; no hay healthcheck.
- Contenedor root, Chromium con `--no-sandbox`, imagen/base no fijada por digest, sin límites de recursos y sin init/graceful shutdown.
- El `CMD` shell arranca Xvfb en background; Node no queda claramente como PID 1 y el manejo de señales es deficiente.

### A-08 — Dependencias con vulnerabilidades conocidas

`npm audit` reportó 13 vulnerabilidades: 9 altas, 3 moderadas y 1 baja. Directas destacadas: `adm-zip` alta; `puppeteer-real-browser` alta por su cadena; `node-cron` moderada. Transitivas altas incluyen `extract-zip`, `basic-ftp`, `ws`, `ip-address`, `@puppeteer/browsers` y `rebrowser-puppeteer-core`. Deben actualizarse y volver a auditarse, sin aplicar `npm audit fix --force` a ciegas.

## MEDIO

### M-01 — Instalación y pruebas no reproducibles

- No existe script `test`; `npm test` falla.
- `npm ci --ignore-scripts` en una carpeta limpia falla porque el lock no incluye `fsevents@2.3.3` requerido por el árbol resuelto.
- El `node_modules` versionado carece de `node-unrar-js`, aunque es dependencia directa.
- Docker usa `npm install`, que puede modificar resolución en cada build.
- No hay lint, formatter, cobertura, CI ni smoke tests.

### M-02 — CORS y reverse proxy

`cors()` permite cualquier origen. Para una PWA privada debe existir allowlist explícita. Helmet aplica por defecto `Cross-Origin-Resource-Policy: same-origin`, lo que puede bloquear VTT si frontend y API usan orígenes distintos aun cuando CORS esté abierto. Tampoco se configura `trust proxy`; detrás de Nginx/Traefik, el rate limiting por IP será incorrecto o agrupará clientes bajo la IP del proxy.

### M-03 — Validación de entrada incompleta

No hay esquema de validación. `page=abc` o `limit=abc` produce `NaN` y termina como error SQL; UUID, `type`, email, password, `genre_id`, duración y TMDB ID no se validan consistentemente. Cualquier `type` distinto de `movie` se trata como serie en contenido. El error handler devuelve `err.message` incluso en producción, lo que puede filtrar detalles de PostgreSQL o terceros.

### M-04 — Bugs del historial

- Si se actualiza progreso sin duración, la duración previa se conserva pero `completed` vuelve a `false`.
- `duration_seconds || null` transforma `0` en `null`; no se rechazan duraciones negativas ni progreso mayor que duración.
- No se verifica que `content_id` exista ni que corresponda al tipo; no hay FK polimórfica.
- El listado no devuelve total/paginación completa y puede mostrar filas huérfanas con título nulo.

### M-05 — Flujo de series inconsistente

`getOrFetchContent(type=series)` consulta streams con `content_type='series'`, valor prohibido por el esquema (`movie|episode`). `processSeries` sólo crea episodios y no streams; por eso el detalle de una serie seguirá en `processing` y puede relanzar una importación completa en cada consulta. No se importan especiales (temporada 0) y episodios futuros se publican automáticamente.

### M-06 — Ingesta con errores silenciosos y duplicación

`processMovie`/`processSeries` capturan errores y resuelven normalmente; quien dispara el trabajo no puede distinguir éxito de fallo. El cron vive dentro del proceso web, por lo que cada réplica ejecuta su copia. No hay cola, lock distribuido, reintentos persistentes ni idempotencia completa. `upsertGenres` es secuencial, no transaccional y nunca elimina asociaciones obsoletas.

### M-07 — Cliente HTTP frágil

Los clientes basados en `https.get` no fijan timeouts, tamaño máximo, política de retry/backoff, status esperado o cancelación. Los redirects relativos pueden fallar y no hay límite de saltos. Las descargas completas se acumulan en memoria.

### M-08 — Modelo e ingesta TMDB imprecisos

La clasificación `rating` se inventa a partir de `adult` (`PG-13`/`TV-PG`), no de certificaciones. El normalizador de series no conserva `original_name` aunque la tabla tiene `original_title`. Los upserts no actualizan consistentemente rating, año, publicación y otros campos. Usar IDs TMDB en una columna `SERIAL` de géneros puede dejar la secuencia desalineada para inserciones locales futuras.

### M-09 — Almacenamiento local de subtítulos

Los VTT viven en el filesystem del contenedor y no hay volumen de producción, limpieza, límite, atomicidad ni coordinación entre réplicas. Hay un VTT generado ya versionado. `API_BASE_URL` manual puede producir URLs HTTP o host incorrecto detrás de TLS/proxy.

### M-10 — Esquema sin integridad/migraciones suficientes

Las relaciones polimórficas de streams, historial, géneros y logs no aseguran existencia del contenido. Faltan checks útiles (progreso/duración no negativos, al menos una URL de stream, estados permitidos), timestamps de actualización coherentes y estrategia de migración/versionado.

## BAJO

### B-01 — Código muerto y duplicado

- `baseProvider.js` y `linkExtractor.js` no se usan.
- `replaceStreams`, `findEpisodeWithSeries`, `getStreamsByContent` y `getRecentLogs` no se consumen.
- `SALT_ROUNDS` y `bcrypt` en `auth.service.js` son imports/constantes sin uso.
- `SUBDL_API_KEY` y `srtToVtt` están definidos y no se usan; `AdmZip` se importa dos veces.
- Se consulta la suscripción para streams, pero `formatResponse` no la usa y `show_ads` siempre es `false`.
- `.gitignor` duplica el `.gitignore` roto.
- `tmp/search.js` contiene un comando shell, no JavaScript; `test-search.js` es un script exploratorio con URL fija, sin aserciones.

### B-02 — Calidad y operabilidad

Nombres/mensajes mezclan español e inglés, hay comentarios de desarrollo (“nuevo”), logging no estructurado, ausencia de correlation ID/métricas y respuestas no totalmente consistentes. No hay documentación de requisitos ni licencia declarada.

## Comandos y resultados

| Comprobación | Resultado |
|---|---|
| Clonado de `main` | Correcto |
| `node --check` sobre 52 JS del proyecto | 51 correctos; falla sólo `tmp/search.js`, que no es JS válido |
| Carga de `src/app` con variables ficticias y `NODE_ENV=test` | Correcta |
| `npm ls --depth=0` | Falla: dependencia directa `node-unrar-js@^2.0.2` ausente del árbol versionado |
| `npm test` | Falla: no existe script `test` |
| `npm ci --ignore-scripts` en carpeta limpia | Falla: `package.json`/lock no sincronizados; falta `fsevents@2.3.3` |
| `npm audit --json` | 13 vulnerabilidades: 9 altas, 3 moderadas, 1 baja |
| `npm outdated --json` | Hay majors pendientes en adm-zip, bcryptjs, Express, express-rate-limit, Helmet y node-cron; `pg` tiene actualización compatible |
| `node server.js` sin variables inyectadas | Falla en `Missing required env var: PORT`; el proyecto no carga `.env` por sí mismo |
| Docker build/Compose/SQL real | No comprobable: Docker no está instalado en el host de auditoría |
| PostgreSQL e integración API | No comprobable: no hay servicio PostgreSQL disponible |
| TMDB/SubDL/scraping/reproducción | No ejecutado: requeriría usar credenciales expuestas y proveedores externos; se auditó estáticamente |

## Corrección del historial Git

No basta con añadir `.env` a `.gitignore`: ya existe en el commit inicial.

1. Rotar primero todas las credenciales indicadas y revocar sesiones/tokens.
2. Coordinar una ventana de mantenimiento: reescribir historial cambia SHAs y obliga a colaboradores a reclonar o resetear sus ramas.
3. En una copia espejo y con `git-filter-repo` instalado, eliminar sólo `.env` de toda la historia:

```bash
git clone --mirror https://github.com/zamzze/kanchita-backend.git
cd kanchita-backend.git
git filter-repo --path .env --invert-paths
git push --force --mirror
```

4. Si se decide purgar también artefactos, hacer una segunda operación explícita para `node_modules/`, `tmp/` y VTT generados; revisar antes las rutas exactas.
5. Invalidar caches/artefactos externos cuando sea posible y activar secret scanning/push protection. Considerar todo valor histórico comprometido incluso después del rewrite.

## Decisión de stack

No hay una razón técnica fuerte para abandonar Express + PostgreSQL. La prioridad es alinear esquema/código, reforzar autenticación y límites, separar trabajos pesados y volver reproducible el despliegue. Un cambio de framework ahora añadiría riesgo sin resolver las causas principales.


