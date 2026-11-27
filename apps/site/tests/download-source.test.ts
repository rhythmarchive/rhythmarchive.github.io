import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchDownload } from '../src/lib/download-source';

const r2 = 'https://dl.rhythmarchive.top/objects/';
const ros = 'https://ros.example/objects/';

test('failed downloads do not bypass R2 for other objects or for the same object after recovery', async t => {
  const calls: string[] = [];
  let failure = true;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method ?? 'GET', 'GET');
    calls.push(url);
    return new Response(null, { status: url === r2 + 'a' && failure ? 503 : 200 });
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await fetchDownload(r2 + 'a', ros + 'a')).automatic, true);
  }
  assert.equal((await fetchDownload(r2 + 'b', ros + 'b')).automatic, false);
  failure = false;
  assert.equal((await fetchDownload(r2 + 'a', ros + 'a')).automatic, false);
  assert.deepEqual(calls, [r2 + 'a', ros + 'a', r2 + 'a', ros + 'a', r2 + 'b', r2 + 'a']);
});

test('aborting the primary does not start a backup; an explicit ROS choice requests only ROS', async t => {
  const calls: string[] = [];
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    if (url === r2 + 'a') { controller.abort(); throw controller.signal.reason; }
    return new Response(null);
  });
  await assert.rejects(fetchDownload(r2 + 'a', ros + 'a', controller.signal), { name: 'AbortError' });
  assert.equal((await fetchDownload(ros + 'b', undefined)).automatic, false);
  assert.deepEqual(calls, [r2 + 'a', ros + 'b']);
});
