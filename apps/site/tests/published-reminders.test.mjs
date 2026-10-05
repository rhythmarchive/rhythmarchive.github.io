import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { publishedUpdateGames, resolvePublishedReminders, firstSuccessfulPublication } from '../../../scripts/resolve-published-reminders.mjs';

const history = records => ({ schemaVersion: 1, baselines: [], records });
const record = (id, game = 'phigros', publishedAt = '2026-10-05T00:00:00Z') => ({ id, game, kind: 'update', publishedAt, items: [{ resourceId: 'resource', change: 'added' }] });
const old = record('old', 'phigros', '2026-10-04T00:00:00Z');

test('ordinary commits and existing record edits never select a game', () => {
  assert.deepEqual(publishedUpdateGames(history([old]), history([old])), []);
  assert.deepEqual(publishedUpdateGames(history([old]), history([{ ...old, contentVersion: 'corrected', items: [...old.items, { resourceId: 'other' }] }])), []);
});

test('only games with new nonempty formal updates are selected, once per game', () => {
  assert.deepEqual(publishedUpdateGames(history([old]), history([old, record('new'), record('new2'), record('arcaea', 'arcaea')])), ['arcaea', 'phigros']);
  assert.deepEqual(publishedUpdateGames(history([old]), history([old, record('new')])), ['phigros']);
});

test('baselines, empty records, older history, and timestamp-only edits do not resolve', () => {
  const before = history([old]);
  const after = history([{ ...old, publishedAt: '2026-10-06T00:00:00Z' },
    { ...record('baseline'), kind: 'baseline' }, { ...record('empty'), items: [] }, record('backfill', 'phigros', '2026-10-01T00:00:00Z')]);
  after.baselines.push({ id: 'initial', game: 'arcaea', publishedAt: '2026-10-05T00:00:00Z' });
  assert.deepEqual(publishedUpdateGames(before, after), []);
});

test('ordinary publication needs no token and does not call the admin API', async () => {
  assert.deepEqual(await resolvePublishedReminders({ gameSlugs: [], fetchImpl: () => { throw new Error('must not fetch'); } }), []);
});

test('publication cutoff is the first successful deployment across all reruns', () => {
  const first = '2026-10-05T00:00:00Z';
  const later = '2026-10-05T01:00:00Z';
  assert.equal(firstSuccessfulPublication([
    { name: 'deploy', conclusion: 'failure', completed_at: '2026-10-04T23:00:00Z' },
    { name: 'build', conclusion: 'success', completed_at: '2026-10-04T23:30:00Z' },
    { name: 'deploy', conclusion: 'success', completed_at: later },
    { name: 'deploy', conclusion: 'success', completed_at: first },
  ]), '2026-10-05T00:00:00.000Z');
  assert.throws(() => firstSuccessfulPublication([{ name: 'deploy', conclusion: 'failure', completed_at: first }]), /No successful/u);
});

test('missing configuration fails visibly before any cycle mutation', async () => {
  await assert.rejects(resolvePublishedReminders({ gameSlugs: ['phigros'] }), /Set UPDATE_REMINDER_ADMIN_TOKEN/u);
});

test('post-publication resolve carries the fixed cutoff and treats no eligible cycle as a no-op', async () => {
  const calls = [];
  const createdBefore = '2026-10-05T00:00:00Z';
  const outcomes = await resolvePublishedReminders({ gameSlugs: ['phigros', 'arcaea'], apiUrl: 'https://api.example.test', token: 'test-token', createdBefore,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return calls.length === 1
        ? Response.json({ ok: true, status: 'resolved' })
        : Response.json({ error: 'pending_not_found' }, { status: 404 });
    } });
  assert.deepEqual(outcomes, [{ game: 'phigros', status: 'resolved' }, { game: 'arcaea', status: 'no_eligible_cycle' }]);
  assert.equal(calls[0].url, 'https://api.example.test/v1/admin/update-reminders/phigros/resolve');
  assert.deepEqual(calls[0].body, { createdBefore });
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].headers.Origin, 'https://rhythmarchive.github.io');
});

test('authorization and service errors do not get reported as successful resolution', async () => {
  for (const status of [401, 403, 503]) {
    await assert.rejects(resolvePublishedReminders({ gameSlugs: ['phigros'], apiUrl: 'https://api.example.test', token: 'test-token', createdBefore: '2026-10-05T00:00:00Z',
      fetchImpl: async () => Response.json({ error: 'unavailable' }, { status }) }), new RegExp(`HTTP ${status}`, 'u'));
  }
});

test('cycle resolution job depends on both successful build and Pages deployment', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('  resolve-reminders:'));
  assert.match(job, /needs: \[build, deploy\]/u);
  assert.match(job, /github\.event_name == 'push'.*github\.ref == 'refs\/heads\/main'/u);
  assert.doesNotMatch(job, /always\(\)|continue-on-error/u);
  assert.match(job, /name: stats-production/u);
});
