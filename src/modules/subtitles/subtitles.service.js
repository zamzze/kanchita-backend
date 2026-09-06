const https    = require('https');

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const AdmZip   = require('adm-zip');
const pool     = require('../../config/db');
const { createMetricsStore } = require('../streams/streamMetrics');

const SUBTITLES_DIR = path.join(__dirname, '../../../public/subtitles');
// Crear directorio si no existe
if (!fs.existsSync(SUBTITLES_DIR)) {
    fs.mkdirSync(SUBTITLES_DIR, { recursive: true });
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, res => {
            // Manejar redirects
            if (res.statusCode === 301 || res.statusCode === 302) {
                return httpsGet(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Parse error: ${data.substring(0, 100)}`)); }
            });
        }).on('error', reject);
    });
}

const requestJson = (url, { method = 'GET', headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
        const request = https.request(url, { method, headers }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error('Subtitle provider request failed'));
                }
                try { return resolve(JSON.parse(data)); }
                catch { return reject(new Error('Subtitle provider returned invalid JSON')); }
            });
        });
        request.setTimeout(5000, () => request.destroy(new Error('Subtitle provider timeout')));
        request.on('error', reject);
        if (body) request.write(JSON.stringify(body));
        request.end();
    });

const subtitleScore = (subtitle, {
    season = null,
    episode = null,
    releaseName = '',
} = {}) => {
    let points = 0;
    const text = [
        subtitle.release_name,
        subtitle.name,
        subtitle.language,
        subtitle.language_code,
        subtitle.attributes?.release,
    ].filter(Boolean).join(' ').toLowerCase();
    if (/latino|latin america|es[-_](419|mx|us|lat|latam)|spanish\s*\(latin/.test(text)) {
        points += 1000;
    } else if (/\b(spanish|español|spa|es)\b/.test(text)) {
        points += 500;
    }
    if (/web[- .]?(dl|rip)|\bweb\b/.test(text)) points += 120;
    if (/blu[- .]?ray/.test(text)) points += 60;
    if (/1080p/.test(text)) points += 30;
    if (season && episode) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        if (text.includes(`s${s}e${e}`) || text.includes(`${season}x${e}`)) points += 180;
    }
    const releaseTokens = String(releaseName).toLowerCase().split(/[^a-z0-9]+/)
        .filter(token => token.length >= 4);
    points += releaseTokens.filter(token => text.includes(token)).length * 15;
    if (subtitle.hearing_impaired || subtitle.attributes?.hearing_impaired) points -= 10;
    points += Math.min(50, Math.log10(Number(subtitle.downloads || subtitle.attributes?.download_count || 0) + 1) * 10);
    if (/\b(hdts|cam|hd-ts)\b/.test(text)) points -= 300;
    return points;
};

const rankSubtitles = (subtitles, context = {}) =>
    [...subtitles].sort((left, right) =>
        subtitleScore(right, context) - subtitleScore(left, context)
    );

// Convertir .srt a .vtt
function srtToVtt(srt) {
    return 'WEBVTT\n\n' + srt
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Convertir timestamps: 00:00:00,000 → 00:00:00.000
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        // Eliminar líneas de índice de subtítulo
        .replace(/^\d+\n/gm, '')
        .trim();
}

// Buscar subtítulo en SubDL
const findSubtitle = async (tmdbId, type, season = null, episode = null) => {
    const apiKey = process.env.SUBDL_API_KEY;
    let url = `https://api.subdl.com/api/v1/subtitles?api_key=${apiKey}&tmdb_id=${tmdbId}&type=${type}&languages=es&subs_per_page=30`;

    if (type === 'tv' && season && episode) {
        url += `&season_number=${season}&episode_number=${episode}`;
    }

    console.log(`[Subtitles] Consultando SubDL para tmdb:${tmdbId} (${type})`);
    const data = await httpsGetJson(url);

    if (!data.status || !data.subtitles?.length) return null;

    const sorted = rankSubtitles(data.subtitles, { season, episode });
    console.log(`[Subtitles] Mejor subtítulo seleccionado (score: ${subtitleScore(sorted[0], { season, episode })})`);
    return sorted[0];
};

const findOpenSubtitle = async (tmdbId, type, season = null, episode = null) => {
    const apiKey = process.env.OPENSUBTITLES_API_KEY;
    const username = process.env.OPENSUBTITLES_USERNAME;
    const password = process.env.OPENSUBTITLES_PASSWORD;
    if (!apiKey || !username || !password) return null;
    const query = new URLSearchParams({
        tmdb_id: String(tmdbId),
        type: type === 'tv' ? 'episode' : 'movie',
        languages: 'es',
    });
    if (season) query.set('season_number', String(season));
    if (episode) query.set('episode_number', String(episode));
    const headers = {
        'Api-Key': apiKey,
        'User-Agent': 'Kanchita/1.0',
        'Content-Type': 'application/json',
    };
    const search = await requestJson(
        `https://api.opensubtitles.com/api/v1/subtitles?${query}`,
        { headers }
    );
    const ranked = rankSubtitles(search.data || [], { season, episode });
    const fileId = ranked[0]?.attributes?.files?.[0]?.file_id;
    if (!fileId) return null;
    const login = await requestJson('https://api.opensubtitles.com/api/v1/login', {
        method: 'POST',
        headers,
        body: { username, password },
    });
    const download = await requestJson('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${login.token}` },
        body: { file_id: fileId },
    });
    return download.link ? { ...ranked[0], url: download.link } : null;
};

function frameToTime(frame, fps) {
    const totalMs  = Math.round((frame / fps) * 1000);
    const ms       = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const secs     = totalSec % 60;
    const mins     = Math.floor(totalSec / 60) % 60;
    const hours    = Math.floor(totalSec / 3600);
    return `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

// Descargar zip/rar y extraer .srt → .vtt
const downloadAndConvert = async (zipUrl, contentId, season = null, episode = null) => {
    const fullUrl = /^https?:\/\//.test(zipUrl) ? zipUrl : `https://dl.subdl.com${zipUrl}`;
    console.log('[Subtitles] Descargando archivo seleccionado');

    const buffer = await httpsGet(fullUrl);
    const isRar  = fullUrl.toLowerCase().endsWith('.rar');
    const isRawSubtitle = /\.(srt|sub)(?:\?|$)/i.test(fullUrl);

    let srtContent = null;

    if (isRawSubtitle) {
        const utf8Text = buffer.toString('utf8');
        srtContent = utf8Text.includes('\uFFFD') ? buffer.toString('latin1') : utf8Text;
    } else if (isRar) {
        const { createExtractorFromData } = require('node-unrar-js');
        const extractor   = await createExtractorFromData({ data: buffer });
        const list        = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];

        let targetFile = null;

        if (season && episode) {
            const episodeStr = String(episode).padStart(2, '0');
            const seasonStr  = String(season).padStart(2, '0');
            const patterns   = [
                `s${seasonStr}e${episodeStr}`,
                `${season}x${episodeStr}`,
                `e${episodeStr}`,
            ];

            targetFile = fileHeaders.find(f => {
                const name = f.name.toLowerCase();
                return (name.endsWith('.srt') || name.endsWith('.sub')) &&
                    patterns.some(p => name.includes(p));
            });
        }

        if (!targetFile) {
            targetFile = fileHeaders.find(f => {
                const name = f.name.toLowerCase();
                return name.endsWith('.srt') || name.endsWith('.sub');
            });
        }

        if (!targetFile) {
            throw new Error('No se encontró archivo .srt o .sub en el RAR');
        }

        console.log('[Subtitles] Extrayendo archivo compatible del RAR');
        const extracted  = extractor.extract({ files: [targetFile.name] });
        const files      = [...extracted.files];
        const rawContent = Buffer.from(files[0].extraction);
        const isSub      = targetFile.name.toLowerCase().endsWith('.sub');

        const rawText = rawContent.toString('utf8').includes('\uFFFD')
            ? rawContent.toString('latin1')
            : rawContent.toString('utf8');

        if (isSub) {
    console.log(`[Subtitles] Convirtiendo .sub, líneas: ${rawText.split('\n').length}`);
    const lines = rawText.split('\n');

    // Detectar formato SubViewer (tiene [INFORMATION] header)
    const isSubViewer = lines.some(l => l.includes('[INFORMATION]') || l.includes('[TITLE]'));
    // Detectar formato MicroDVD ({frame}{frame}texto)
    const isMicroDVD  = lines.some(l => /^\{\d+\}\{\d+\}/.test(l));

    if (isMicroDVD) {
        const fps = 23.976;
        const converted = lines
            .filter(line => line.trim())
            .map(line => {
                const match = line.match(/^\{(\d+)\}\{(\d+)\}(.*)/);
                if (!match) return null;
                const start = frameToTime(parseInt(match[1]), fps);
                const end   = frameToTime(parseInt(match[2]), fps);
                return `${start} --> ${end}\n${match[3].replace(/\|/g, '\n')}`;
            })
            .filter(Boolean);
        srtContent = converted.join('\n\n');

    } else if (isSubViewer) {
        // SubViewer format:
        // [INFORMATION] header, luego timestamps 00:00:01.00,00:00:03.00
        const converted = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            // Buscar líneas con timestamp formato HH:MM:SS.CC,HH:MM:SS.CC
            const match = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{2}),(\d{2}:\d{2}:\d{2}\.\d{2})$/);
            if (match) {
                const start = match[1].replace(/\.(\d{2})$/, '.$10'); // .CC → .CC0
                const end   = match[2].replace(/\.(\d{2})$/, '.$10');
                const text  = lines[i + 1]?.trim().replace(/\[br\]/gi, '\n') || '';
                if (text) {
                    converted.push(`${start} --> ${end}\n${text}`);
                }
                i += 2;
            } else {
                i++;
            }
        }
        srtContent = converted.join('\n\n');
        console.log(`[Subtitles] SubViewer convertido: ${converted.length} líneas`);

    } else {
        // Formato desconocido — intentar usar como SRT directo
        console.warn('[Subtitles] Formato .sub desconocido, intentando como SRT');
        srtContent = rawText;
    }

    console.log(`[Subtitles] Líneas convertidas: ${srtContent.split('\n\n').length}`);
} else {
            srtContent = rawText;
        }

    } else {
        // ZIP normal
        const zip     = new AdmZip(buffer);
        const entries = zip.getEntries();

        const srtEntry = entries.find(e =>
            e.entryName.toLowerCase().endsWith('.srt')
        );

        if (!srtEntry) {
            throw new Error('No se encontró archivo .srt en el zip');
        }

        const srtBuffer = srtEntry.getData();
        const utf8Text  = srtBuffer.toString('utf8');
        srtContent      = utf8Text.includes('\uFFFD')
            ? srtBuffer.toString('latin1')
            : utf8Text;
    }

    // Convertir a VTT
    const vttContent = 'WEBVTT\n\n' + srtContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/^\d+\n/gm, '')
        .trim();

    const fileName = `${contentId}.vtt`;
    const filePath = path.join(SUBTITLES_DIR, fileName);
    fs.writeFileSync(filePath, vttContent, { encoding: 'utf8' });

    console.log(`[Subtitles] VTT guardado para contenido ${contentId}`);
    return `/subtitles/${fileName}`;
};

