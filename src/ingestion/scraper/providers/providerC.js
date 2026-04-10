const { connect } = require('puppeteer-real-browser');
const https = require('https');

const CINEBY_BASE = 'https://cinebytv.com';

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(data); }
            });
        }).on('error', reject);
    });
}

async function getImdbId(tmdbId, type) {
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const apiKey   = process.env.TMDB_API_KEY;
    const url      = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${apiKey}`;
    try {
        const data = await httpsGet(url);
        return data.imdb_id || null;
    } catch (e) {
        console.error('[ProviderC] Error obteniendo imdb_id:', e.message);
        return null;
    }
}

async function getStreamFromCineby(tmdbId, type, season = null, episode = null) {
    let browser, page;

    try {
        // Obtener imdb_id de TMDB
        const imdbId = await getImdbId(tmdbId, type);
        if (!imdbId) {
            console.warn(`[ProviderC] No se encontró imdb_id para tmdb:${tmdbId}`);
            return null;
        }
        console.log(`[ProviderC] imdb_id: ${imdbId}`);

        // Construir URL del watch player
        let watchUrl;
        if (type === 'movie') {
            watchUrl = `${CINEBY_BASE}/watch/movie/${tmdbId}?imdb_id=${imdbId}`;
        } else {
            watchUrl = `${CINEBY_BASE}/watch/tv/${tmdbId}?imdb_id=${imdbId}&season=${season}&episode=${episode}`;
        }
        console.log(`[ProviderC] Watch URL: ${watchUrl}`);

        ({ browser, page } = await connect({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-dev-shm-usage',
            ],
            turnstile: true,
            disableXvfb: false,
        }));

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );

        // Bloquear popups y dialogs
        await page.evaluateOnNewDocument(() => { window.open = () => null; });
        page.on('dialog', async dialog => await dialog.accept());
        await page.setRequestInterception(true);

        let m3u8Url    = null;
        let resolved   = false;

        page.on('request', async request => {
            const reqUrl = request.url();

            // Bloquear tracking
            const blocked = [
                'cloudflareinsights', 'histats', 'umami',
                'google-analytics', 'doubleclick', 'disable-devtool'
            ];
            if (blocked.some(b => reqUrl.includes(b))) {
                await request.abort();
                return;
            }

            // Capturar playlist.m3u8 (master con todas las calidades)
            if (
    reqUrl.includes('wind.10018.workers.dev') &&
    reqUrl.includes('.m3u8') &&
    !resolved
) {
    if (reqUrl.includes('MTA4MA==') && reqUrl.includes('aW5kZXgubTN1OA==')) {
        // MTA4MA== = "1080" / aW5kZXgubTN1OA== = "index.m3u8"
        m3u8Url  = reqUrl;
        resolved = true;
        console.log(`[ProviderC] 1080p M3U8 capturado: ${reqUrl}`);
    } else if (!m3u8Url && reqUrl.includes('aW5kZXgubTN1OA==')) {
        // Cualquier index.m3u8 como fallback (720p, 360p)
        m3u8Url = reqUrl;
        console.log(`[ProviderC] Index M3U8 fallback: ${reqUrl}`);
    } else if (!m3u8Url) {
        // playlist.m3u8 como último recurso
        m3u8Url = reqUrl;
        console.log(`[ProviderC] Playlist M3U8 último recurso: ${reqUrl}`);
    }
}

            try { await request.continue(); } catch (e) {}
        });

        // Navegar al watch player
        await page.goto(watchUrl, {
            waitUntil: 'domcontentloaded',
            timeout:   60000
        });

        // Esperar que cargue el iframe de vidfast
        console.log('[ProviderC] Esperando carga del player...');
        await new Promise(r => setTimeout(r, 8000));

        // Buscar el frame de vidfast y clickear play si es necesario
        const frames = page.frames();
        console.log(`[ProviderC] Frames: ${frames.map(f => f.url()).join(', ')}`);

        for (const frame of frames) {
            if (frame.url().includes('vidfast.pro')) {
                console.log('[ProviderC] Frame vidfast encontrado');
                try {
                    await frame.waitForSelector(
                        'button, .play-btn, [class*="play"]',
                        { timeout: 5000 }
                    );
                    await frame.click('button, .play-btn, [class*="play"]');
                    console.log('[ProviderC] Click en vidfast play');
                } catch (e) {
                    await frame.evaluate(() => {
                        document.elementFromPoint(
                            window.innerWidth  / 2,
                            window.innerHeight / 2
                        )?.click();
                    });
                }
            }
        }

        // Esperar m3u8 hasta 60 segundos
        await Promise.race([
            new Promise(resolve => {
                const interval = setInterval(() => {
                    if (m3u8Url) {
                        clearInterval(interval);
                        // Cerrar el browser inmediatamente al encontrar el m3u8
                        page.close().catch(() => {});
                        resolve();
                    }
                }, 300);
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout: no m3u8 en 60s')), 60000)
            )
        ]);

        return m3u8Url;

    } catch (err) {
        console.error(`[ProviderC] Error: ${err.message}`);
        return null;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = { getStreamFromCineby };