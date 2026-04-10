const { getSubtitle } = require('./subtitles.service');

const getSubtitleForContent = async (req, res, next) => {
    try {
        const { tmdbId }                       = req.params;
        const { type, id, season, episode }    = req.query;

        if (!tmdbId || !type || !id) {
            return res.status(400).json({
                success: false,
                message: 'Faltan parámetros: tmdbId, type, id'
            });
        }

        const subtitle = await getSubtitle(
            parseInt(tmdbId),
            type,
            id,
            season ? parseInt(season) : null,
            episode ? parseInt(episode) : null
        );

        if (!subtitle) {
            return res.status(404).json({
                success: false,
                message: 'No se encontraron subtítulos'
            });
        }

        res.json({ success: true, data: subtitle });
    } catch (err) {
        next(err);
    }
};

module.exports = { getSubtitleForContent };