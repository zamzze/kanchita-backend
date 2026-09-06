'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const forbiddenFromApi = new Set([
  path.join(root, 'src/ingestion/scraper/providers/providerC.js'),
  path.join(root, 'src/modules/streams/streamResolver.js'),
  path.join(root, 'src/modules/streams/streamProcessor.js'),
  path.join(root, 'src/modules/streams/resolverExecutor.js'),
  path.join(root, 'src/workers/streamResolverChild.js'),
]);

const relativeRequires = (file) => {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)]
    .map((match) => {
      const candidate = path.resolve(path.dirname(file), match[1]);
      for (const resolved of [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]) {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
      }
      return null;
    })
    .filter(Boolean);
};

const dependencyGraph = (entry) => {
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of relativeRequires(file)) visit(dependency);
  };
  visit(entry);
  return visited;
};

test('API and scheduler dependency graph cannot reach heavy stream resolution', () => {
  const apiGraph = dependencyGraph(path.join(root, 'server.js'));
  for (const forbidden of forbiddenFromApi) {
    assert.equal(apiGraph.has(forbidden), false, `${forbidden} is reachable from server.js`);
  }
});

test('worker reaches the executor but ProviderC only exists behind the child boundary', () => {
  const workerGraph = dependencyGraph(
    path.join(root, 'src/workers/streamResolutionWorker.js')
  );
  assert.equal(
    workerGraph.has(path.join(root, 'src/modules/streams/streamProcessor.js')),
    true
  );
  assert.equal(
    workerGraph.has(path.join(root, 'src/modules/streams/resolverExecutor.js')),
    true
  );
  assert.equal(workerGraph.has(path.join(root, 'src/modules/streams/streamResolver.js')), false);
  assert.equal(
    workerGraph.has(path.join(root, 'src/ingestion/scraper/providers/providerC.js')),
    false
  );

  const childGraph = dependencyGraph(path.join(root, 'src/workers/streamResolverChild.js'));
  assert.equal(childGraph.has(path.join(root, 'src/modules/streams/streamResolver.js')), true);
  assert.equal(
    childGraph.has(path.join(root, 'src/ingestion/scraper/providers/providerC.js')),
    true
  );

  const sourceFiles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) sourceFiles.push(target);
    }
  };
  walk(path.join(root, 'src'));

  const directProviderConsumers = sourceFiles.filter((file) =>
    fs.readFileSync(file, 'utf8').includes('providers/providerC')
  );
  assert.deepEqual(directProviderConsumers, [
    path.join(root, 'src/modules/streams/streamResolver.js'),
  ]);
  assert.equal(fs.existsSync(path.join(root, 'src/ingestion/scraper/scraperEngine.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'test-search.js')), false);
});
