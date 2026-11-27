import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchDownload } from '../src/lib/download-source';

test('R2 download falls back directly on the first failure and makes no extra probes', async t => {
  const primary = 'https://dl.rhythmarchive.top/objects/' + 'a'.repeat(64) + '/png';
  const backup = 'https://ros.example/file';
  const calls: string[] = [];
  let failure = false, now = 1234;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return new Response(null, { status: url === primary && failure ? 503 : 200 });
  });
  assert.equal((await fetchDownload(primary, backup)).automatic, false);
  failure = true;
  assert.equal((await fetchDownload(primary, backup)).automatic, true);
  assert.equal((await fetchDownload(primary, backup)).automatic, true);
  assert.equal((await fetchDownload(primary, backup)).automatic, true);
  assert.deepEqual(calls, [primary, primary, backup, primary, backup, backup]);
  failure = false;
  now += 61000;
  assert.equal((await fetchDownload(primary, backup)).automatic, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchDownload(primary, backup, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 7);
});
