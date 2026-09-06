# Kanchita: auditoría técnica del ecosistema de agregadores y video hosts

Fecha de observación: 2026-09-06.

## Alcance y método

Esta auditoría mapea, a alto nivel, agregadores públicos de películas/series y los
nombres de player/host que muestran en sus páginas. No reproduce contenido, no abre
enlaces de media, no inspecciona tráfico privado y no recopila manifests, cookies,
tokens, cabeceras, endpoints privados ni credenciales.

Se revisaron páginas públicas indexadas mediante navegación HTTP de solo lectura. El
navegador interactivo no estuvo disponible por un fallo del sandbox de Windows. Por
ello:

- disponibilidad significa que una página pública fue recuperable o estuvo indexada;
- idioma y calidad son declaraciones visibles del agregador, salvo indicación contraria;
- no se midieron tiempos de player ni se confirmó técnicamente una rendition;
- no se afirma HLS cuando sólo se observó un iframe o un nombre de host;
- los resultados antiguos se marcan como históricos y no como presencia actual.

La muestra es deliberadamente pequeña: entre uno y tres títulos por dominio y ninguna
carga masiva. Un host visible no implica autorización para consumir su media fuera del
player ofrecido.

## Resumen

La arquitectura dominante es:

    catálogo y metadata del agregador
                    |
            selector de idioma
                    |
           lista de servidores
                    |
        iframe, wrapper o enlace externo
                    |
          video host/player de terceros
                    |
        protocolo de media no observado

El agregador decide el matching de título, temporada, episodio e idioma. El video host
aparece como mecanismo intercambiable de reproducción. La redundancia se consigue
publicando la misma variante en varios hosts, no mediante un proveedor único estable.

En ocho agregadores muestreados:

- Streamwish y Filemoon aparecen en 8/8.
- VOE aparece en 7/8.
- Vidhide aparece en 6/8.
- Doodstream y Netu aparecen en 5/8.
- Streamtape aparece en 3/8.
- el resto aparece en una o dos muestras.

No se observó un contrato público autorizado que convierta esos embeds en una API HLS
directa para Kanchita.

## Sitios auditados

| Site | Dominio observado | Evidencia | Catálogo | Movies | Series | ES-LAT visible | Subs ES | Arquitectura | Alternates |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| PeliCineHD | pelicinehd.com | página indexada hace 2-3 meses | general | yes | probable | yes | yes | AGGREGATOR → selector → EMBED_PLAYER | 2-5 |
| PoseidonHD 2 | poseidonhd2.co | recuperado/indexado hace 3 días | general | yes | probable | yes | yes | AGGREGATOR → wrapper/player → hosts | 6 |
| El Refugio del Pirata | elrefugiodelpirata.com | página indexada hace 5 meses | movies/episodes | yes | yes | yes | yes | AGGREGATOR → selector LAT/ESP/SUB → embed/link | 4-6 |
| Repelis | repelis.fun | evidencia histórica, indexada hace ~1.2 años | movies/series/anime | yes | yes | yes | yes | AGGREGATOR → server list → EMBED_PLAYER | 6-7 |
| RePelis 24 | repelis24.my | recuperado/indexado hace 2 semanas | general | yes | probable | yes | yes/EN | AGGREGATOR → server list → iframe/wrapper | 6-7 |
| Cuevana mirror | cuevana8.eu | resultado indexado hace 5 meses; recuperación actual falló | general | yes | probable | yes | yes | AGGREGATOR → server list → iframe/wrapper | 7 |
| Cinecalidad | cinecalidad.ai | evidencia histórica, indexada hace ~1 año | general | yes | categories include TV | yes | yes | AGGREGATOR → host choices | 3 |
| FlizzMovies | flizzmovies.org | recuperado/indexado hace 3 días | large movie catalog | yes | no evidence in sample | yes | yes | AGGREGATOR → host list → external embeds | 8-10 |

No se incluyeron directorios llamados Cuevana que sólo mostraban metadata/sinopsis sin
servidores de reproducción visibles en la muestra.

