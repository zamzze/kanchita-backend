'use strict';

const CAPABILITY_STATES = Object.freeze({
  SUPPORTED_PRIMARY: 'SUPPORTED_PRIMARY',
  SUPPORTED_RESOLUTION_ONLY: 'SUPPORTED_RESOLUTION_ONLY',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
});

const capability = (state, noteCode = null) => Object.freeze({ state, noteCode });
const { SUPPORTED_PRIMARY, SUPPORTED_RESOLUTION_ONLY, NOT_SUPPORTED } = CAPABILITY_STATES;

const V2_CAPABILITY_MATRIX = Object.freeze({
  direct_hls: capability(SUPPORTED_PRIMARY),
  direct_http: capability(SUPPORTED_PRIMARY),
  json_api: capability(SUPPORTED_PRIMARY),
  static_html: capability(SUPPORTED_PRIMARY),
  iframe_http: capability(SUPPORTED_PRIMARY),
  multi_hop_iframe: capability(SUPPORTED_PRIMARY),
  header_bound: capability(SUPPORTED_RESOLUTION_ONLY, 'PLAYBACK_HEADERS_NOT_TRANSPORTED'),
  playback_header_bound: capability(
    SUPPORTED_RESOLUTION_ONLY, 'PLAYBACK_HEADERS_NOT_TRANSPORTED'),
  navigation_header_bound: capability(SUPPORTED_PRIMARY, 'NAVIGATION_HEADERS_ONLY'),
  cookie_session: capability(NOT_SUPPORTED),
  javascript_transform: capability(NOT_SUPPORTED),
  browser_required: capability(NOT_SUPPORTED),
  anti_bot: capability(NOT_SUPPORTED),
  drm_or_protected: capability(NOT_SUPPORTED),
  unknown: capability(NOT_SUPPORTED),
});

const CAPABILITY_NAMES = Object.freeze(Object.keys(V2_CAPABILITY_MATRIX));

const getCapability = (name) => V2_CAPABILITY_MATRIX[name] || null;

module.exports = {
  CAPABILITY_NAMES,
  CAPABILITY_STATES,
  V2_CAPABILITY_MATRIX,
  getCapability,
};
