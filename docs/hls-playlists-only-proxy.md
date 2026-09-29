# HLS playlist-only transport

The default HLS playback transport remains `full`: playlists and media resources
are fetched through the existing opaque, SSRF-checked proxy. The optional
`playlists-only` mode is selected by trusted server code per stream via
`createPlaybackUrl(stream, { mode: 'playlists-only' })` or the injected
`playbackModeForStream` callback in `createStreamsService`. The mode is bound to
the signed proxy token and inherited by child playlist tokens. It cannot be
selected from a client query parameter. No provider or default production
service selects this mode yet.

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