## Matriz aggregator → player/host

HLS observed usa “no” cuando no se inspeccionó tráfico de media; no significa que el
host no utilice HLS internamente.

| Aggregator | Player/Host visible | Movies | Series | ES-LAT | Subs ES | 1080p | HLS observed | Browser | Ads | Stability |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| PeliCineHD | Streamwish, Filemoon, VOE, Goodstream y aliases | yes | probable | yes | yes | UI/title says 1080p; not confirmed | no | BROWSER_REQUIRED | aviso de ad blocker; attribution unknown | medium/unknown |
| PoseidonHD 2 | Streamwish, Filemoon, Vidhide, VOE, Doodstream, Netu | yes | probable | yes | yes | UI says HD; not resolved | no | BROWSER_REQUIRED | POPUPS declared by site | current domain, long-term unknown |
| El Refugio | Streamwish, Filemoon, VOE, Vidhide, Embed69; premium alias | yes | yes | yes | yes | unknown/HD | no | BROWSER_REQUIRED | unknown | domain observed; links use aliases |
| Repelis | Streamwish, Filemoon, Vidhide, VOE, Doodstream, Netu, Streamtape | yes | yes | yes | yes | UI says HD | no | BROWSER_REQUIRED | unknown | stale evidence |
| RePelis 24 | Vimeos, Streamwish, Filemoon, Vidhide, VOE, Doodstream, Netu | yes | probable | yes | EN alternate | UI says HD | no | BROWSER_REQUIRED | unknown | current sample; mirror risk |
| Cuevana mirror | Streamwish, Filemoon, Vidhide, VOE, Doodstream, Streamtape, Netu | yes | probable | yes | yes | UI says HD | no | BROWSER_REQUIRED | POPUPS declared by template | current availability unconfirmed |
| Cinecalidad | Netu, Streamwish, Filemoon | yes | probable | yes | yes | page says Full HD; host not confirmed | no | BROWSER_REQUIRED | no evidence in text | stale evidence |
| FlizzMovies | Abyss, Streamwish, Vidhide, Vidguard, Krakenfiles, Filemoon, Vudeo, Media, plus VOE/Streamtape/Dood | yes | unknown | yes | yes | UI says HD | no | BROWSER_REQUIRED | unknown | current sample; many dependencies |

## Evidencia por sitio

### PeliCineHD

Tres muestras públicas mostraron Streamwish para Latino y subtitulado, Filemoon para
Latino o Castellano, y en títulos concretos VOE, Goodstream o aliases:

