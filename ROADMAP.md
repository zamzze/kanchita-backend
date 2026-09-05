# Roadmap de Kanchita Backend

## Principios

- Mantener Express + PostgreSQL.
- No retirar funcionalidades sin una prueba de reemplazo o una justificación registrada.
- Tratar scraping, resolución y subtítulos como trabajo limitado, observable y reemplazable por proveedor.
- No incluir técnicas de evasión de DRM ni integraciones con contenido protegido de Netflix, Hulu, Max, Disney+ u otros servicios equivalentes.
- Separar configuración de desarrollo y producción y hacer cada build reproducible.

## Fase 1 — Saneamiento backend

**Objetivo:** recuperar una base segura, instalable y comprobable antes de ampliar funcionalidad.

### P0: contención de secretos

1. Rotar contraseña/usuario de PostgreSQL si fueron operativos o reutilizados; rotar `JWT_SECRET`, `JWT_REFRESH_SECRET`, TMDB y SubDL.
2. Invalidar refresh tokens existentes y revisar consumo/logs de proveedores.
3. Sustituir `.gitignore`, poblar `.env.example`, retirar `.env`, `node_modules`, `.gitignor`, `tmp/search.js` y VTT generado del índice sin borrar copias locales necesarias.
4. Reescribir historial con `git-filter-repo` tras coordinar el force-push y exigir reclonado.

### P0: restaurar contrato esquema-código

1. Introducir una herramienta ligera de migraciones PostgreSQL y capturar el esquema actual como baseline.
2. Crear migración para `subtitles` con unicidad `(content_type, content_id, language)` e índices.
3. Añadir la restricción/índice único que exige `streams.upsertStream`; decidir cómo tratar `server_name NULL`.
4. Añadir checks de duración/progreso, URL de stream y estados; documentar la estrategia para integridad polimórfica.
5. Probar migración desde base vacía y desde un snapshot representativo; no confiar sólo en `docker-entrypoint-initdb.d`.

### P0/P1: ejecución reproducible

1. Regenerar `package-lock.json` en una rama, revisar el diff y comprobar `npm ci` en Linux/Node 20.
2. Retirar `node_modules` del repositorio; usar `npm ci --omit=dev` en producción.
3. Renombrar `dockerfile` a `Dockerfile` o declarar la ruta explícita.
4. Separar `compose.yml` de desarrollo y override de producción; eliminar bind mount y `NODE_ENV=development` en producción.
5. Añadir healthchecks, espera de PostgreSQL, red interna, volumen explícito de subtítulos si se conserva almacenamiento local, usuario no root, init y señales correctas.
6. No publicar PostgreSQL al exterior en producción; inyectar secretos fuera de Git.

### P1: seguridad y robustez HTTP

1. Mover el limitador global antes de rutas; configurar `trust proxy` de forma exacta y usar almacén compartido si hay múltiples réplicas.
2. Allowlist CORS por entorno y política CORP/CSP compatible con el origen real de la PWA y VTT.
3. Proteger el endpoint de subtítulos; cerrar registro público mediante bootstrap/invitación/configuración privada.
4. Validar cuerpos, params y queries con esquemas; normalizar email y respuestas de error; ocultar mensajes internos.
5. Guardar hashes de refresh tokens en tabla de sesiones, verificar `is_active`, usar `jti`/familias y fijar algoritmo, issuer y audience.
6. Eliminar claves y URLs firmadas de logs; adoptar logging estructurado con redacción.

### P1: pruebas mínimas y observabilidad

1. Unit tests para JWT, normalizadores, paginación, progreso y conversión de subtítulos.
2. Integration tests contra PostgreSQL efímero para auth, catálogos, historial, streams y migraciones.
3. Contratos simulados para TMDB/SubDL/proveedor; no depender de Internet en CI.
4. Smoke test de Compose en Linux y CI con `npm ci`, lint, tests, audit y build.
5. Endpoints `/health/live` y `/health/ready`, graceful shutdown y métricas básicas.

### Criterio de salida

