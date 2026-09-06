'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://streams:streams@127.0.0.1:5432/streams';
process.env.JWT_SECRET ||= 'streams-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'streams-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'streams-test-tmdb-key';

const TEST_DB_URL = process.env.TEST_DB_URL;
const schema = `kanchita_streams_${crypto.randomBytes(6).toString('hex')}`;
const adminPool = TEST_DB_URL ? new Pool({ connectionString: TEST_DB_URL }) : null;
const pool = TEST_DB_URL ? new Pool({
  connectionString: TEST_DB_URL,
  options: `-c search_path=${schema},public`,
}) : null;

const { runMigrations } = require('../../database/migrate');
const { createHlsValidator } = require('../../src/modules/streams/hlsValidator');
const { createStreamsService } = require('../../src/modules/streams/streams.service');
const configuredPool = require('../../src/config/db');

let server;
let baseUrl;

const masterManifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nmedia.m3u8\n';
const mediaManifest = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n';

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    if (url.pathname === '/master') return res.end(masterManifest);
    if (url.pathname === '/media') return res.end(mediaManifest);
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/master' });
      return res.end();
    }
    if (url.pathname === '/redirect-loop') {
      res.writeHead(302, { Location: '/redirect-loop' });
      return res.end();
    }
    if (url.pathname === '/forbidden') {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (url.pathname === '/missing') {
      res.writeHead(404);
      return res.end('missing');
    }
    if (url.pathname === '/html') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html>not hls</html>');
    }
    if (url.pathname === '/empty') return res.end('');
    if (url.pathname === '/large') return res.end(`#EXTM3U\n${'x'.repeat(4096)}`);
    if (url.pathname === '/timeout') {
      return setTimeout(() => res.end(mediaManifest), 250);
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  if (TEST_DB_URL) {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    await runMigrations({ pool, logger: { log() {} } });
  }
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await pool?.end();
  await configuredPool.end().catch(() => {});
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});

test('HLS validator blocks unsafe destinations by default', async (t) => {
  const neverRequest = async () => {
    throw new Error('unsafe destination reached transport');
  };
  const validate = createHlsValidator({ requestImpl: neverRequest });

  await t.test('rejects non-public IPv4 ranges', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.10.20',
      '192.168.1.25',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      assert.equal(
        (await validate(`http://${address}/manifest.m3u8`)).code,
        'HLS_UNSAFE_DESTINATION'
      );
    }
  });

  await t.test('rejects localhost names before transport', async () => {
    assert.equal(
      (await validate('http://localhost/manifest.m3u8')).code,
      'HLS_UNSAFE_DESTINATION'
    );
    assert.equal(
      (await validate('http://media.localhost/manifest.m3u8')).code,
      'HLS_UNSAFE_DESTINATION'
    );
  });

  await t.test('rejects non-public and mapped-private IPv6', async () => {
    for (const address of [
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:192.168.1.1',
    ]) {
      assert.equal(
        (await validate(`http://[${address}]/manifest.m3u8`)).code,
        'HLS_UNSAFE_DESTINATION'
      );
    }
  });

  await t.test('rejects hostname if any DNS answer is private and fails closed', async () => {
    let requests = 0;
    const mixedDnsValidator = createHlsValidator({
      dnsLookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ],
      requestImpl: async () => { requests += 1; },
    });
    assert.equal(
      (await mixedDnsValidator('https://mixed.example/manifest.m3u8')).code,
      'HLS_UNSAFE_DESTINATION'
    );
    assert.equal(requests, 0);

    const dnsFailureValidator = createHlsValidator({
      dnsLookup: async () => { throw new Error('fixture DNS failure'); },
      requestImpl: neverRequest,
    });
    assert.equal(
      (await dnsFailureValidator('https://missing.example/manifest.m3u8')).code,
      'HLS_UNSAFE_DESTINATION'
    );

    const dnsTimeoutValidator = createHlsValidator({
      timeoutMs: 20,
      dnsLookup: async () => new Promise(() => {}),
      requestImpl: neverRequest,
    });
    assert.equal(
      (await dnsTimeoutValidator('https://slow-dns.example/manifest.m3u8')).code,
      'HLS_TIMEOUT'
    );
  });

  await t.test('validates every redirect target before a second request', async () => {
    let requests = 0;
    const redirectValidator = createHlsValidator({
      dnsLookup: async (hostname) => hostname === 'public.example'
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
      requestImpl: async () => {
        requests += 1;
        return {
          status: 302,
          location: 'http://private.example/manifest.m3u8',
          body: null,
        };
      },
    });
    assert.equal(
      (await redirectValidator('https://public.example/manifest.m3u8')).code,
      'HLS_UNSAFE_DESTINATION'
    );
    assert.equal(requests, 1);
  });

  await t.test('a fully public DNS policy reaches the pinned request transport', async () => {
    let requestOptions;
    const publicValidator = createHlsValidator({
      dnsLookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
      requestImpl: async (url, options) => {
        requestOptions = { url: url.toString(), ...options };
        return { status: 200, location: null, body: Buffer.from(mediaManifest) };
      },
    });
    assert.deepEqual(
      await publicValidator('https://public.example/manifest.m3u8'),
      { valid: true, code: null }
    );
    assert.equal(requestOptions.addresses[0].address, '8.8.8.8');
  });
});

