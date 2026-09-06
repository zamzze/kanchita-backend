# Fast Stream Engine

## Objetivo y flujo

```text
DETAIL → POST prepare → PostgreSQL job → worker → ProviderManager
       → direct provider o browser slot → child resolver → HLS validator
       → streams ready

PLAY → GET stream → ready 200
                   → pending 202
                   → lifecycle backoff 503
```

El request HTTP nunca ejecuta el resolver pesado. Un stream `ready`, vigente y verificado recientemente se comparte entre todos los usuarios sin Chromium. Un único índice parcial deduplica `pending|processing` por `(content_type, content_id)`.

## Prioridad y prewarm

Los jobs guardan prioridad 0–100 y tipo `resolve|refresh`; el claim usa `priority DESC, run_after ASC, created_at ASC` con `FOR UPDATE SKIP LOCKED`. Prepare usa 100, siguiente episodio 90, expiración próxima 80, actividad/popularidad reciente 50–70 y refresh normal 50. Re-encolar el mismo contenido eleva prioridad sin duplicarlo.

El scheduler del worker toma como máximo `STREAM_PREWARM_BATCH_SIZE` candidatos. No recorre ni resuelve todo el catálogo. El siguiente episodio se obtiene con una consulta ordenada y `LIMIT 1`, sólo para contenido publicado y respetando cache/backoff/dedup.

## ProviderManager y browser budget

Cada provider declara estrategia, soporte movie/episode, idiomas, quality hint y coste. Se prueban directos antes de browser. ProviderC es el único activo productivo y permanece en el child aislado de Fase 2C.

`stream_browser_slots` es un semáforo PostgreSQL global. El worker adquiere atómicamente un slot libre o vencido; renueva su lease mientras ejecuta; libera en `finally`. Un proceso muerto deja de renovar y otro worker recupera el slot tras el vencimiento. Default operativo: API 1, worker 1, máximo browser global 1. Los direct providers no usan slots.

## Lifecycle y refresh

El TTL fallback es 60 minutos, verificación 10 minutos y refresh-ahead 10 minutos. Si una fila sigue válida pero se acerca a `expires_at`, el API devuelve 200 y crea un job `refresh`. El worker no invalida primero la fila actual. Un resultado correcto la reemplaza; un fallo registra contador/backoff, pero conserva `ready` y URL mientras siga vigente.

El validator sigue siendo SSRF fail-closed, limita tiempo/bytes/redirects y no descarga segmentos. Para inspeccionar limpieza entrega el manifest sólo en memoria al consumidor interno; nunca lo persiste ni registra.

## Limpieza, idioma y scoring

El inspector reconoce marcadores HLS CUE, DATERANGE y SCTE y clasifica `clean|unknown|ad_marked`. No elimina anuncios ni altera playlists. Por defecto una fuente marcada se rechaza.

El score conserva este orden por bandas no solapadas: limpieza → ready/rapidez → direct/no browser → calidad → idioma. Audio y subtítulo se guardan por separado. `en-sub` legacy migra a audio `en`, subtítulo `es`; se normalizan `es-419`, variantes mexicanas, `es`, `en` y `unknown`.

## Circuit breaker, métricas y health

`stream_provider_health` agrega éxito, fallo, fallos consecutivos, duración y cooldown. Cinco fallos consecutivos abren 5 minutos por defecto; un éxito reinicia el circuito. No se almacenan URLs ni mensajes externos.

`stream_metrics` sólo admite nombres allowlisted y guarda contadores/duraciones sin labels. KPI derivados:

- First Request Ready Rate = `stream_ready_first_request_total / stream_requests_total`.
- Browser Fallback Rate = `browser_resolution_total / provider_resolution_total`.

Son definiciones operativas; no se afirma ningún objetivo alcanzado sin datos reales.

`/health/live` sólo confirma proceso. `/health/ready` comprueba DB y migración 006, nunca providers. `/api/internal/stream-health` requiere JWT y devuelve agregados de queue, slots, heartbeat, provider health y métricas; no expone URL, PID, worker ID ni secretos.

## Límites conocidos

- ProviderC no declara expiración y depende del TTL local.
- No hay provider Latino productivo autorizado; el fallback es audio original y subtítulo español.
- El lease se renueva de forma cooperativa; una pausa extrema del event loop puede retrasarlo.
- El backend aún no recibe señal de fallo real del playback/segmentos desde el cliente.
- El almacenamiento VTT local y límites de archivos de subtítulos requieren hardening posterior.
