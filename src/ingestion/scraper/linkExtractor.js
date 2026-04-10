// src/ingestion/scraper/linkExtractor.js
const https = require('https');

// Resuelve una URL que puede ser un redirect o un iframe
// y devuelve el HTML final
const fetchResolved = (url, extraHeaders = {}) => {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer':         url,
        ...extraHeaders,
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchResolved(res.headers.location, extraHeaders));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
};

// Extrae todas las URLs m3u8 de un HTML
const extractM3u8 = (html) => {
  const regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi;
  return [...new Set(html.match(regex) || [])];
};

// Extrae src de iframes
const extractIframeSrc = (html) => {
  const regex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  const srcs  = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    srcs.push(match[1]);
  }
  return srcs;
};

// Busca m3u8 en un HTML que puede contener iframes anidados
const deepExtractM3u8 = async (html, depth = 2) => {
  const direct = extractM3u8(html);
  if (direct.length || depth === 0) return direct;

  const iframes = extractIframeSrc(html);
  const results = [];

  for (const src of iframes.slice(0, 3)) { // máximo 3 iframes
    try {
      const iframeHtml = await fetchResolved(src);
      const links      = await deepExtractM3u8(iframeHtml, depth - 1);
      results.push(...links);
    } catch {
      // iframe inaccesible, continuar
    }
  }

  return [...new Set(results)];
};

module.exports = { fetchResolved, extractM3u8, extractIframeSrc, deepExtractM3u8 };