test('HLS validator accepts only bounded, valid manifests', async (t) => {
  const denied = createHlsValidator();
  assert.equal(
    (await denied(`${baseUrl}/master`)).code,
    'HLS_UNSAFE_DESTINATION'
  );

  const validate = createHlsValidator({
    timeoutMs: 75,
    maxBytes: 1024,
    maxRedirects: 2,
    allowPrivateNetworks: true,
  });

  await t.test('accepts master and media playlists', async () => {
    assert.deepEqual(await validate(`${baseUrl}/master`), { valid: true, code: null });
    assert.deepEqual(await validate(`${baseUrl}/media`), { valid: true, code: null });
  });

  await t.test('follows a bounded valid redirect', async () => {
    assert.deepEqual(await validate(`${baseUrl}/redirect`), { valid: true, code: null });
  });

  await t.test('rejects unsupported protocols and redirect excess', async () => {
    assert.equal((await validate('ftp://example.test/file.m3u8')).code, 'HLS_INVALID_URL');
    assert.equal(
      (await validate(`${baseUrl}/redirect-loop`)).code,
      'HLS_TOO_MANY_REDIRECTS'
    );
  });

  await t.test('classifies 403 and 404 as HTTP failures', async () => {
    assert.equal((await validate(`${baseUrl}/forbidden`)).code, 'HLS_HTTP_ERROR');
    assert.equal((await validate(`${baseUrl}/missing`)).code, 'HLS_HTTP_ERROR');
  });

  await t.test('rejects timeout, empty, HTML and oversized bodies', async () => {
    assert.equal((await validate(`${baseUrl}/timeout`)).code, 'HLS_TIMEOUT');
    assert.equal((await validate(`${baseUrl}/empty`)).code, 'HLS_INVALID_MANIFEST');
    assert.equal((await validate(`${baseUrl}/html`)).code, 'HLS_INVALID_MANIFEST');
    assert.equal((await validate(`${baseUrl}/large`)).code, 'HLS_TOO_LARGE');
  });
});

