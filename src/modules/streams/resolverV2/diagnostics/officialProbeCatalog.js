'use strict';

const OFFICIAL_PROBES = Object.freeze([
  Object.freeze({
    id: 'apple', kind: 'hls', enabled: true, expectedProtocol: 'hls',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
  }),
  Object.freeze({
    id: 'cloudflare', kind: 'hls', enabled: true, expectedProtocol: 'hls',
    url: 'https://customer-f33zs165nr7gyfy4.cloudflarestream.com/6b9e68b07dfee8cc2d116e4c51d6a957/manifest/video.m3u8',
  }),
  Object.freeze({
    id: 'peertube', kind: 'peertube_discovery', enabled: true,
    expectedProtocol: 'hls', url: 'https://peertube.cpy.re',
  }),
]);

const getOfficialProbe = (id) => OFFICIAL_PROBES.find((probe) => probe.id === id) || null;

module.exports = { OFFICIAL_PROBES, getOfficialProbe };
