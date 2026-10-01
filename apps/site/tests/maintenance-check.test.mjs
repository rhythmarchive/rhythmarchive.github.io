import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChanges, commandsFor, registryPath } from '../../../scripts/maintenance-check.mjs';
test('content and display changes stay FAST and do not deploy Worker', () => {
  for (const file of ['catalog/index.json', 'catalog/updates/index.json', 'catalog/browse/arcaea.json', 'apps/site/src/styles/global.css', 'apps/site/src/lib/update-history.ts', 'apps/site/src/lib/game-config.ts', 'apps/site/src/lib/site-data.ts']) {
    const p = classifyChanges([file]); assert.equal(p.mode, 'FAST'); assert.equal(p.deployWorker, false);
    assert.ok(!commandsFor(p).includes('npm run worker:check'));
  }
});
test('registry only deployment does not test Worker logic', () => {
  const p = classifyChanges([registryPath]); assert.equal(p.deployWorker, true); assert.equal(p.worker, false); assert.equal(p.mode, 'FAST');
});
test('Worker logic gets its own gate; shared contracts and infrastructure get FULL', () => {
  const p = classifyChanges(['workers/stats/src/core.ts']); assert.equal(p.worker, true); assert.equal(p.deployWorker, true); assert.deepEqual(commandsFor(p), ['npm run worker:check']);
  for (const file of ['packages/domain/src/schema.ts', 'apps/site/src/lib/catalog-projection.ts', '.github/workflows/pages.yml', 'apps/site/scripts/generate-public-data.ts', 'package-lock.json', 'tools/arcaea-apk-update.ts']) assert.equal(classifyChanges([file]).mode, 'FULL');
});
test('Worker tests alone run checks without redeployment', () => {
  const p = classifyChanges(['workers/stats/tests/index.test.ts']);
  assert.equal(p.worker, true); assert.equal(p.deployWorker, false);
});
