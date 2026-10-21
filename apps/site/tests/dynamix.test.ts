import assert from 'node:assert/strict';
import test from 'node:test';
import { getSiteData } from '../src/lib/site-data.js';
import { getCategoryBrowseConfig } from '../src/lib/category-browse.js';
import { matchesChartFilters } from '../src/lib/chart-filters.js';
import { compareGalleryHighestLevel } from '../src/lib/gallery-sort.js';

const data = getSiteData();
const jackets = data.resources.filter(r => r.game === 'dynamix' && r.resourceType === 'jacket');
const characters = data.resources.filter(r => r.game === 'dynamix' && r.resourceType === 'character-portrait');

test('Dynamix publishes only verified jackets and grouped characters with preview-only cards', () => {
  assert.equal(jackets.length, 562);
  assert.equal(characters.length, 298);
  for (const r of [...jackets, ...characters]) {
    assert.ok(r.preview.small && r.preview.medium && r.original);
    assert.ok(!r.preview.small.url.endsWith('.png'));
    assert.equal(r.upscaled, undefined);
  }
  assert.equal(data.games.find(g => g.slug === 'dynamix')?.categories.length, 2);
});

test('Dynamix preserves chart rows and excludes course placeholders, constants and unverified note counts', () => {
  const cross = jackets.find(r => r.displayTitle === 'Cross†Soul')!;
  assert.deepEqual(cross.charts?.map(c => [c.difficulty, c.level]), [['BASIC','2'],['NORMAL','6'],['HARD','8'],['MEGA','14'],['GIGA','15']]);
  assert.equal(matchesChartFilters(cross, { difficulties: ['GIGA'], levels: ['14'] }), false);
  assert.equal(matchesChartFilters(cross, { difficulties: ['GIGA'], levels: ['15'] }), true);
  const courses = jackets.filter(r => r.metadata.contentKind === '段位封面');
  assert.equal(courses.length, 12);
  assert.ok(courses.every(r => r.charts?.length === 0));
  assert.ok(jackets.flatMap(r => r.charts ?? []).every(c => c.constant === undefined));
  assert.ok(cross.charts?.some(c => c.notes !== undefined && c.notes === c.combo));
  const conflicted = jackets.find(r => r.displayTitle === 'Faithtival')!.charts!.find(c => c.difficulty === 'BASIC')!;
  assert.equal(conflicted.notes, undefined);
  assert.ok(conflicted.combo && conflicted.combo > 0);
});

test('Dynamix keeps multiple pack memberships independently filterable and orders integer levels', () => {
  const deadline = jackets.find(r => r.displayTitle === 'DeaDLiNE')!;
  assert.deepEqual(deadline.facets?.pack, ['DeaDLiNE', 'Event Bundle #1']);
  const config = getCategoryBrowseConfig('dynamix', 'jacket', jackets);
  assert.deepEqual(config.facets.find(f => f.key === 'chart')?.options.map(o => o.value), ['BASIC','NORMAL','HARD','MEGA','GIGA']);
  assert.ok(!config.facets.some(f => f.key === 'level'));
  assert.ok(!config.facets.some(f => f.key === 'constant' || f.key === 'version'));
  assert.ok(config.sortOptions.some(o => o.label === '最高等级高 → 低'));
  const a = { displayTitle: 'A', charts: [{ level: '9' }] };
  const b = { displayTitle: 'B', charts: [{ level: '15' }] };
  assert.ok(compareGalleryHighestLevel(a,b,false) < 0);
  assert.ok(compareGalleryHighestLevel(a,b,true) > 0);
  assert.ok(compareGalleryHighestLevel({displayTitle:'course'},a,true) > 0);
});

test('Dynamix characters retain alpha originals and multiple stills as variants, without raw gameplay parameters', () => {
  const c = characters.find(r => r.displayTitle === 'Catherina')!;
  assert.ok(c.variants.length > 1);
  assert.equal(c.categoryLabel, '角色');
  assert.ok(c.variants.every(v => v.original?.mime === 'image/png'));
  assert.equal(c.metadata.skills, '经验加成 / 伤害修正');
  assert.equal(c.metadata.parameter_encoded_raw, undefined);
});