// Leer caché de BD
const getCachedSubtitle = async (contentType, contentId, db = pool) => {
    const { rows } = await db.query(
        `SELECT subtitle_url, language FROM subtitles
         WHERE content_type = $1 AND content_id = $2
         AND language = 'es' AND is_active = TRUE LIMIT 1`,
        [contentType, contentId]
    );
    return rows[0] || null;
};

// Guardar en BD
const cacheSubtitle = async (contentType, contentId, subtitleUrl, db = pool) => {
    await db.query(
        `INSERT INTO subtitles (content_type, content_id, subtitle_url, language, is_active)
         VALUES ($1, $2, $3, 'es', TRUE)
         ON CONFLICT (content_type, content_id, language)
         DO UPDATE SET subtitle_url = EXCLUDED.subtitle_url, is_active = TRUE`,
        [contentType, contentId, subtitleUrl]
    );
};

// Función principal
const createSubtitleService = ({
    db = pool,
    subdlFinder = findSubtitle,
    openSubtitlesFinder = findOpenSubtitle,
    downloader = downloadAndConvert,
    fileExists = fs.existsSync,
    metrics = createMetricsStore(db),
    subdlEnabled = () => process.env.SUBDL_ENABLED !== 'false',
    openSubtitlesEnabled = () => process.env.OPENSUBTITLES_ENABLED === 'true',
    logger = console,
} = {}) => ({
getSubtitle: async (tmdbId, contentType, contentId, season = null, episode = null) => {
    // 1. Verificar caché en BD
    const cached = await getCachedSubtitle(contentType, contentId, db);
    if (cached) {
        // Verificar que el archivo .vtt sigue existiendo en disco
        const localPath = path.join(SUBTITLES_DIR, `${contentId}.vtt`);
        if (fileExists(localPath)) {
            logger.log('[Subtitles] cache hit');
            return { subtitle_url: cached.subtitle_url, language: 'es' };
        }
    }

    // 2. Buscar en SubDL
    const subdlType = contentType === 'movie' ? 'movie' : 'tv';
    logger.log('[Subtitles] searching configured providers');
    let subtitle = null;
    if (subdlEnabled()) {
        try {
            subtitle = await subdlFinder(tmdbId, subdlType, season, episode);
            if (subtitle) await metrics.increment('subtitle_subdl_success_total');
        } catch {
            logger.warn('[Subtitles] SubDL unavailable');
        }
    }
    if (!subtitle && openSubtitlesEnabled()) {
        try {
            subtitle = await openSubtitlesFinder(tmdbId, subdlType, season, episode);
            if (subtitle) await metrics.increment('subtitle_opensubtitles_success_total');
        } catch {
            logger.warn('[Subtitles] OpenSubtitles unavailable');
        }
    }

    if (!subtitle) {
        logger.warn('[Subtitles] no compatible subtitle found');
        return null;
    }

    // 3. Descargar y convertir a .vtt
    const subtitlePath = await downloader(subtitle.url, contentId, season, episode);

    // 4. Cachear en BD (URL pública desde el backend)
    const publicUrl = `${process.env.API_BASE_URL || 'http://localhost:3000'}${subtitlePath}`;
    await cacheSubtitle(contentType, contentId, publicUrl, db);

    return { subtitle_url: publicUrl, language: 'es' };
},
});

const defaultSubtitleService = createSubtitleService();
const getSubtitle = defaultSubtitleService.getSubtitle;

module.exports = {
    findOpenSubtitle,
    findSubtitle,
    getSubtitle,
    createSubtitleService,
    getCachedSubtitle,
    cacheSubtitle,
    rankSubtitles,
    subtitleScore,
};
