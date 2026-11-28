import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDownloadLines } from '../src/lib/download-line-check';
import { getDownloadLine, setDownloadLine } from '../src/lib/download-preference';
import { fetchDownload, orderDownloadSources, readDownload } from '../src/lib/download-source';

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

test('ROS preference retries through R2 after an interrupted body and leaves the preference intact', async t => {
  setDownloadLine('ros', false);
  t.after(() => setDownloadLine('r2', false));
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return url === ros + 'a'
      ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('stream lost')); } }))
      : new Response('complete');
  });
  const [primary, backup] = orderDownloadSources(r2 + 'a', ros + 'a');
  const signal = new AbortController().signal;
  assert.deepEqual(await readDownload(primary, backup, signal, response => response.text()), {
    data: 'complete', source: 'r2', automatic: true,
  });
  assert.deepEqual(calls, [ros + 'a', r2 + 'a']);
  assert.equal(getDownloadLine(), 'ros');
  assert.deepEqual(orderDownloadSources(r2 + 'apk', undefined), [r2 + 'apk']);
  assert.deepEqual(orderDownloadSources(r2 + 'a', ros + 'a', 'r2'), [r2 + 'a', ros + 'a']);
});

test('line detection uses only readable HEAD responses for the mirrored object', async t => {
  let r2Response: Response | undefined = new Response(null, { headers: { 'Content-Length': '4662' } });
  let rosResponse = r2Response;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls.push(url);
    assert.equal(options.method, 'HEAD');
    assert.equal(options.mode, 'cors');
    const response = url.startsWith(r2) ? r2Response : rosResponse;
    if (!response) throw new TypeError('CORS failure');
    return response;
  });

  assert.deepEqual(await checkDownloadLines('https://ros.example'), { r2: 'reachable', ros: 'reachable', preferred: 'r2' });
  r2Response = undefined;
  assert.deepEqual(await checkDownloadLines('https://ros.example'), { r2: 'unknown', ros: 'reachable', preferred: 'ros' });
  r2Response = new Response(null, { status: 503 });
  rosResponse = new Response(null, { headers: { 'Content-Length': '100' } });
  assert.deepEqual(await checkDownloadLines('https://ros.example'), { r2: 'unavailable', ros: 'unknown', preferred: undefined });
  assert.equal(calls.length, 6);
  assert.equal(new URL(calls[0]!).pathname, new URL(calls[1]!).pathname);
});
