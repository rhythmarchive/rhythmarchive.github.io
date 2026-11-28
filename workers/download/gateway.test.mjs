import {test} from 'node:test';
import assert from 'node:assert/strict';
import copies from '../../catalog/r2-downloads.json' with { type: 'json' };
import gateway from './gateway.mjs';

const origin = 'https://dl.rhythmarchive.top';
const site = 'https://rhythmarchive.github.io';
const apk = `apk/arcaea/7.3.1c/${'a'.repeat(64)}/Arcaea_7.3.1c.apk`;
const movie = Object.keys(copies).find(key => key.endsWith('/mp4'));
const send = (key, env, headers, method = 'GET', ctx) => gateway.fetch(new Request(`${origin}/${key}`, { method, headers }), env, ctx);

function storage(size, type, onGet) {
  const meta = { size, etag: 'abc', httpEtag: '"abc"', writeHttpMetadata(headers) { headers.set('Content-Type', type); } };
  return { head() { return meta; }, get(key, options) { onGet?.(key, options); return { ...meta, body: new Uint8Array(options?.range?.length ?? 1) }; } };
}

test('APK and MP4 accept native byte ranges without a budget database', async () => {
  const large = { FILES: storage(3_000_000_000, 'application/vnd.android.package-archive') };
  assert.equal((await send(apk, large, undefined, 'HEAD')).headers.get('Content-Length'), '3000000000');
  const r = await send(apk, large, { Range: 'bytes=-1' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 2999999999-2999999999/3000000000');
  assert.equal((await r.arrayBuffer()).byteLength, 1);
  const video = { FILES: storage(copies[movie], 'video/mp4') };
  const seek = await send(movie, video, { Origin: site, Range: 'bytes=123-124', 'If-Range': '"abc"' });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get('Content-Type'), 'video/mp4');
  assert.equal(seek.headers.get('Content-Range'), `bytes 123-124/${copies[movie]}`);
  assert.equal(seek.headers.get('Access-Control-Allow-Origin'), site);
  assert.equal((await seek.arrayBuffer()).byteLength, 2);
  assert.equal((await send(movie, video, { Range: 'bytes=-0' })).status, 416);
  const preflight = await send(movie, video, { Origin: site, 'Access-Control-Request-Headers': 'if-range,range' }, 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Range, If-Range');
  assert.equal((await send(`objects/${'0'.repeat(64)}/mp4`, video, { Origin: site }, 'OPTIONS')).status, 404);
  assert.equal((await send(movie, video, { Range: 'bytes=123-124', 'If-Range': '"stale"' })).status, 200);
});

test('existing clients can fall back for an entire video using only the origin and allowlist checks', async () => {
  assert.equal((await send(`fallback/${movie}`, {}, { Origin: site }, 'POST')).status, 204);
  assert.equal((await send(`fallback/${movie}`, {}, { Origin: 'https://example.com' }, 'POST')).status, 403);
  assert.equal((await send(`fallback/objects/${'0'.repeat(64)}/mp4`, {}, { Origin: site }, 'POST')).status, 403);
});

test('client bursts are limited per object, with no change to cache hits', async t => {
  const key = Object.keys(copies).find(key => key.endsWith('/jpg') && copies[key] < 300_000);
  const client = { 'CF-Connecting-IP': '192.0.2.3' };
  let reads = 0, cached, pending;
  const cache = { match: async () => cached?.clone(), put: async (_, response) => { cached = response; } };
  Object.defineProperty(globalThis, 'caches', { value: { default: cache }, configurable: true });
  t.after(() => { delete globalThis.caches; });
  const calls = [];
  const env = {
    FILES: storage(copies[key], 'image/jpeg', () => { reads++; }),
    RATE_LIMITER: { limit: async ({ key }) => { calls.push(key); return { success: calls.length === 1 }; } },
  };
  assert.equal((await send(key, env, client, 'GET', { waitUntil: promise => { pending = promise; } })).headers.get('X-Archive-Cache'), 'MISS');
  await pending;
  assert.equal((await send(key, env, client)).headers.get('X-Archive-Cache'), 'HIT');
  cached = undefined;
  const limited = await send(key, env, client);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.deepEqual(calls, [`192.0.2.3:${key}`, `192.0.2.3:${key}`]);
  assert.equal(reads, 1);
});

test('a cache failure falls through to R2 and distinguishes storage errors', async t => {
  const key = Object.keys(copies).find(key => key.endsWith('/jpg'));
  Object.defineProperty(globalThis, 'caches', { value: { default: {
    match: async () => { throw Error('cache unavailable'); },
  } }, configurable: true });
  t.after(() => { delete globalThis.caches; });
  const logs = t.mock.method(console, 'warn', () => {});
  const success = await send(key, { FILES: storage(copies[key], 'image/jpeg') });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('X-Archive-Cache'), 'MISS');
  const failure = await send(key, { FILES: { get: async () => { throw Error('upstream failed'); } } });
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('X-Archive-Error'), 'r2_read');
  assert.equal(failure.headers.get('Cache-Control'), 'no-store');
  const missing = await send(key, { FILES: { get: async () => null } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('X-Archive-Error'), 'mirror_missing');
  assert.deepEqual(logs.mock.calls.map(call => call.arguments[1]), ['cache_read', 'cache_read', 'r2_read', 'cache_read', 'mirror_missing']);
});
