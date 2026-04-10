const QUALITY_PATTERNS = [
  { pattern: /2160p|4k/i,  quality: '2160p' },
  { pattern: /1080p|fhd/i, quality: '1080p' },
  { pattern: /720p|hd/i,   quality: '720p'  },
  { pattern: /480p|sd/i,   quality: '480p'  },
  { pattern: /360p/i,      quality: '360p'  },
];

const detectQuality = (text = '') => {
  for (const { pattern, quality } of QUALITY_PATTERNS) {
    if (pattern.test(text)) return quality;
  }
  return 'auto';
};

const normalizeStream = ({ contentType, contentId, url, embedUrl, streamType, qualityHint, serverName, language, priority=2 }) => ({
  content_type: contentType,
  content_id:   contentId,
  stream_url:   url        || null,
  embed_url:    embedUrl   || null,
  stream_type:  streamType || (embedUrl ? 'embed' : 'direct'),
  quality:      detectQuality(qualityHint || url || ''),
  server_name:  serverName || 'Unknown',
  language:     language   || 'es',
  priority:     priority,
  is_active:    true,
});

module.exports = { normalizeStream, detectQuality };