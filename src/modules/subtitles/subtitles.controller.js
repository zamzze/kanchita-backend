const { getSubtitle } = require('./subtitles.service');
const { error } = require('../../utils/response');

const getSubtitleForContent = async (req, res, next) => {
    try {
        const { tmdbId }                       = req.params;
        const { type, id, season, episode }    = req.query;

        if (!tmdbId || !type || !id) {
            return error(res, 'Faltan parámetros: tmdbId, type, id', 400);
        }

        const subtitle = await getSubtitle(
            parseInt(tmdbId),
            type,
            id,
            season ? parseInt(season) : null,
            episode ? parseInt(episode) : null
        );

        if (!subtitle) {
            return error(res, 'No se encontraron subtítulos', 404);
        }

        res.json({ success: true, data: subtitle });
    } catch (err) {
        next(err);
    }
};

module.exports = { getSubtitleForContent };
