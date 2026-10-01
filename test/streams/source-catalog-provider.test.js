'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.PORT ||= '3000';
process.env.DB_URL ||= 'postgresql://catalog:catalog@127.0.0.1:5432/catalog';
process.env.JWT_SECRET ||= 'catalog-test-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'catalog-test-refresh-secret';
process.env.TMDB_API_KEY ||= 'catalog-test-tmdb-key';

const {
  createSourceCatalogProvider,
} = require('../../src/modules/streams/sourceCatalogProvider');

const context = {
  contentType: 'movie',
  contentId: 'movie-fixture',
  tmdbId: 123,
};

test('source catalog provider stays passive until an authorized resolver is configured', async () => {
  const provider = createSourceCatalogProvider({
    store: {
      findActiveMappedServers: async () => [{
        catalog_source_id: 'source-1',
        catalog_item_id: 'item-1',
        server_index: 1,
        iframe_url: 'https://embed.example/watch',
        iframe_host: 'embed.example',
        source_type: 'embed',
        provider_id: 'tutorial_catalog',
        tmdb_id: 123,
      }],
    },
  });

  const result = await provider.resolve(context);
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'CATALOG_RESOLVER_NOT_CONFIGURED');
});

test('source catalog provider contains candidate failures and returns first resolved source', async () => {
  const seen = [];
  const provider = createSourceCatalogProvider({
    store: {
      findActiveMappedServers: async () => [
        {
          catalog_source_id: 'source-1',
          catalog_item_id: 'item-1',
          server_index: 1,
          iframe_url: 'https://embed.example/one',
          iframe_host: 'embed.example',
          source_type: 'embed',
          provider_id: 'tutorial_catalog',
          tmdb_id: 123,
        },
        {
          catalog_source_id: 'source-2',
          catalog_item_id: 'item-1',
          server_index: 2,
          iframe_url: 'https://embed.example/two',
          iframe_host: 'embed.example',
          source_type: 'embed',
          provider_id: 'tutorial_catalog',
          tmdb_id: 123,
        },
      ],
    },
    resolveSource: async ({ source }) => {
      seen.push(source.id);
      if (source.id === 'source-1') throw new Error('candidate failed');
      return {
        url: 'https://media.example/catalog.m3u8',
        quality: '1080p',
      };
    },
  });

  const result = await provider.resolve(context);
  assert.deepEqual(seen, ['source-1', 'source-2']);
  assert.equal(result.url, 'https://media.example/catalog.m3u8');
  assert.equal(result.serverName, 'Catalog 2');
});

test('source catalog provider skips when the mapped catalog has no active servers', async () => {
  const provider = createSourceCatalogProvider({
    store: {
      findActiveMappedServers: async () => [],
    },
    resolveSource: async () => {
      throw new Error('must not be called');
    },
  });

  const result = await provider.resolve(context);
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'NO_CATALOG_SOURCES');
});
