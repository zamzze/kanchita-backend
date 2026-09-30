# HLS playlist-only transport

The default HLS playback transport remains `full`: playlists and media resources
are fetched through the existing opaque, SSRF-checked proxy. A server-owned,
enabled Resolver V2 catalog entry of type `persisted_sources` may opt its
provider ID into `hlsProxyMode: "playlists-only"`. Any missing, disabled, or
invalid entry remains `full`. The HTTP service reloads this trusted catalog at
startup and selects by the persisted stream's provider ID; the worker does not
persist the mode. The mode is bound to the signed proxy token and inherited by
child playlist tokens. Query parameters, request bodies, client headers,
MediaContext, source headers, and stream metadata cannot select it. The
low-level `createPlaybackUrl` option and service callback remain server-only
injection points, not public API inputs.

In `playlists-only` mode, master/media playlists and URI-bearing HLS tags still
use the proxy. Only a plain media URI following `#EXTINF`, with a `.ts` pathname
on the **final upstream playlist origin**, is emitted as an absolute direct URL.
Its query and fragment are retained. Cross-origin `.ts`, keys, init maps,
subtitles, LL-HLS parts, `.m4s`, and unknown resources remain proxied; malformed
or unsafe URI schemes fail closed. Thus the mode may still proxy some media
resources. It does not establish that an arbitrary stream is portable.

Playback headers are limited to the existing `Referer`/`Origin` allowlist and
stay server-side. SafeHttpClient still removes them on cross-origin redirects;
if the redirected playlist requires `Referer`, playback fails closed. Direct
segment URLs become visible to the client, so this mode must be enabled only
after confirming that **every directly emitted segment** works without
contextual headers, has suitable browser CORS/Range behavior, and may be
exposed to the client. HLS keys and variant playlists need separate checks.
No browser or real-provider validation is claimed by the local fixtures.
