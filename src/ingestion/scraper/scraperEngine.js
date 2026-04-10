const { normalizeStream }     = require('../normalizer/streamNormalizer');
const { getStreamFromCineby } = require('./providers/providerC');


const scrapeContent = async ({
    tmdbId, contentId, contentType, title,
    year, season, episode
}) => {
    const results = [];

    // ─── ProviderC — Cineby/Vidfast (m3u8 directo, inglés, cacheable) ───
    try {
        console.log(`[Scraper] ProviderC: scrapeando "${title}" (tmdb:${tmdbId})`);

        const m3u8Url = await getStreamFromCineby(
            tmdbId, contentType, season, episode
        );

        if (m3u8Url) {
            results.push(normalizeStream({
                contentType,
                contentId,
                url:         m3u8Url,
                embedUrl:    null,
                streamType:  'direct',
                qualityHint: 'auto',
                serverName:  'HD',
                language:    'en-sub',  // inglés — subtítulos ES se agregan después
                priority:    1,
            }));
            console.log(`[Scraper] ProviderC — m3u8 cacheado para "${title}"`);
        }

    } catch (err) {
        console.error(`[Scraper] ProviderC falló para "${title}":`, err.message);
    }



    return results;
};

module.exports = { scrapeContent };