'use strict';

const ALLOWED = new Set(['apple', 'cloudflare', 'peertube']);
const parseNetworkProbeArgs = (argv = []) => {
  if (!Array.isArray(argv)) return { ok: false, json: false };
  let all = false; let probe = null; let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      if (json) return { ok: false, json: true };
      json = true;
    } else if (item === '--all') {
      if (all) return { ok: false, json };
      all = true;
    } else if (item === '--probe' && !probe && index + 1 < argv.length) {
      probe = argv[++index];
    } else return { ok: false, json };
  }
  if (all === Boolean(probe) || (probe && !ALLOWED.has(probe))) return { ok: false, json };
  return { ok: true, all, probe, json };
};
const formatNetworkProbeJson = (results) => JSON.stringify(results);
const formatNetworkProbeText = (results) => results.map((item) => [
  `probe=${item.id}`, `status=${item.status}`, `protocol=${item.protocol}`,
  `hls=${item.isHls}`, `master=${item.isMaster}`,
  `media_playlist=${item.isMediaPlaylist}`, `variants=${item.variantCount}`,
  `audio_tracks=${item.audioTrackCount}`, `subtitle_tracks=${item.subtitleTrackCount}`,
  `validated=${item.validated}`, `acceptance=${item.acceptanceCode}`,
  `latency_ms=${item.latencyMs}`,
].join(' ')).join('\n');

module.exports = { parseNetworkProbeArgs, formatNetworkProbeJson, formatNetworkProbeText };
