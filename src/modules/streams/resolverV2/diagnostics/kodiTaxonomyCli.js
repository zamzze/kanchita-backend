'use strict';

const parseKodiTaxonomyArgs = (argv = []) => {
  if (!Array.isArray(argv)) return { ok: false, json: false };
  const roots = []; let json = false; const used = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      if (json) return { ok: false, json: true };
      json = true; continue;
    }
    if (!['--alfa-path', '--balandro-path'].includes(item) || used.has(item) ||
        index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      return { ok: false, json };
    }
    used.add(item);
    roots.push(argv[++index]);
  }
  return roots.length ? { ok: true, json, roots } : { ok: false, json };
};
const formatKodiTaxonomyJson = (result) => JSON.stringify(result);
const formatKodiTaxonomyText = (result) => {
  const lines = [
    `servers.total=${result.servers.total}`,
    `servers.active=${result.servers.active}`,
    ...Object.entries(result.servers)
      .filter(([key]) => !['total', 'active'].includes(key))
      .map(([key, value]) => `${key}=${value}`),
    `channels.total=${result.channels.total}`, `skipped=${result.skipped}`,
  ];
  for (const record of result.records) {
    lines.push(`${record.kind}=${record.id} classification=${record.classifications.join(',')} confidence=${record.confidence}${record.inactive ? ' inactive=true' : ''}`);
  }
  return lines.join('\n');
};

module.exports = { parseKodiTaxonomyArgs, formatKodiTaxonomyJson, formatKodiTaxonomyText };
