# Kanchita Backend

Backend personal de catálogo y reproducción multimedia construido con Express y PostgreSQL. Esta rama conserva la arquitectura existente y se limita a hacer el repositorio instalable y verificable de forma reproducible.

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

El smoke test fuerza `NODE_ENV=test`, carga la aplicación Express y comprueba que no se programe la ingesta. Utiliza configuración ficticia, no abre una conexión PostgreSQL y no llama a TMDB, SubDL ni proveedores de streams. `npm test` también descubre las pruebas PostgreSQL; si `TEST_DB_URL` no está definido, se muestran como omitidas.

Para ejecutar explícitamente las pruebas de migración contra PostgreSQL 15:

```bash
TEST_DB_URL=postgresql://user:password@localhost:5432/test_db npm run test:db
```

La base indicada debe ser exclusiva para pruebas. Los tests crean y eliminan esquemas aislados dentro de ella.

## Integración continua

GitHub Actions ejecuta `npm ci`, el smoke test y las pruebas de migración contra un servicio PostgreSQL 15 real en cada pull request hacia `main` y cada push a `main`. Una ejecución verde valida la Fase 1B sobre una base vacía y sobre el baseline legacy, incluida la idempotencia, subtítulos y el upsert de streams.

`npm audit` también se ejecuta para dar visibilidad, pero permanece informativo mientras se resuelven de forma controlada las vulnerabilidades heredadas. La seguridad HTTP/JWT continúa pendiente y no forma parte de este workflow.

## Documentación técnica

- [Arquitectura](ARCHITECTURE.md)
- [Auditoría](AUDIT.md)
- [Roadmap](ROADMAP.md)

Los problemas de esquema, autenticación, caché, scraping y despliegue final descritos en la auditoría pertenecen a fases posteriores.

