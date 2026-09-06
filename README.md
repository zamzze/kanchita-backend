# Kanchita Backend

Backend personal de catálogo y reproducción multimedia construido con Express y PostgreSQL. El proyecto conserva su API actual y dispone de instalación reproducible, migraciones, controles HTTP básicos y sesiones de autenticación rotativas.

## Requisitos

- Node.js 20
- npm incluido con Node.js 20
- PostgreSQL 15, o Docker con Docker Compose para el entorno de desarrollo
- Credenciales propias para TMDB y SubDL cuando se prueben esas integraciones

## Configuración

Copia el archivo de ejemplo y reemplaza únicamente los placeholders:

```bash
cp .env.example .env
```

En PowerShell:

```powershell
Copy-Item .env.example .env
```

La configuración incluye conexión PostgreSQL, secretos JWT, URL pública del API y claves de proveedores externos. Los secretos deben ser independientes, aleatorios y administrarse fuera de Git.

**Nunca versiones un `.env` real ni pegues credenciales en issues, commits, documentación o logs.**

Al ejecutar Node directamente en el host, cambia el hostname de `DB_URL` de `postgres` a `localhost`. Dentro de Docker Compose debe permanecer `postgres`.

`CORS_ORIGINS` es una lista de orígenes web exactos separados por comas. Las peticiones de clientes nativos o servidor-a-servidor sin cabecera `Origin` siguen permitidas. Una petición de navegador con un origen no configurado recibe `403`; no hardcodees aquí el futuro dominio del VPS.

El registro público está cerrado por defecto. `ALLOW_PUBLIC_REGISTRATION` sólo lo habilita cuando su valor es exactamente `true`; úsalo temporalmente para aprovisionamiento controlado y vuelve a `false` después. El login permanece público.

`JWT_ISSUER`, `JWT_ACCESS_AUDIENCE` y `JWT_REFRESH_AUDIENCE` forman parte del contrato criptográfico. Los valores deben ser coherentes en todas las réplicas y no deben cambiarse sin forzar un nuevo login de los clientes.

El caché de streams directos usa por defecto TTL de 60 minutos, reverificación cada 10 minutos, timeout remoto de 5 segundos y manifests de hasta 256 KiB. Se configuran con `STREAM_CACHE_TTL_MINUTES`, `STREAM_VERIFY_INTERVAL_MINUTES`, `STREAM_VERIFY_TIMEOUT_MS` y `STREAM_MAX_MANIFEST_BYTES`.

La resolución pesada se ejecuta en un child process aislado por cada job. La cola usa por defecto polling cada segundo, lease de 180 segundos, tres intentos y timeout de resolución de 90 segundos. `STREAM_RESOLVER_KILL_GRACE_MS=2000` controla el margen entre terminación limpia y kill forzado; `STREAM_PENDING_RETRY_SECONDS=2` controla el `Retry-After` sugerido por el API.

El Fast Stream Engine limita Chromium globalmente con PostgreSQL (`STREAM_BROWSER_MAX_CONCURRENT=1`), renueva leases de slots, prepara como máximo `STREAM_PREWARM_BATCH_SIZE=10` candidatos por ciclo y refresca en background desde `STREAM_REFRESH_AHEAD_MINUTES=10`. `STREAM_REJECT_AD_MARKED=true` rechaza manifests con marcadores publicitarios estándar sin modificarlos. ProviderC continúa siendo fallback browser; no hay un provider directo productivo configurado.

## Instalación reproducible

```bash
npm ci
```

El lockfile está destinado a Node 20 y debe actualizarse de forma deliberada. No uses `npm install` sólo para corregir automáticamente alertas de seguridad sin revisar el cambio.

## Esquema y migraciones

Los archivos ordenados de `database/migrations/` son la fuente de verdad del esquema. `database/init.sql` es un wrapper para bases nuevas creadas por la imagen oficial de PostgreSQL y ejecuta esos mismos archivos; no mantiene una segunda copia del DDL.

Ejecuta las migraciones después de configurar `DB_URL`, antes de arrancar una versión nueva del API:

```bash
npm run migrate
```

El runner:

- aplica archivos pendientes en orden y dentro de una transacción;
- registra versión, checksum y fecha en `schema_migrations`;
- usa un advisory lock de PostgreSQL para impedir dos ejecuciones simultáneas;
- rechaza cambios en una migración ya aplicada.

Para consultar la versión instalada:

```sql
SELECT version, checksum, applied_at
FROM schema_migrations
ORDER BY version;
```

## Desarrollo local

Con PostgreSQL disponible y `.env` configurado:

```bash
npm run dev
```

El script de desarrollo utiliza el soporte `--env-file` de Node 20 para cargar `.env`. El arranque normal espera que las variables ya hayan sido inyectadas por el entorno:

```bash
npm start
```

Después de migrar la base, ejecuta el API y el worker en procesos separados:

```bash
npm start
npm run worker:streams
```

El API nunca inicia el worker automáticamente.

## Docker Compose de desarrollo

```bash
docker compose build
docker compose up
```