- Cero secretos en árbol/historia vigente y claves rotadas.
- `npm ci`, tests, migraciones y Docker build pasan en CI Linux.
- Base vacía y base actual actualizan sin error.
- Registro privado, CORS, rate limiting y errores verificados detrás del proxy elegido.
- Las vulnerabilidades altas están corregidas o aceptadas por escrito con mitigación/fecha.

## Fase 2 — Estabilización de reproducción

1. Modelar ciclo de vida de stream: `resolved_at`, `expires_at`, `last_verified_at`, fallos, proveedor y estado.
2. Verificar/re-resolver URLs caducadas sin exponerlas en logs ni cachearlas en intermediarios.
3. Lock por contenido, límites de concurrencia, timeout, backoff, circuit breaker y cola persistente para Chromium.
4. Separar el worker de scraping del proceso HTTP cuando el comportamiento esté cubierto por pruebas.
5. Definir interfaz de proveedor y eliminar código muerto tras probar equivalencia.
6. Endurecer descargas de subtítulos: límites de bytes/entradas/ratio, timeout, MIME, redirects y limpieza; almacenamiento persistente u objeto compatible con múltiples réplicas.
7. Añadir pruebas de reproducción HLS autorizada, selección de calidad, CORS de segmentos y sincronía de VTT.

## Fase 3 — API preparada para frontend

1. Especificación OpenAPI versionada y contrato uniforme de errores/paginación.
2. Separar IDs locales/TMDB explícitamente y validar tipos de contenido.
3. Endpoints de home, continue-watching, búsqueda unificada, detalle de episodio y estados asíncronos de resolución.
4. ETags/cache-control para metadatos; `no-store` para tokens y URLs temporales.
5. Sesiones/dispositivos, perfil privado y administración mínima.
6. Corregir certificaciones, temporadas especiales, fechas de emisión y localización de TMDB.

## Fase 4 — Nueva PWA/web

1. Definir UX privada y matriz de navegadores/dispositivos antes de elegir librerías.
2. Cliente tipado desde OpenAPI, autenticación segura y renovación coordinada de sesión.
3. Reproductor HLS, pistas VTT, recuperación de errores y actualización de progreso con debounce/offline queue.
4. Manifest, service worker y caché sólo de metadatos/assets; nunca persistir URLs firmadas más allá de su vigencia.
5. Accesibilidad, responsive/TV-friendly y pruebas E2E.

## Fase 5 — Despliegue Docker en VPS

1. Imagen multi-stage reproducible, usuario no root, Chromium y librerías fijados/probados.
2. Reverse proxy TLS, headers, límites de petición, allowlist CORS y rate-limit compartido.
3. PostgreSQL privado, backups cifrados, restauración ensayada y migraciones como paso controlado.
4. Secretos mediante variables/archivos del host con permisos mínimos; nunca en imagen/Compose versionado.
5. Volúmenes, cuotas, rotación de logs, límites CPU/RAM/PID y alertas de disco/memoria/fallos de proveedor.
6. Despliegue canary/rollback, healthchecks y prueba de reinicio completo del VPS.

## Fase 6 — Posible reutilización de la app Android TV

1. Inventariar versión de Android, networking, autenticación, reproductor y contratos asumidos.
2. Mantener compatibilidad mediante versionado `/api/v1` o adaptador; no congelar errores del contrato antiguo.
3. Evaluar HLS/VTT, navegación con mando, refresh tokens por dispositivo y telemetría mínima.
4. Decidir reutilización, migración incremental o cliente nuevo sólo después de estabilizar la API/PWA.

## Cambios concretos propuestos para la primera PR

Una primera PR debería ser pequeña y revisable: corregir `.gitignore`/`.env.example`; retirar artefactos del índice; regenerar lock; añadir test de carga y CI; mover limitador; cerrar/proteger registro y subtítulos mediante flags; dejar de registrar secretos/URLs; añadir validación básica; crear migraciones de `subtitles` y unicidad de streams; corregir refresh de usuario deshabilitado; y preparar Docker/Compose de desarrollo con healthcheck. El saneamiento del historial y la rotación de secretos deben ejecutarse como procedimiento operativo separado, antes o inmediatamente después de fusionar.