- [Noryang](https://pelicinehd.com/movies/noryang/)
- [Damsel](https://pelicinehd.com/movies/damsel/)
- [Godzilla Minus One](https://pelicinehd.com/movies/godzilla-minus-one/)

La página se anuncia como 1080p, pero las opciones sólo dicen HD. También recomienda
bloqueador de anuncios/Brave, evidencia de publicidad visible sin permitir atribuirla
con seguridad a un host concreto.

### PoseidonHD 2

La muestra actual publica seis opciones tanto para Latino como subtitulado: Streamwish,
Filemoon, Vidhide, VOE, Doodstream y Netu:

- [Venganza](https://www.poseidonhd2.co/pelicula/1613798/venganza)

La propia UI dice que la opción de vídeo contiene ventanas emergentes y que la carga es
“óptima”. Esto es una declaración del sitio, no una medición independiente.

### El Refugio del Pirata

La página de película muestra variantes LAT/SUB en Filemoon, Streamwish, VOE y Vidhide;
los enlaces visibles pasan a veces por domains alias/wrapper:

- [La empleada](https://elrefugiodelpirata.com/la-empleada-pelicula-online-espanol/)
- [Spider-Noir 1x1](https://elrefugiodelpirata.com/spider-noir-1x1-espanol/)

La segunda muestra confirma que el mismo patrón también se usa para episodios.

### Repelis

La página histórica muestra películas, series y anime, con listas separadas Latino,
Español y Subtitulado. Los seis hosts comunes son Streamwish, Filemoon, Vidhide, VOE,
Doodstream y Netu; otra muestra añade Streamtape:

- [Los pecadores](https://www.repelis.fun/pelicula/los-pecadores)
- [28 días después](https://www.repelis.fun/pelicula/28-dias-despues)

La antigüedad del índice impide considerarlo un dominio actual estable.

### RePelis 24

La muestra reciente lista Vimeos, Streamwish, Filemoon, Vidhide, VOE, Doodstream y Netu
bajo la pestaña Latino:

- [Te van a matar](https://repelis24.my/peliculas/te-van-a-matar/)

El iframe visible en el HTML extraído era un trailer, no evidencia del protocolo del
player de película.

### Cuevana mirror

El resultado indexado muestra siete hosts y etiqueta Español Latino/HD:

- [Mi pobre diablillo](https://www.cuevana8.eu/pelicula/11077/mi-pobre-diablillo)

La recuperación posterior falló, precisamente el tipo de inestabilidad de dominio que
impide promoverlo como fuente confiable.

### Cinecalidad

La muestra histórica separa audio Latino y original, y lista Netu, Streamwish y
Filemoon. La página declara Full HD para descargas, no una rendition técnicamente
confirmada por cada embed:

- [Nunca me abandones](https://cinecalidad.ai/pelicula/nunca-me-abandones-never-let-me-go/)

### FlizzMovies

La muestra reciente es la más amplia: ocho hosts para Latino y hasta diez para
subtitulado. Publica etiquetas HD, pero no resoluciones numéricas:

- [I Saw the TV Glow](https://flizzmovies.org/pelicula/i_saw_the_tv_glow_2024)

La cantidad de alternativas aumenta resiliencia aparente, pero también multiplica
dependencias y superficies de publicidad/fallo.

## Popularidad observada de hosts

Conteo binario: un host cuenta una vez por agregador aunque aparezca en varios idiomas o
títulos. Se agrupan aliases evidentes por nombre de marca, no por domain exacto.

| Rank | Host ecosystem | Sitios | Presencia |
| ---: | --- | ---: | --- |
| 1 | Streamwish | 8 | 8/8 |
| 1 | Filemoon | 8 | 8/8 |
| 3 | VOE / voesx | 7 | 7/8 |
| 4 | Vidhide | 6 | 6/8 |
| 5 | Doodstream | 5 | 5/8 |
| 5 | Netu | 5 | 5/8 |
| 7 | Streamtape | 3 | 3/8 |
| 8 | Vimeos/Vimeus | 2 | 2/8 |
| 9 | Goodstream | 1 | 1/8 |
| 9 | Abyss | 1 | 1/8 |
| 9 | Vidguard | 1 | 1/8 |
| 9 | Krakenfiles | 1 | 1/8 |
| 9 | Vudeo | 1 | 1/8 |
| 9 | Media | 1 | 1/8 |
| 9 | Embed69 | 1 | 1/8 |

La alta frecuencia puede significar conveniencia para los agregadores, no estabilidad,
calidad, limpieza ni autorización.

## Presencia observada de Español Latino

El numerador significa que al menos una opción del host apareció bajo una etiqueta
Latino/LAT/MX. No demuestra que todo su catálogo tenga esa pista.

| Rank | Host | ES-LAT observado | Nota |
| ---: | --- | ---: | --- |
| 1 | Streamwish | 8/8 sitios | Latino explícito en todas las muestras |
| 1 | Filemoon | 8/8 | Latino explícito; en PeliCineHD también puede aparecer como Castellano |
| 3 | Vidhide | 6/6 donde aparece | Latino explícito |
| 4 | VOE | 6/7 donde aparece | en Flizz la muestra visible era subtitulada |
| 5 | Netu | 5/5 | Latino explícito |
| 6 | Doodstream | 4/5 | Flizz lo mostró en otras variantes, no en Latino |
| 7 | Streamtape | 2/3 | Flizz lo mostró en subtitulado |
| 8 | Vimeos | 1/2 | Latino claro en RePelis24; “premium” no prueba idioma |
| 9 | Goodstream | 1/1 | una muestra Latino y otra subtitulada |
| 9 | Abyss/Vidguard/Krakenfiles/Vudeo/Media | 1/1 | una sola muestra FlizzMovies |

## Calidad observada

No existe un ranking técnico de bitrate/resolution porque no se cargaron manifests.

1. Streamwish, Filemoon y Vidhide tienen declaraciones comunitarias de 1080p y aparecen
   en páginas tituladas 1080p/Full HD. Sigue siendo calidad declarada, no confirmada.
2. VOE, Doodstream, Netu, Streamtape y los hosts secundarios aparecen como HD sin número.
3. Ninguna muestra permite confirmar 2160p.
4. Adaptive/fixed es UNKNOWN para todos los hosts.

Una discusión comunitaria reciente menciona Streamwish, Filemoon y Vidhide como 1080p,
pero no aporta medición de manifest:
[discusión](https://www.reddit.com/r/peliculas/comments/1ofij5v).

## Velocidad y coste de browser

### Velocidad

No se asigna FAST/MEDIUM/SLOW. La falta de navegador interactivo impidió separar:

    tiempo de página
    tiempo de wrapper/redirect
    tiempo de inicialización del player
    tiempo del manifest/media

Poseidon afirma carga óptima y un comentario comunitario prefiere Streamwish por
molestar menos al cargar. Ambas son señales anecdóticas, insuficientes para benchmark.

### Browser cost

| Host group | Classification | Reason |
| --- | --- | --- |
| Streamwish, Filemoon, VOE, Vidhide | BROWSER_REQUIRED | sólo se observó integración embed/player, no API pública autorizada |
| Doodstream, Netu, Streamtape | BROWSER_REQUIRED | mismo patrón; además aparecen detrás de wrappers en algunas páginas |
| hosts secundarios | UNKNOWN/BROWSER_REQUIRED | una muestra y ningún contrato técnico público verificado |

“Browser required” describe lo observado por el agregador. No afirma que sea imposible
una integración oficial; afirma que no se encontró un contrato que permita a Kanchita
prescindir del player.

## Publicidad visible

| Aggregator | Evidence | Classification |
| --- | --- | --- |
| PeliCineHD | recomienda ad blocker/Brave | PAGE_ADS or PLAYER_ADS, attribution unknown |
| PoseidonHD 2 | declara ventanas emergentes en la opción de vídeo | POPUPS |
| Cuevana mirror | misma advertencia de ventanas emergentes en la página indexada | POPUPS |
| El Refugio | sin evidencia textual suficiente | UNKNOWN |
| Repelis / RePelis24 | sin evidencia textual suficiente | UNKNOWN |
| Cinecalidad | sin aviso visible en muestra | UNKNOWN, not “clean” |
| FlizzMovies | sin aviso visible en muestra | UNKNOWN, not “clean” |

No se observó ni se intentó quitar publicidad dentro del player o media.

## Score exploratorio

Se aplicó sólo a hosts, con evidencia conservadora:

    ES_LAT_AUDIO +200
    1080P +150
    720P/HD +75
    FAST +150
    NO_BROWSER +200
    MULTI_AGGREGATOR +150
    LOW_VISIBLE_ADS +100
    BROWSER_REQUIRED -200
    SLOW -150
    UNSTABLE -200
    POPUPS -100

No se otorgaron puntos FAST, NO_BROWSER o LOW_VISIBLE_ADS porque no fueron medibles.
HD declarado recibe 75; 1080p declarado explícitamente recibe 150. Los popups no se
atribuyeron a un host sin evidencia host-specific.

| Host | Score | Basis |
| --- | ---: | --- |
| Streamwish | 300 | ES-LAT + 1080p declarado + multi - browser |
| Filemoon | 300 | ES-LAT + 1080p declarado + multi - browser |
| Vidhide | 300 | ES-LAT + 1080p comunitario + multi - browser |
| VOE | 225 | ES-LAT + HD + multi - browser |
| Netu | 225 | ES-LAT + HD + multi - browser |
| Doodstream | 225 | ES-LAT + HD + multi - browser |
| Streamtape | 225 | ES-LAT + HD + multi - browser |
| Vimeos/Vimeus | 225 | ES-LAT parcial + HD + multi - browser |
| Goodstream | 75 | ES-LAT/HD en una muestra - browser |
| hosts secundarios de Flizz | 75 | ES-LAT/HD en una muestra - browser |

El empate y las puntuaciones bajas reflejan falta de evidencia técnica; no justifican
integración.

## Rankings solicitados

### A. Ecosistemas más frecuentes

Streamwish/Filemoon, luego VOE, Vidhide, Doodstream/Netu y Streamtape.

### B. Mayor presencia de Español Latino

Streamwish y Filemoon (8/8), Vidhide (6/6), VOE (6/7), Netu (5/5). Son proporciones de
la muestra, no cobertura global.

### C. Mayor calidad observada

Streamwish, Filemoon y Vidhide por declaraciones de 1080p. No hubo confirmación técnica.
El resto queda en HD/unknown.

### D. Menor latencia

Sin ranking defendible. No se midieron players. Streamwish tiene una señal anecdótica
favorable, insuficiente para clasificarlo FAST.

### E. Menor dependencia de browser

Ninguno demostrado. Todos los hosts aparecen como embed/player o tras wrapper.

### F. Menor publicidad visible

Sin ranking host-specific defendible. La publicidad visible pertenece a la combinación
agregador + wrapper + player; PeliCineHD, Poseidon y Cuevana muestran advertencias.

## Compatibilidad arquitectónica potencial con Kanchita

Si existiera una integración expresamente autorizada, los hosts frecuentes serían
conceptualmente compatibles con el lifecycle de Kanchita sólo si entregaran:

1. lookup/mapping estable y permitido;
2. URL HTTP/HTTPS directa o manifest HLS mediante contrato documentado;
3. expiración o TTL conocido;
4. idioma/calidad explícitos;
5. CORS compatible con el player;
6. ausencia de DRM;
7. validación por el hlsValidator SSRF-safe;
8. resolución mediante worker, nunca en el request HTTP;
9. límites/rate limits y política de caché definidos;
10. autorización para reproducir fuera de su embed.

Actualmente no se demostró ninguno de esos contratos para Streamwish, Filemoon, VOE,
Vidhide, Doodstream, Netu o Streamtape. Por tanto:

    RESEARCH → MAP → RANK → RECOMMEND

se completó, pero:

    SCRAPE → EXTRACT → INTEGRATE

queda fuera de alcance y no está recomendado.

## Recomendación

- Usar el mapa para entender redundancia y fallos, no como lista de adapters.
- No ampliar ProviderC ni hardcodear dominios/aliases observados.
- No construir resolvers por DOM, network interception o evasión: los mirrors y wrappers
  cambian y harían Kanchita frágil.
- Si un host ofrece en el futuro API/playback autorizado, auditar ese contrato por
  separado y activar mediante feature flag disabled por defecto.
- Para un benchmark posterior, usar un título autorizado y común, tres requests máximo,
  navegador aislado, sin persistir media URLs; medir page/player por separado.

## Limitaciones y riesgos

- La muestra no es estadísticamente representativa y varias páginas son históricas.
- Los nombres de host pueden ser aliases o labels del agregador.
- “Latino” puede describir la opción del agregador, no metadata certificada del host.
- “HD/1080p” no prueba resolución, bitrate, codec ni estabilidad.
- Un iframe visible no revela HLS, DASH, MP4 o media ads sin inspección más profunda, que
  esta fase excluye.
- Los dominios cambian con frecuencia; el fallo de Cuevana8 durante la revisión lo
  ejemplifica.
- No se evaluó malware, tracking ni seguridad del código de terceros.
- No se guardaron URLs completas de media, tokens, cookies o endpoints privados.

## Cambios de código

Ninguno. No se modificó ProviderC, ProviderManager, resolver, lifecycle, scraper,
worker ni configuración. Este entregable es exclusivamente investigación y diseño.
