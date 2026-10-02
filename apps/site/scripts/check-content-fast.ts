import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadFormalCatalog, getSiteData, findWorkspaceRoot } from '../src/lib/site-data.js';
import { loadRawUpdateHistory } from '../src/lib/update-history.js';
import { PUBLIC_RESOURCE_ID_LIST } from '../../../workers/stats/src/public-resource-registry.js';
import { validateBrowseFiles } from '../../../tools/validate-browse-projection.js';
import { generateStatsResourceRegistry } from './generate-stats-resource-registry.js';

const catalog = loadFormalCatalog(); // Schema, unique identities and Object/Variant/Rendition references.
const data = getSiteData();
await validateBrowseFiles();
await generateStatsResourceRegistry(true);
const history = loadRawUpdateHistory(findWorkspaceRoot());
const publicIds = new Set(data.resources.map(r => r.resourceId));
assert.deepEqual(publicIds, new Set<string>(PUBLIC_RESOURCE_ID_LIST), 'Stats registry must match the actual public Resource collection');
assert.equal(publicIds.size, data.resources.length);
assert.equal(new Set(data.resources.map(r => r.route)).size, data.resources.length);
const batches = [...history.baselines, ...history.records];
assert.equal(new Set(batches.map(b => b.id)).size, batches.length);
const resources = new Map(catalog.resources.map(r => [r.id, r]));
for (const record of history.records) {
  assert.equal(record.kind, 'update');
  assert.equal(new Set(record.items.map(i => i.resourceId)).size, record.items.length);
  assert.ok(record.items.every(i => resources.get(i.resourceId)?.game === record.game), `Dangling or mismatched timeline reference: ${record.id}`);
}
for (let i = 1; i < data.updates.length; i++) assert.ok(Date.parse(data.updates[i - 1]!.publishedAt) >= Date.parse(data.updates[i]!.publishedAt));
for (const update of data.updates) assert.ok(update.items.every(i => publicIds.has(i.resourceId) && i.game === update.game));
let previous: typeof catalog | undefined;
try {
  execFileSync('git', ['rev-parse', '--show-toplevel']);
  previous = JSON.parse(execFileSync('git', ['show', `${process.env.RHYTHM_COMPARE_BASE ?? 'HEAD'}:catalog/index.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch { /* Initial Catalog has no baseline. */ }
const oldResources = new Map(previous?.resources.map(r => [r.id, JSON.stringify(r)]));
const oldObjects = new Set(previous?.objects.map(o => o.id));
const changed = catalog.resources.filter(r => oldResources.get(r.id) !== JSON.stringify(r)).length;
const objects = catalog.objects.filter(o => !oldObjects.has(o.id)).length;
console.log(`FAST CONTENT PASS: ${changed} changed resources / ${objects} new objects / Catalog, Browse projection, Updates and target routes valid`);
