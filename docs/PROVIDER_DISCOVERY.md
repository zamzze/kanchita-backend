# Provider discovery, ranking and normalization

Fecha de corte: 2026-09-06.

## Resultado ejecutivo

Se investigaron 21 candidatos con documentación primaria. No apareció un catálogo
comercial autorizado y documentado que entregue HLS directo con Español Latino. Los
mejores resultados son infraestructura para medios que Kanchita controle (Cloudflare
Stream, Mux, Bunny Stream, Jellyfin y Emby) y catálogos abiertos de alcance distinto
(Wikimedia Commons, Internet Archive y NASA).

No se añadió ningún provider productivo. Una URL accesible no demuestra derecho de
integración. Cualquier adapter futuro queda desactivado por defecto, exige licencia o
biblioteca autorizada y debe pasar por el validador HLS SSRF-safe existente.

## Provider catalog

Direct HLS significa que existe un contrato documentado de manifest, no permiso sobre
cualquier obra alojada. ES-LAT “cond.” sólo preserva una pista aportada por el dueño.

| Provider | Movies | Series | Direct HLS | Browser | 1080p | ES-LAT | Subs ES | Ads | Stable | Integration status | Tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cloudflare Stream | owned | owned | yes | DIRECT | yes | cond. | cond. | clean | yes | AUTHORIZED, owned/licensed media | TIER_A |
| Mux Video | owned | owned | yes | DIRECT | yes | cond. | cond. | clean | yes | AUTHORIZED, owned/licensed media | TIER_A |
| Bunny Stream | owned | owned | yes | DIRECT | yes/2160p | cond. | cond. | clean/configurable | yes | AUTHORIZED, owned/licensed media | TIER_A |
| Jellyfin | owned | owned | yes | LIGHT_HTTP | source/transcode | cond. | cond. | clean | operator-controlled | AUTHORIZED own server/library | TIER_A |
| Emby | owned | owned | yes | LIGHT_HTTP | source/transcode | cond. | cond. | clean | operator-controlled | AUTHORIZED own server/library | TIER_A |
| Vimeo API | account | account | paid/account | LIGHT_HTTP | plan/source | cond. | cond. | clean | yes | NEEDS_PERMISSION | TIER_B |
| JW Player Platform | owned | owned | yes | LIGHT_HTTP | source/encode | cond. | cond. | configurable | yes | NEEDS_PERMISSION | TIER_B |
| Wikimedia Commons | some | some | not universal | LIGHT_HTTP | per asset | rare | per asset | clean | yes | OPEN_LICENSE, verify per file | TIER_B |
| Internet Archive | some | some | no; direct files | LIGHT_HTTP | per item | rare | per item | per item | yes | OPEN_LICENSE/NEEDS_PERMISSION per item | TIER_B |
| NASA Library | no film catalog | no | no; direct files | LIGHT_HTTP | per asset | no | uncommon | clean | yes | PUBLIC_DOMAIN with exceptions | TIER_B |
| PeerTube federation | some | some | instance-dependent | LIGHT_HTTP | per video | unknown | per video | unknown | instance-dependent | NEEDS_PERMISSION per item | TIER_C |
| ProviderC legacy | yes | yes | indirect | BROWSER | reported | unknown | unknown | unknown | fragile | UNCLEAR, retained not expanded | REJECTED |
| YouTube | some | some | no official own-player source | embed | yes | per upload | per upload | external player ads | yes | REJECTED | REJECTED |
| Dailymotion | some | some | no public own-player contract | embed | yes | per upload | per upload | external player ads | yes | REJECTED | REJECTED |
| Plex public catalog | some | some | no supported external contract | embed/app | yes | per title | per title | external player | yes | REJECTED | REJECTED |
| Netflix | yes | yes | DRM/private | UNUSABLE | yes | yes | yes | paid | yes | REJECTED | REJECTED |
| Disney+ | yes | yes | DRM/private | UNUSABLE | yes | yes | yes | paid | yes | REJECTED | REJECTED |
| Max | yes | yes | DRM/private | UNUSABLE | yes | yes | yes | paid | yes | REJECTED | REJECTED |
| Prime Video | yes | yes | DRM/private | UNUSABLE | yes | yes | yes | paid | yes | REJECTED | REJECTED |
| Hulu | yes | yes | DRM/private | UNUSABLE | yes | limited | yes | paid/ad plans | yes | REJECTED | REJECTED |
| Apple TV+ | yes | yes | DRM/private | UNUSABLE | yes | yes | yes | paid | yes | REJECTED | REJECTED |

