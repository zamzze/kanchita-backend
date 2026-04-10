const https    = require('https');

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const AdmZip   = require('adm-zip');
const pool     = require('../../config/db');

const SUBTITLES_DIR = path.join(__dirname, '../../../public/subtitles');
const SUBDL_API_KEY = process.env.SUBDL_API_KEY;

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

    console.log(`[Subtitles] SubDL URL: ${url}`);
    const data = await httpsGetJson(url);

    if (!data.status || !data.subtitles?.length) return null;

    const subtitles = data.subtitles;

    // Prioridad de selección:
    // 1. WEB-DL o WEBRip en español latino con más descargas
    // 2. Cualquier español latino
    // 3. El de más descargas en español

    const score = (s) => {
    let points = 0;
    const name = (s.release_name + ' ' + s.name).toLowerCase();

    // Preferir WEB sources genéricas
    if (name.includes('web')) points += 10;
    if (name.includes('webrip') || name.includes('web-dl')) points += 5;

    // Preferir latino
    if (name.includes('lat') || name.includes('latino')) points += 20;
    if (name.includes('spanish(latin') || name.includes('es-lat')) points += 20;

    // Penalizar fuentes propietarias (timing diferente)
    if (name.includes('dsnp') || name.includes('disney')) points -= 30;
    if (name.includes('nflx') || name.includes('netflix')) points -= 30;
    if (name.includes('amzn') || name.includes('amazon')) points -= 30;
    if (name.includes('hmax') || name.includes('hbo')) points -= 30;
    if (name.includes('atvp') || name.includes('apple')) points -= 30;

    // Penalizar HDTS/CAM
    if (name.includes('hdts') || name.includes('cam') || 
        name.includes('.ts') || name.includes('hd-ts')) points -= 15;

    // Preferir 1080p BluRay o WEB genérico
    if (name.includes('1080')) points += 3;
    if (name.includes('bluray') || name.includes('blu-ray')) points += 2;

    return points;
};

    // Ordenar por score descendente
    const sorted = [...subtitles].sort((a, b) => score(b) - score(a));

    console.log(`[Subtitles] Mejor subtítulo: ${sorted[0].release_name} (score: ${score(sorted[0])})`);
    return sorted[0];
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
    const fullUrl = `https://dl.subdl.com${zipUrl}`;
    console.log(`[Subtitles] Descargando: ${fullUrl}`);

    const buffer = await httpsGet(fullUrl);
    const isRar  = fullUrl.toLowerCase().endsWith('.rar');

    let srtContent = null;

    if (isRar) {
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

        console.log(`[Subtitles] Extrayendo del RAR: ${targetFile.name}`);
        const extracted  = extractor.extract({ files: [targetFile.name] });
        const files      = [...extracted.files];
        const rawContent = Buffer.from(files[0].extraction);
        const isSub      = targetFile.name.toLowerCase().endsWith('.sub');

        const rawText = rawContent.toString('utf8').includes('\uFFFD')
            ? rawContent.toString('latin1')
            : rawContent.toString('utf8');

        if (isSub) {
    console.log(`[Subtitles] Convirtiendo .sub, líneas: ${rawText.split('\n').length}`);
    console.log(`[Subtitles] Primera línea: ${rawText.split('\n')[0]}`);

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
        const AdmZip  = require('adm-zip');
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

    console.log(`[Subtitles] Guardado: ${filePath}`);
    return `/subtitles/${fileName}`;
};

// Leer caché de BD
const getCachedSubtitle = async (contentType, contentId) => {
    const { rows } = await pool.query(
        `SELECT subtitle_url, language FROM subtitles
         WHERE content_type = $1 AND content_id = $2
         AND language = 'es' AND is_active = TRUE LIMIT 1`,
        [contentType, contentId]
    );
    return rows[0] || null;
};

// Guardar en BD
const cacheSubtitle = async (contentType, contentId, subtitleUrl) => {
    await pool.query(
        `INSERT INTO subtitles (content_type, content_id, subtitle_url, language, is_active)
         VALUES ($1, $2, $3, 'es', TRUE)
         ON CONFLICT (content_type, content_id, language)
         DO UPDATE SET subtitle_url = EXCLUDED.subtitle_url, is_active = TRUE`,
        [contentType, contentId, subtitleUrl]
    );
};

// Función principal
const getSubtitle = async (tmdbId, contentType, contentId, season = null, episode = null) => {
    // 1. Verificar caché en BD
    const cached = await getCachedSubtitle(contentType, contentId);
    if (cached) {
        // Verificar que el archivo .vtt sigue existiendo en disco
        const localPath = path.join(SUBTITLES_DIR, `${contentId}.vtt`);
        if (fs.existsSync(localPath)) {
            console.log(`[Subtitles] Caché hit para ${contentId}`);
            return { subtitle_url: cached.subtitle_url, language: 'es' };
        }
    }

    // 2. Buscar en SubDL
    const subdlType = contentType === 'movie' ? 'movie' : 'tv';
    console.log(`[Subtitles] Buscando en SubDL para tmdb:${tmdbId}`);
    const subtitle = await findSubtitle(tmdbId, subdlType, season, episode);

    if (!subtitle) {
        console.warn(`[Subtitles] No encontrado para tmdb:${tmdbId}`);
        return null;
    }

    // 3. Descargar y convertir a .vtt
    const subtitlePath = await downloadAndConvert(subtitle.url, contentId, season, episode);

    // 4. Cachear en BD (URL pública desde el backend)
    const publicUrl = `${process.env.API_BASE_URL || 'http://localhost:3000'}${subtitlePath}`;
    await cacheSubtitle(contentType, contentId, publicUrl);

    return { subtitle_url: publicUrl, language: 'es' };
};

module.exports = { getSubtitle };