En una base nueva, `database/init.sql` deja el esquema en la versión actual. El runner debe ejecutarse igualmente para registrar las versiones:

```bash
docker compose run --rm api npm run migrate
```

El Compose actual es únicamente para desarrollo. No debe utilizarse como configuración final de un VPS.

## Smoke test

```bash
npm test
```

El smoke test fuerza `NODE_ENV=test`, carga la aplicación Express y comprueba que no se programe la ingesta. Utiliza configuración ficticia, no abre una conexión PostgreSQL y no llama a TMDB, SubDL ni proveedores de streams. `npm test` también ejecuta las protecciones HTTP y descubre las pruebas PostgreSQL; si `TEST_DB_URL` no está definido, estas últimas se muestran como omitidas.

Para ejecutar únicamente los tests HTTP:

```bash
npm run test:http
```

Para ejecutar las pruebas de sesiones contra PostgreSQL 15:

```bash
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:auth
```

Para ejecutar el validador HLS y las pruebas de lifecycle:

```bash
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:streams
```

Para ejecutar la cola y el worker por separado:

```bash
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:queue
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:worker
npm run test:resolver-process
npm run test:boundary
npm run test:providers
npm run test:subtitles
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:fast-stream
```

La resolución mediante `/api/subtitles` requiere Bearer JWT. Los `.vtt` ya generados continúan disponibles en `/subtitles` para el reproductor; CORS y `Cross-Origin-Resource-Policy: cross-origin` limitan/permiten su consumo desde los orígenes configurados.

Para ejecutar explícitamente las pruebas de migración contra PostgreSQL 15:

```bash
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:db
```

La base indicada debe ser exclusiva para pruebas. Los tests crean y eliminan esquemas aislados dentro de ella. `npm test` ejecuta tanto `test:db` como `test:auth` cuando `TEST_DB_URL` está definido.

## Sesiones de autenticación

Cada login crea una fila independiente en `auth_sessions`, de modo que navegador, teléfono y TV pueden mantener sesiones simultáneas. PostgreSQL sólo recibe el SHA-256 del refresh token; el JWT completo nunca se persiste. SHA-256 resulta apropiado aquí porque los tokens son valores aleatorios de alta entropía y la comparación se realiza en tiempo constante.

Cada refresh rota el token dentro de una transacción con bloqueo de fila. Presentar de nuevo un token ya rotado revoca la sesión completa, incluido su token más reciente. Logout revoca únicamente la sesión indicada por `sid`; no existe todavía logout global. Un access token emitido antes del logout continúa siendo criptográficamente válido hasta su expiración corta (15 minutos por defecto), pero esa sesión ya no puede renovar tokens.

La migración `003_auth_sessions.sql` borra todos los valores legacy de `users.refresh_token` sin copiarlos. Después de actualizar, las sesiones anteriores deben iniciar login nuevamente.

## Lifecycle de streams directos

`streams.status` utiliza `unknown`, `ready`, `stale` y `failed`. Una fila `ready`, no expirada y verificada dentro del intervalo configurado es un cache hit sin tráfico remoto. Una fila antigua se valida mediante un GET acotado del manifest: sólo HTTP/HTTPS, redirects limitados, timeout, límite de bytes y cabecera `#EXTM3U`; nunca se descargan segmentos ni se actúa como proxy HLS.

Antes de cada conexión —incluidos todos los redirects— el validador resuelve todas las direcciones DNS y rechaza destinos loopback, privados, link-local, CGNAT, multicast, reservados o no globales. La conexión usa una resolución fijada a una IP ya aprobada y desactiva reutilización del agente para evitar una segunda consulta DNS independiente. `allowPrivateNetworks` existe únicamente como dependencia explícita de pruebas para fixtures localhost; no es una variable operativa ni está habilitada en producción.

Las filas legacy se conservan como `unknown` y se validan al primer acceso. Una validación correcta las promueve a `ready` y aplica el TTL si no tenían expiración. Una URL expirada no se valida ni se devuelve: el API crea o reutiliza un job persistente. Una resolución correcta del worker reinicia fallos y tiempos; un fallo usa códigos internos estables y backoff de 30 segundos, 2, 5 y hasta 15 minutos.

## Cola y worker de resolución

Si no hay stream usable, `GET /api/streams/movie/:id` y `GET /api/streams/episode/:id` responden `202 Accepted`, cabecera `Retry-After: 2` y:

```json
{
  "success": true,
  "data": {
    "status": "pending",
    "code": "STREAM_RESOLUTION_PENDING",
    "retry_after_ms": 2000
  }
}
```

El cliente consulta de nuevo el mismo endpoint. Obtiene `200` cuando `streams` contiene una fila usable, `202` mientras exista trabajo activo y `503 STREAM_TEMPORARILY_UNAVAILABLE` durante el backoff del lifecycle. Un ID inexistente continúa devolviendo `404` y nunca crea un job.

`stream_resolution_jobs` admite `pending`, `processing`, `completed` y `failed`. Un índice único parcial garantiza un solo job `pending|processing` por `(content_type, content_id)`. Cada worker reclama una fila mediante `FOR UPDATE SKIP LOCKED`, asigna `locked_by`/`locked_at` y confirma la transacción antes de llamar al resolver. La red y Chromium nunca se ejecutan dentro de una transacción o lock PostgreSQL.