## Ranking técnico

Las exclusiones son una puerta previa: DRM, endpoint privado, evasión anti-bot,
credenciales compartidas o derechos no aclarables impiden promoción aunque el score sea
alto.

| Rank | Candidate | Score | Scope required | Reason |
| ---: | --- | ---: | --- | --- |
| 1 | Vimeo API | 1600 | cuenta autorizada/plan compatible | HLS documentado y expiración conocida |
| 2 | Cloudflare Stream | 1550 | contenido propio/licenciado | HLS estable sin browser |
| 3 | Mux Video | 1550 | assets propios/licenciados | HLS por playback ID |
| 4 | Bunny Stream | 1550 | biblioteca propia/licenciada | direct play y hasta 2160p |
| 5 | Jellyfin | 1550 | servidor/biblioteca propios | HLS y pistas controladas |
| 6 | Emby | 1550 | servidor/biblioteca propios | REST/HLS y pistas seleccionables |
| 7 | JW Player Platform | 1550 | cuenta/medios autorizados | Delivery API |
| 8 | Wikimedia Commons | 1080 | licencia/atribución por archivo | API, transcodes y timed text |
| 9 | NASA Library | 1050 | media guidelines | API y assets directos |
| 10 | Internet Archive | 975 | licencia por ítem | Metadata API y archivos directos |

PeerTube obtiene 950 con un perfil permitido, pero queda TIER_C por dependencia de
instancia, moderación, disponibilidad y licencia por vídeo. El score no es una afirmación
contractual ni una medición real de rendimiento.

Pesos implementados en src/modules/streams/providerDiscoveryScore.js:

    DIRECT_HLS +500        DOCUMENTED_API +300     NO_BROWSER +300
    1080P +150             720P +75                ES_419_AUDIO +100
    ES_AUDIO +60           SPANISH_SUBS +30        CLEAN +300
    KNOWN_EXPIRY +50       TMDB_ID_LOOKUP +100     IMDB_ID_LOOKUP +75
    BROWSER_REQUIRED -300  UNKNOWN_ADS -100        AD_MARKED -500
    UNSTABLE_DOMAIN -200   UNKNOWN_RIGHTS -500     PRIVATE_ENDPOINT -1000
    DRM -10000

## Evidencia primaria

- Cloudflare documenta HLS/DASH para player propio, exige subir el vídeo y advierte que
  el manifest es dinámico: [own player](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/),
  [prerequisites](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/web/).
