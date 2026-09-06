# Contrato de integración del backend MVP

## Base URL y autenticación

La PWA configura el origen del API (por ejemplo, `http://localhost:3000`) y añade las rutas `/api/...`. Salvo login y refresh, todos los endpoints de esta guía requieren:

```http
Authorization: Bearer <accessToken>
```

Las respuestas JSON usan `{ "success": true, "data": ... }`. Los errores usan `{ "success": false, "code": "...", "message": "..." }`.

## Auth

| Método | Path | Auth | Request | 200 | 202 | 404 | 503 |
|---|---|---|---|---|---|---|---|
| POST | `/api/auth/login` | No | `{"email":"...","password":"..."}` | `data.user`, `data.accessToken`, `data.refreshToken` | — | — | — |
| POST | `/api/auth/refresh` | No | `{"refresh_token":"..."}` | nuevos `accessToken` y `refreshToken`; reemplazar ambos | — | — | — |
| POST | `/api/auth/logout` | Sí | sin body | revoca sólo la sesión `sid` actual | — | — | — |

Login puede responder 401 por credenciales y 403 por cuenta deshabilitada. Refresh puede responder 401 si expiró, fue revocado o reutilizado. Logout no invalida las otras sesiones; el access token actual puede vivir hasta su expiración corta.

## Home y catálogo

| Método | Path | Auth | Request | 200 | 202 | 404 | 503 |
|---|---|---|---|---|---|---|---|
| GET | `/api/movies?page=1&limit=20&genre_id=<id>` | Sí | query opcional | `data.items[]` y `data.pagination` | — | — | — |
| GET | `/api/series?page=1&limit=20&genre_id=<id>` | Sí | query opcional | `data.items[]` y `data.pagination` | — | — | — |
| GET | `/api/movies/genres` | Sí | — | géneros `{id,name,slug}[]` | — | — | — |

No existe un endpoint `/home`: la pantalla Home compone las listas de películas y series.

## Búsqueda y detalles

| Método | Path | Auth | Request | 200 | 202 | 404 | 503 |
|---|---|---|---|---|---|---|---|
| GET | `/api/content/search?q=<texto>&type=movie\|series` | Sí | `q` mínimo 2 caracteres | hasta 5 resultados TMDB con `in_catalog` y `local_id` | — | — | — |
| GET | `/api/content/:tmdbId?type=movie\|series` | Sí | TMDB ID | detalle local/importado; puede iniciar preparación | — | — | — |
| GET | `/api/movies/:movieId` | Sí | UUID local | metadata y géneros de película | — | `NOT_FOUND` | — |
| GET | `/api/series/:seriesId` | Sí | UUID local | metadata, géneros y temporadas | — | `NOT_FOUND` | — |
| GET | `/api/series/:seriesId/seasons/:season` | Sí | UUID + temporada positiva | episodios publicados de la temporada | — | `NOT_FOUND` | — |
| GET | `/api/series/episodes/:episodeId` | Sí | UUID local | metadata de episodio y de su serie para EpisodeWatch | — | `EPISODE_NOT_FOUND` | — |

El detalle de episodio incluye `id`, `series_id`, `tmdb_id`, `season_number`, `episode_number`, `title`, `description`, `duration_seconds`, `thumbnail_url`, `series_tmdb_id`, `series_title`, `series_poster_url` y `series_backdrop_url`.

## Prepare y playback

Películas y episodios comparten exactamente la misma semántica:

| Método | Path | Auth | Request | 200 | 202 | 404 | 503 |
|---|---|---|---|---|---|---|---|
| POST | `/api/streams/movie/:movieId/prepare` | Sí | sin body | `STREAM_ALREADY_READY` | `STREAM_PREPARING` + `Retry-After` | `STREAM_NOT_AVAILABLE` | `STREAM_TEMPORARILY_UNAVAILABLE` |
| POST | `/api/streams/episode/:episodeId/prepare` | Sí | sin body | `STREAM_ALREADY_READY` | `STREAM_PREPARING` + `Retry-After` | `STREAM_NOT_AVAILABLE` | `STREAM_TEMPORARILY_UNAVAILABLE` |
| GET | `/api/streams/movie/:movieId` | Sí | — | stream ready | `STREAM_RESOLUTION_PENDING` + `Retry-After` | `STREAM_NOT_AVAILABLE` | `STREAM_TEMPORARILY_UNAVAILABLE` |
| GET | `/api/streams/episode/:episodeId` | Sí | — | stream ready | `STREAM_RESOLUTION_PENDING` + `Retry-After` | `STREAM_NOT_AVAILABLE` | `STREAM_TEMPORARILY_UNAVAILABLE` |

Respuesta 202:

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

La PWA vuelve a consultar el mismo GET después de `retry_after_ms`; no consulta IDs de jobs.

Respuesta 200 ready (los campos legacy permanecen para compatibilidad):

```json
{
  "success": true,
  "data": {
    "status": "ready",
    "content_id": "<uuid>",
    "content_type": "movie",
    "stream": {
      "url": "https://...",
      "type": "hls",
      "quality": "auto",
      "audio_language": "en",
      "subtitle_language": "es",
      "expires_at": "2026-09-06T12:00:00.000Z"
    },
    "subtitles": [],
    "subtitle_url": null,
    "streams": []
  }
}
```

`streams[]` conserva `server_name`, `quality`, `language`, `audio_language`, `subtitle_language`, `stream_url`, `embed_url`, `stream_type`, `priority` y `expires_at`. Playback usa preferentemente `data.stream`.

## Subtítulos

| Método | Path | Auth | Request | 200 | 202 | 404 | 503 |
|---|---|---|---|---|---|---|---|
| GET | `/api/subtitles/:tmdbId?type=movie&id=:movieId` | Sí | IDs TMDB/local | `data.subtitle_url` | — | no hay subtítulo | — |
| GET | `/api/subtitles/:tmdbId?type=episode&id=:episodeId&season=1&episode=2` | Sí | IDs + S/E | `data.subtitle_url` | — | no hay subtítulo | — |
| GET | `/subtitles/:file.vtt` | No | ruta devuelta por API | WebVTT | — | archivo ausente | — |

El GET de stream ya intenta resolver subtítulo y rellena `subtitle_url`/`subtitles`; el endpoint explícito sirve como fallback.

## Historial, progreso y resume

| Método | Path | Auth | Request | 200 | 202 | 404 | 503 |
|---|---|---|---|---|---|---|---|
| POST | `/api/history` | Sí | `{"content_type":"movie\|episode","content_id":"<uuid>","progress_seconds":123,"duration_seconds":3600}` | fila de progreso guardada | — | — | — |
| GET | `/api/history?page=1` | Sí | page opcional | entradas recientes para Continue Watching | — | — | — |
| GET | `/api/history/:contentType/:contentId` | Sí | `movie\|episode` + UUID | progreso; si falta devuelve cero y `completed:false` | — | — | — |

El único umbral efectivo del backend para `completed` es 95%. El frontend debe excluir de Continue Watching los elementos con porcentaje mayor o igual a 95 y no debe reanudar desde un progreso ya completado.

## Orden de integración pendiente en la PWA

1. Sustituir mocks de auth y conservar los tokens retornados.
2. Conectar catálogo/búsqueda/detalles usando UUID local para las rutas locales.
3. Llamar prepare desde detalle; en Watch hacer polling del GET ante 202.
4. Entregar `data.stream.url` al player cuando llegue 200.
5. Cargar subtítulos y aplicar progreso inicial.
6. Guardar progreso periódicamente y al pausar/salir; refrescar History/Continue Watching.
