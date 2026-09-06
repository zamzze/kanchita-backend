const redactSensitive = (value) => String(value ?? '')
  .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
  .replace(
    /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password)=)[^&\s]+/gi,
    '$1[REDACTED]'
  )
  .replace(/\b(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@')
  .replace(
    /https?:\/\/[^\s"'`]+\.m3u8(?:\?[^\s"'`]*)?/gi,
    '[REDACTED_STREAM_URL]'
  );

module.exports = { redactSensitive };