- Mux documenta HLS por playback ID y cualquier player HLS:
  [playback](https://www.mux.com/docs/guides/play-your-videos),
  [policies](https://www.mux.com/docs/api-reference/video/playback-id).
- Bunny expone direct play, resoluciones hasta 2160p, multi-audio y captions:
  [library](https://docs.bunny.net/reference/videolibrarypublic_update),
  [formats](https://docs.bunny.net/docs/stream-best-practices).
- Emby documenta REST autenticado y /Videos/{Id}/master.m3u8:
  [REST](https://dev.emby.media/doc/restapi/index.html),
  [HLS](https://dev.emby.media/doc/restapi/Http-Live-Streaming.html).
- Jellyfin requiere fijar una versión de OpenAPI y probar PlaybackInfo contra un servidor
  propio: [API](https://api.jellyfin.org/).
- Vimeo limita enlaces directos a vídeos de la cuenta y plan/scopes compatibles; enlaces
  play caducan: [file links](https://help.vimeo.com/hc/en-us/articles/12427806914577-About-video-file-download-links-from-the-API).
- JWP entrega contenido previamente administrado:
  [Delivery API](https://docs.jwplayer.com/platform/reference/delivery-api-getting-started).
- Wikimedia ofrece videoinfo, transcodes y timed text; timed text se declara
  interno/inestable: [TMH API](https://www.mediawiki.org/wiki/Extension:TimedMediaHandler/API).
  Licencia y atribución son por archivo:
  [licensing](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use).
- Internet Archive documenta Items/Metadata y no añade derechos a materiales depositados:
  [developer portal](https://archive.org/developers/).
- NASA expone búsqueda/assets: [API](https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf).
  Su uso suele permitirse con condiciones, pero hay excepciones de terceros, marcas y
  personas: [guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).
- PeerTube varía por instancia y necesita allowlist/licencia:
  [REST](https://docs.joinpeertube.org/api-rest-reference.html).
- YouTube exige su experiencia/player y prohíbe recuperar/almacenar audiovisual fuera
  del contrato: [policies](https://developers.google.com/youtube/terms/developer-policies).
- Dailymotion ofrece SDK de Player, no un contrato público para sustituirlo por HLS:
  [Player SDK](https://developers.dailymotion.com/reference/web-sdk-player-methods).

No se investigaron métodos de bypass de OTT. Usarlos fuera del playback oficial
requeriría DRM o endpoints/tokens privados, criterios automáticos de rechazo.

## Tiers

- TIER_A: Cloudflare Stream, Mux, Bunny, Jellyfin y Emby. Idóneos sólo para biblioteca
  propia/licenciada; no aportan catálogo comercial.
- TIER_B: Vimeo, JW Platform, Wikimedia Commons, Internet Archive y NASA. Los dos
  primeros requieren cuenta/medios propios; los abiertos exigen licencia y atribución.
- TIER_C: PeerTube, tras allowlist de instancia y licencia por vídeo.
- REJECTED: ProviderC como candidato nuevo (se conserva), YouTube, Dailymotion, Plex y
  los seis OTT. Motivos: browser/player ajeno, derechos inciertos, ads, privados o DRM.

## Latino, HD, HLS, browser y benchmark

- Español Latino garantizado: ninguno. Jellyfin, Emby y Bunny preservan es-419 si el
  operador aporta esa pista.
- 1080p: los TIER_A cuando source/plan lo permite; los demás dependen del asset.
- HLS directo documentado: Cloudflare, Mux, Bunny, Jellyfin, Emby y, bajo contrato de
  cuenta, Vimeo/JWP; PeerTube depende de instancia.
- Browser/player externo: ProviderC, YouTube, Dailymotion y Plex public catalog.
- Benchmark no ejecutado: no había credenciales ni asset autorizado común. Un piloto
  debe hacer como máximo tres consultas controladas y alimentar avg_resolution_ms,
  success_rate, consecutive_failures y last_success.

## Adapter specification

Contrato común para TIER_A/TIER_B:

    StreamProvider {
      id
      strategy: direct | browser
      enabled
      supportsMovies
      supportsEpisodes
      lookup(input): ProviderMatch | null
      resolve(input): ProviderStream[]
      normalize(raw, input): ProviderStream[]
    }

| Adapter | Lookup | Resolve/normalize | Gate obligatorio |
| --- | --- | --- | --- |
| cloudflare_stream | mapping de asset | UID a HLS | asset autorizado; PROVIDER_CLOUDFLARE_STREAM_ENABLED=false |
| mux_video | mapping/playback ID | playback ID a HLS/expiry | asset autorizado; PROVIDER_MUX_ENABLED=false |
| bunny_stream | GUID/título de library | metadata a HLS candidates | own library, DRM off; PROVIDER_BUNNY_ENABLED=false |
| jellyfin | external IDs, luego exact title/year | PlaybackInfo a variantes | own allowlisted server; PROVIDER_JELLYFIN_ENABLED=false |
| emby | external IDs, luego exact title/year | PlaybackInfo a variantes | own allowlisted server; PROVIDER_EMBY_ENABLED=false |
| vimeo | account video ID | play HLS y expiry | account/plan; PROVIDER_VIMEO_ENABLED=false |
| jw_platform | media/external ID | Delivery sources a HLS | account; PROVIDER_JWP_ENABLED=false |
| wikimedia_commons | exact file metadata | transcodes + rights | license allowlist; PROVIDER_WIKIMEDIA_ENABLED=false |
| internet_archive | identifier/title+year exactos | permitted MP4 future path | license allowlist; PROVIDER_ARCHIVE_ENABLED=false |
| nasa_library | nasa_id/title exacto | permitted MP4 future path | exception check; PROVIDER_NASA_ENABLED=false |

No se añadió configuración al env: aún no existe adapter productivo que la consuma.

## Matching, normalization y ranking

Matching: TMDB exacto, después IMDb exacto, después título exacto + año. Episodios exigen
serie + temporada + episodio exactos. Un ID o año contradictorio rechaza; no hay fuzzy
agresivo. Lo implementa contentMatching.js.

Idiomas:

    latino, latin, latam, spanish-latin, spanish latam,
    es-lat, es-latam, spa-lat, es-MX, es-US -> es-419
    Spanish -> es; English -> en; Portuguese -> pt; resto -> unknown

Calidad:

    4k, 2160, 2160p, UHD -> 2160p
    FULLHD, FHD, 1080, 1080p -> 1080p
    720 -> 720p; 480 -> 480p; auto -> auto; resto -> unknown

Modelo estable:

    {
      provider, content_type, content_id, stream_url, stream_type,
      quality, audio_language, subtitle_language, cleanliness,
      strategy, expires_at, priority
    }

ProviderManager admite uno o varios resultados por provider, valida cada manifest,
normaliza y ordena:

    cleanliness > ready/cache > direct > provider latency >
    quality > audio language > subtitle language

El browser sigue siendo fallback perezoso: no se ejecuta si hay un candidato directo.
resolveCandidates() expone la lista; resolve() conserva el contrato anterior.

## Fallback de subtítulos

Si falta es-419, el ranking soporta audio original + subtítulos ES. SubDL sigue primero:
su API busca por TMDB/IMDb, temporada, episodio, año e idioma
([SubDL API](https://subdl.com/api-doc)). OpenSubtitles REST queda segundo, sujeto a
credenciales, cuota y términos. Un subtítulo no autoriza una fuente de vídeo.

## Cinco pilotos posibles, sólo tras aprobación

1. Jellyfin para biblioteca privada controlada.
2. Emby si ya existe ese servidor autorizado.
3. Cloudflare Stream para contenido que se decida alojar/licenciar.
4. Mux Video para el mismo caso.
5. Wikimedia Commons para probar open-license + attribution.

Antes de implementar uno: confirmar biblioteca, mapping a IDs Kanchita, costes/términos,
crear adapter separado y dejarlo disabled por defecto. ProviderManager no debe hardcodear
lógica específica.

## Riesgos pendientes

- Ningún candidato aporta películas/series comerciales ES-LAT sin acuerdo o biblioteca.
- Calidad, audio y subtítulos son del asset, no garantía del proveedor.
- APIs, planes y cuotas cambian; fijar contrato y medir health antes de habilitar.
- Manifest válido no garantiza segmentos duraderos ni CORS correcto para la PWA.
- MP4/WebM de Archive/NASA/Wikimedia exige ampliar deliberadamente el lifecycle HLS.
- Licencia/atribución por asset necesitará modelo propio si se aprueba ese adapter.
