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

El caché de streams directos usa por defecto TTL de 60 minutos, reverificación cada 10 minutos, timeout remoto de 5 segundos y manifests de hasta 256 KiB. Se configuran con `STREAM_CACHE_TTL_MINUTES`, `STREAM_VERIFY_INTERVAL_MINUTES`, `STREAM_VERIFY_TIMEOUT_MS` y `STREAM_MAX_MANIFEST_BYTES`. `STREAM_LOCK_TIMEOUT_MS` limita a 5 segundos la espera del single-flight PostgreSQL.

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

Para ejecutar el validador HLS y las pruebas de lifecycle/single-flight:

```bash
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:streams
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

Las filas legacy se conservan como `unknown` y se validan al primer acceso. Una validación correcta las promueve a `ready` y aplica el TTL si no tenían expiración. Una URL expirada no se valida ni se devuelve: se intenta resolver de nuevo mediante el adapter existente. Una resolución correcta reinicia fallos y tiempos; un fallo usa códigos internos estables y backoff de 30 segundos, 2, 5 y hasta 15 minutos.

La resolución se serializa con un advisory lock PostgreSQL por `(content_type, content_id)`. El lock utiliza un cliente dedicado, adquisición no bloqueante con timeout, liberación en `finally` y relectura de caché después de obtenerlo. Películas y episodios comparten exactamente el mismo algoritmo. La API continúa devolviendo la URL directa y no expone estado, proveedor, fallos ni locks.

## Integración continua

GitHub Actions ejecuta `npm ci`, el smoke test, las protecciones HTTP, migraciones, sesiones y lifecycle de streams contra PostgreSQL 15 real. La suite HLS usa exclusivamente un servidor HTTP local controlado y no contacta proveedores externos.

`npm audit` también se ejecuta para dar visibilidad, pero permanece informativo mientras se resuelven de forma controlada las vulnerabilidades heredadas.

## Documentación técnica

- [Arquitectura](ARCHITECTURE.md)
- [Auditoría](AUDIT.md)
- [Roadmap](ROADMAP.md)

Los problemas de esquema, autenticación, caché, scraping y despliegue final descritos en la auditoría pertenecen a fases posteriores.