test(
  'stream lifecycle uses PostgreSQL persistence and coordination',
  { skip: TEST_DB_URL ? false : 'Set TEST_DB_URL to run stream lifecycle integration tests' },
  async (t) => {
    let tmdbCounter = 1000;

    const createContent = async (contentType) => {
      tmdbCounter += 1;
      if (contentType === 'movie') {
        const { rows } = await pool.query(
          `INSERT INTO movies (tmdb_id, title, is_published)
           VALUES ($1, $2, TRUE) RETURNING id, tmdb_id, title`,
          [tmdbCounter, `Movie ${tmdbCounter}`]
        );
        return rows[0];
      }

      const series = await pool.query(
        `INSERT INTO series (tmdb_id, title, is_published)
         VALUES ($1, $2, TRUE) RETURNING id, tmdb_id`,
        [tmdbCounter, `Series ${tmdbCounter}`]
      );
      const { rows } = await pool.query(
        `INSERT INTO episodes
           (series_id, season_number, episode_number, title, is_published)
         VALUES ($1, 1, 1, 'Pilot', TRUE)
         RETURNING id`,
        [series.rows[0].id]
      );
      return { ...rows[0], tmdb_id: series.rows[0].tmdb_id };
    };

    const insertStream = async (contentType, contentId, overrides = {}) => {
      const values = {
        serverName: 'HD',
        url: `${baseUrl}/media`,
        status: 'ready',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        resolvedAt: new Date(),
        verifiedAt: new Date(),
        failureCount: 0,
        nextRetryAt: null,
        errorCode: null,
        ...overrides,
      };
      const { rows } = await pool.query(
        `INSERT INTO streams (
           content_type, content_id, server_name, quality, language,
           stream_url, stream_type, priority, provider, status,
           expires_at, resolved_at, last_verified_at, failure_count,
           next_retry_at, last_error_code
         ) VALUES (
           $1, $2, $3, 'auto', 'en-sub', $4, 'direct', 1, 'fixture', $5,
           $6, $7, $8, $9, $10, $11
         ) RETURNING *`,
        [
          contentType,
          contentId,
          values.serverName,
          values.url,
          values.status,
          values.expiresAt,
          values.resolvedAt,
          values.verifiedAt,
          values.failureCount,
          values.nextRetryAt,
          values.errorCode,
        ]
      );
      return rows[0];
    };

    const makeLogger = () => {
      const messages = [];
      return {
        messages,
        log: (message) => messages.push(message),
        warn: (message) => messages.push(message),
      };
    };

    const makeService = ({ resolver, validator, logger = makeLogger() } = {}) => {
      let resolverCalls = 0;
      const service = createStreamsService({
        db: pool,
        resolver: async (context) => {
          resolverCalls += 1;
          return resolver
            ? resolver(context, resolverCalls)
            : {
                url: `${baseUrl}/media`,
                provider: 'fixture',
                expiresAt: null,
              };
        },
        validator: validator || createHlsValidator({
          timeoutMs: 200,
          maxBytes: 2048,
          allowPrivateNetworks: true,
        }),
        subtitleFetcher: async () => null,
        subscriptionFetcher: async () => null,
        logger,
        cacheTtlMinutes: 60,
        verifyIntervalMinutes: 10,
        lockTimeoutMs: 1000,
      });
      return { service, logger, resolverCalls: () => resolverCalls };
    };

    const getForType = (service, contentType, contentId) => contentType === 'movie'
      ? service.getMovieStreams(contentId, null)
      : service.getEpisodeStreams(contentId, null);

    await t.test('fresh ready stream is a compatible cache hit without resolver', async () => {
      const movie = await createContent('movie');
      await insertStream('movie', movie.id);
      let validatorCalls = 0;
      const setup = makeService({
        validator: async () => {
          validatorCalls += 1;
          return { valid: true, code: null };
        },
      });
      const response = await setup.service.getMovieStreams(movie.id, null);

      assert.equal(setup.resolverCalls(), 0);
      assert.equal(validatorCalls, 0);
      assert.equal(response.content_id, movie.id);
      assert.equal(response.content_type, 'movie');
      assert.equal(response.subtitle_url, null);
      assert.equal(response.streams.length, 1);
      assert.deepEqual(Object.keys(response.streams[0]).sort(), [
        'embed_url', 'language', 'priority', 'quality', 'server_name',
        'stream_type', 'stream_url',
      ]);
      assert.ok(setup.logger.messages.includes('[Streams] cache hit'));
    });

    await t.test('legacy unknown stream is validated and promoted to ready with TTL', async () => {
      const movie = await createContent('movie');
      const legacy = await insertStream('movie', movie.id, {
        status: 'unknown',
        expiresAt: null,
        resolvedAt: null,
        verifiedAt: null,
      });
      const setup = makeService();
      const response = await setup.service.getMovieStreams(movie.id, null);
      const stored = await pool.query(
        `SELECT status, expires_at, last_verified_at FROM streams WHERE id = $1`,
        [legacy.id]
      );

      assert.equal(setup.resolverCalls(), 0);
      assert.equal(response.streams[0].stream_url, `${baseUrl}/media`);
      assert.equal(stored.rows[0].status, 'ready');
      assert.ok(stored.rows[0].expires_at);
      assert.ok(stored.rows[0].last_verified_at);
    });

    await t.test('ready stream outside verification interval is validated, not resolved', async () => {
      const movie = await createContent('movie');
      await insertStream('movie', movie.id, {
        verifiedAt: new Date(Date.now() - 20 * 60 * 1000),
      });
      let validatorCalls = 0;
      const setup = makeService({
        validator: async () => {
          validatorCalls += 1;
          return { valid: true, code: null };
        },
      });
      await setup.service.getMovieStreams(movie.id, null);
      assert.equal(validatorCalls, 1);
      assert.equal(setup.resolverCalls(), 0);
    });

    await t.test('expired stream is not returned directly and is resolved again', async () => {
      const movie = await createContent('movie');
      const oldUrl = `${baseUrl}/media?token=old-sensitive-token`;
      await insertStream('movie', movie.id, {
        url: oldUrl,
        expiresAt: new Date(Date.now() - 1000),
      });
      const validatedUrls = [];
      const setup = makeService({
        validator: async (url) => {
          validatedUrls.push(url);
          return { valid: true, code: null };
        },
        resolver: async () => ({
          url: `${baseUrl}/media?token=new-sensitive-token`,
          provider: 'fixture',
          expiresAt: null,
        }),
      });
      const response = await setup.service.getMovieStreams(movie.id, null);

      assert.equal(setup.resolverCalls(), 1);
      assert.ok(!validatedUrls.includes(oldUrl));
      assert.match(response.streams[0].stream_url, /new-sensitive-token/);
    });

    await t.test('successful resolution writes lifecycle and resets failures', async () => {
      const movie = await createContent('movie');
      const failed = await insertStream('movie', movie.id, {
        url: null,
        status: 'failed',
        expiresAt: null,
        resolvedAt: null,
        verifiedAt: null,
        failureCount: 3,
        nextRetryAt: new Date(Date.now() - 1000),
        errorCode: 'RESOLUTION_FAILED',
      });
      const setup = makeService();
      await setup.service.getMovieStreams(movie.id, null);
      const stored = await pool.query('SELECT * FROM streams WHERE id = $1', [failed.id]);

      assert.equal(stored.rows[0].status, 'ready');
      assert.equal(stored.rows[0].provider, 'fixture');
      assert.equal(stored.rows[0].failure_count, 0);
      assert.equal(stored.rows[0].last_failure_at, null);
      assert.equal(stored.rows[0].next_retry_at, null);
      assert.equal(stored.rows[0].last_error_code, null);
      assert.ok(stored.rows[0].resolved_at);
      assert.ok(stored.rows[0].last_verified_at);
      assert.ok(stored.rows[0].expires_at);
    });

    await t.test('invalid newly resolved manifest records one stable validation failure', async () => {
      const movie = await createContent('movie');
      const setup = makeService({
        resolver: async () => ({
          url: `${baseUrl}/html?token=not-logged`,
          provider: 'fixture',
          expiresAt: null,
        }),
      });
      await assert.rejects(
        setup.service.getMovieStreams(movie.id, null),
        (error) => error.statusCode === 503
      );
      const stored = await pool.query(
        `SELECT status, failure_count, last_error_code, next_retry_at
         FROM streams WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].status, 'failed');
      assert.equal(stored.rows[0].failure_count, 1);
      assert.equal(stored.rows[0].last_error_code, 'HLS_INVALID_MANIFEST');
      assert.ok(stored.rows[0].next_retry_at);
      assert.ok(!setup.logger.messages.join('\n').includes('not-logged'));
    });

    await t.test('one failed operation increments once, sets backoff and suppresses retries', async () => {
      const movie = await createContent('movie');
      await insertStream('movie', movie.id, {
        url: `${baseUrl}/html`,
        status: 'unknown',
        expiresAt: null,
        resolvedAt: null,
        verifiedAt: null,
      });
      const setup = makeService({ resolver: async () => null });

      await assert.rejects(
        setup.service.getMovieStreams(movie.id, null),
        (error) => error.statusCode === 503 &&
          error.code === 'STREAM_TEMPORARILY_UNAVAILABLE'
      );
      assert.equal(setup.resolverCalls(), 1);
      let stored = await pool.query(
        `SELECT status, failure_count, last_failure_at, next_retry_at, last_error_code
         FROM streams WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );
      assert.equal(stored.rows[0].status, 'failed');
      assert.equal(stored.rows[0].failure_count, 1);
      assert.ok(stored.rows[0].last_failure_at);
      assert.ok(stored.rows[0].next_retry_at);
      assert.equal(stored.rows[0].last_error_code, 'RESOLUTION_FAILED');

      await assert.rejects(
        setup.service.getMovieStreams(movie.id, null),
        (error) => error.statusCode === 503
      );
      assert.equal(setup.resolverCalls(), 1);

      await pool.query(
        `UPDATE streams SET next_retry_at = NOW() - INTERVAL '1 second'
         WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );
      const recovery = makeService();
      await recovery.service.getMovieStreams(movie.id, null);
      assert.equal(recovery.resolverCalls(), 1);
    });

    await t.test('movie and episode use the same lifecycle policy', async () => {
      for (const contentType of ['movie', 'episode']) {
        const content = await createContent(contentType);
        await insertStream(contentType, content.id, {
          status: 'unknown',
          expiresAt: null,
          resolvedAt: null,
          verifiedAt: null,
        });
        const setup = makeService();
        const response = await getForType(setup.service, contentType, content.id);
        assert.equal(response.content_type, contentType);
        assert.equal(setup.resolverCalls(), 0);
      }
    });

    await t.test('logs never contain signed URL query tokens', async () => {
      const movie = await createContent('movie');
      const secretMarker = 'do-not-log-this-token';
      const setup = makeService({
        resolver: async () => ({
          url: `${baseUrl}/media?token=${secretMarker}`,
          provider: 'fixture',
          expiresAt: null,
        }),
      });
      await setup.service.getMovieStreams(movie.id, null);
      assert.ok(!setup.logger.messages.join('\n').includes(secretMarker));
      assert.ok(!setup.logger.messages.join('\n').includes('.m3u8?'));
    });

    await t.test('same-content concurrency resolves once and rechecks after lock', async () => {
      const movie = await createContent('movie');
      const setup = makeService({
        resolver: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { url: `${baseUrl}/media`, provider: 'fixture', expiresAt: null };
        },
      });
      const [first, second] = await Promise.all([
        setup.service.getMovieStreams(movie.id, null),
        setup.service.getMovieStreams(movie.id, null),
      ]);

      assert.equal(setup.resolverCalls(), 1);
      assert.equal(first.streams[0].stream_url, second.streams[0].stream_url);
      assert.ok(setup.logger.messages.includes('[Streams] cache hit'));
    });

    await t.test('different content keys do not block one another', async () => {
      const first = await createContent('movie');
      const second = await createContent('movie');
      let active = 0;
      let maxActive = 0;
      const setup = makeService({
        resolver: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 100));
          active -= 1;
          return { url: `${baseUrl}/media`, provider: 'fixture', expiresAt: null };
        },
      });

      await Promise.all([
        setup.service.getMovieStreams(first.id, null),
        setup.service.getMovieStreams(second.id, null),
      ]);
      assert.equal(setup.resolverCalls(), 2);
      assert.equal(maxActive, 2);
    });

    await t.test('resolver error releases advisory lock for a later attempt', async () => {
      const movie = await createContent('movie');
      const broken = makeService({ resolver: async () => { throw new Error('fixture failure'); } });
      await assert.rejects(
        broken.service.getMovieStreams(movie.id, null),
        (error) => error.statusCode === 503
      );
      await pool.query(
        `UPDATE streams SET next_retry_at = NOW() - INTERVAL '1 second'
         WHERE content_type = 'movie' AND content_id = $1`,
        [movie.id]
      );

      const recovered = makeService();
      const response = await recovered.service.getMovieStreams(movie.id, null);
      assert.equal(response.streams.length, 1);
      assert.equal(recovered.resolverCalls(), 1);
    });

    await t.test('missing content remains 404 rather than transient 503', async () => {
      const setup = makeService();
      await assert.rejects(
        setup.service.getMovieStreams(crypto.randomUUID(), null),
        (error) => error.statusCode === 404
      );
      assert.equal(setup.resolverCalls(), 0);
    });
  }
);
