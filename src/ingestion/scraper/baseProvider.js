class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  // Debe retornar array de { url, quality, serverName, language }
  // o array vacío si no encuentra nada
  async fetchStreams(tmdbId, contentType, title, year) {
    throw new Error(`Provider ${this.name} must implement fetchStreams()`);
  }

  // Utilidad compartida: espera aleatoria para no ser bloqueado
  async randomDelay(minMs = 1000, maxMs = 3000) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Utilidad compartida: extrae m3u8 de un texto/html
  extractM3u8Links(html) {
    const regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi;
    return [...new Set(html.match(regex) || [])];
  }
}

module.exports = BaseProvider;