`attempt_count` aumenta únicamente cuando un worker reclama trabajo real, nunca por enqueue, polling o recuperación de lease, y no puede superar `max_attempts`. Los fallos recuperables reintentan con backoff de 30 segundos, 2 minutos y 5 minutos. Los jobs cuyo lease expiró vuelven a `pending`, o terminan `failed` si agotaron intentos. El lease debe superar timeout + kill grace por al menos 30 segundos (defaults: 180 s frente a 90 s + 2 s); una configuración insegura impide iniciar el worker. Tras `SIGINT`/`SIGTERM`, deja de iniciar claims, termina el árbol resolver activo y espera que quede recolectado antes de cerrar PostgreSQL. Películas y episodios comparten cola, procesador, validator y lifecycle.

El antiguo advisory lock de resolución síncrona fue retirado: single-flight pertenece ahora al índice parcial y al claim atómico. La tabla de jobs no almacena URLs, manifests, tokens, payloads externos ni mensajes arbitrarios.

## Fast Stream Engine

Los endpoints autenticados `POST /api/streams/movie/:id/prepare` y `POST /api/streams/episode/:id/prepare` permiten adelantar trabajo desde una pantalla de detalle. Devuelven `200 STREAM_ALREADY_READY`, `202 STREAM_PREPARING`, `404` o el `503` de backoff existente; nunca llaman al resolver. El enqueue es idempotente y eleva la prioridad del job activo hasta 100.

El worker reclama por `priority DESC, run_after ASC, created_at ASC`. El prewarm acotado prioriza expiración próxima y actividad reciente; al consumir un episodio puede preparar sólo su siguiente episodio publicado. Un stream aún válido próximo a vencer sigue sirviéndose y recibe un job `refresh`: si el refresh falla, la URL vigente no se degrada antes de expirar.

`ProviderManager` prueba estrategias directas antes del fallback browser. Los proveedores declaran capacidades; el único productivo actual es `provider_c`, clasificado como browser/costoso/fallback y ejecutado dentro del child aislado. Antes de Chromium adquiere un slot global PostgreSQL con lease renovable. Varios workers pueden reclamar jobs distintos, pero por defecto sólo uno entra al resolver browser; un crash libera capacidad al vencer el lease.

El manifest validado se inspecciona pasivamente como `clean`, `unknown` o `ad_marked`; no se reescribe ni se eliminan segmentos. Audio y subtítulo se normalizan por separado, conservando compatibilidad con `en-sub`. SubDL permanece primero; OpenSubtitles REST es un fallback opcional desactivado por defecto y requiere sus propias credenciales.

Las sondas públicas `/health/live` y `/health/ready` no contactan proveedores. `/api/internal/stream-health` requiere access JWT y expone sólo agregados de cola, browser, workers, providers y métricas. Consulta [Fast Stream Engine](docs/FAST_STREAM_ENGINE.md) y [auditoría de providers](docs/STREAM_PROVIDERS_AUDIT.md).

La fijación de la IP elimina la ventana habitual entre pre-resolución y conexión, pero no convierte al destino público en confiable: un servidor público aprobado todavía podría actuar como proxy hacia redes internas o cambiar su comportamiento. La política de redirects sólo controla destinos visibles en la respuesta HTTP.

El `ResolverExecutor` crea un único child mediante IPC por worker. Sólo transmite metadata validada; el child devuelve `SUCCESS` con el resultado mínimo o `FAILURE` con un código estable. No recibe `DB_URL`, secretos JWT ni credenciales en argv. En Linux el child es líder de un process group aislado: timeout o shutdown envían `SIGTERM` al PGID, esperan el grace y aplican `SIGKILL` residual al mismo grupo; después de un crash también se limpia el PGID antes de resolver la operación. Así el worker no inicia el siguiente job hasta que el child quedó recolectado; un timeout vuelve a ser reintentable y ya no exige reciclar el worker.

En Windows se intenta `taskkill /T` sobre el PID exacto y existe fallback al child directo. La garantía fuerte de cierre del árbol corresponde al process group POSIX validado en Linux CI, que es el objetivo de despliegue. No se usan patrones globales ni se matan procesos Chromium ajenos.

## Integración continua

GitHub Actions ejecuta `npm ci`, smoke, HTTP, migraciones, sesiones, lifecycle, cola y worker contra PostgreSQL 15 real. Las suites de streams usan exclusivamente fixtures/inyecciones locales y no contactan proveedores externos.

`npm audit` también se ejecuta para dar visibilidad, pero permanece informativo mientras se resuelven de forma controlada las vulnerabilidades heredadas.

## Documentación técnica

- [Arquitectura](ARCHITECTURE.md)
- [Auditoría](AUDIT.md)
- [Roadmap](ROADMAP.md)

Los problemas de esquema, autenticación, caché, scraping y despliegue final descritos en la auditoría pertenecen a fases posteriores.

