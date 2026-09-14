'use strict';

const crypto = require('node:crypto');

const MAX_TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN_VERSION = 1;
const tokenError = () => Object.assign(new Error('HLS_PROXY_TOKEN_INVALID'), {
  code: 'HLS_PROXY_TOKEN_INVALID',
});
const encode = (value) => Buffer.from(value).toString('base64url');
const decode = (value) => Buffer.from(value, 'base64url');

const createHlsProxyTokenCodec = ({ secret, ttlSeconds = 10 * 60, now = Date.now } = {}) => {
  if (typeof secret !== 'string' || secret.length < 32 || !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 || ttlSeconds > MAX_TOKEN_TTL_SECONDS || typeof now !== 'function') {
    throw new Error('HLS_PROXY_TOKEN_INVALID_CONFIG');
  }
  const key = crypto.createHash('sha256').update(`enc:${secret}`, 'utf8').digest();
  const macKey = crypto.createHash('sha256').update(`mac:${secret}`, 'utf8').digest();
  const sign = (parts) => crypto.createHmac('sha256', macKey).update(parts).digest();
  const issue = ({ streamId, targetUrl, kind = 'resource' }) => {
    if (typeof streamId !== 'string' || !/^[0-9a-f-]{36}$/i.test(streamId) ||
        !['manifest', 'resource'].includes(kind)) throw tokenError();
    let parsed;
    try { parsed = new URL(targetUrl); } catch { throw tokenError(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw tokenError();
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`kanchita-hls-proxy:${TOKEN_VERSION}`));
    const payload = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, sid: streamId,
      target: parsed.toString(), kind, exp: Math.floor(now() / 1000) + ttlSeconds }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const protectedParts = `${encode(iv)}.${encode(encrypted)}.${encode(cipher.getAuthTag())}`;
    return `${protectedParts}.${encode(sign(protectedParts))}`;
  };
  const verify = (token) => {
    if (typeof token !== 'string' || token.length > 24_000) throw tokenError();
    const parts = token.split('.');
    if (parts.length !== 4) throw tokenError();
    try {
      const protectedParts = parts.slice(0, 3).join('.');
      const signature = decode(parts[3]);
      const expected = sign(protectedParts);
      if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
        throw tokenError();
      }
      const iv = decode(parts[0]);
      const encrypted = decode(parts[1]);
      const tag = decode(parts[2]);
      if (iv.length !== 12 || tag.length !== 16) throw tokenError();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`kanchita-hls-proxy:${TOKEN_VERSION}`));
      decipher.setAuthTag(tag);
      const payload = JSON.parse(Buffer.concat([
        decipher.update(encrypted), decipher.final(),
      ]).toString('utf8'));
      if (payload.v !== TOKEN_VERSION || typeof payload.sid !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(payload.sid) ||
          !['manifest', 'resource'].includes(payload.kind) ||
          !Number.isInteger(payload.exp) || payload.exp <= Math.floor(now() / 1000)) {
        throw tokenError();
      }
      const target = new URL(payload.target);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw tokenError();
      }
      return Object.freeze({ streamId: payload.sid, targetUrl: target.toString(),
        kind: payload.kind, expiresAt: payload.exp });
    } catch {
      throw tokenError();
    }
  };
  return Object.freeze({ issue, verify, ttlSeconds });
};

module.exports = { MAX_TOKEN_TTL_SECONDS, createHlsProxyTokenCodec };
