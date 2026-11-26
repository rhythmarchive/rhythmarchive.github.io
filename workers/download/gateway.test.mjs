import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import gateway from './gateway.mjs';
test('monthly reservation precedes every R2 read, including ranges above 2 GiB', async()=>{
  const db=new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('./budget.sql',import.meta.url),'utf8'));
  let reads=0;
  const env={BUDGET:{prepare:sql=>({bind:n=>({run:()=>({meta:db.prepare(sql.replaceAll('?1',':n')).run({n})})})})},FILES:{head(){reads++;return {size:3000000000,etag:'abc',httpEtag:'"abc"',writeHttpMetadata(){}}},get(_,opts){reads++;assert.deepEqual(opts.range,{offset:2999999999,length:1});return {body:new Uint8Array([1])}}}};
  const call=(range,method='GET')=>gateway.fetch(new Request('https://dl.rhythmarchive.top/objects/'+'a'.repeat(64)+'/jpg',{method,headers:range?{Range:range}:{}}),env);
  assert.equal((await call()).status,503);assert.equal(reads,0);
  db.exec("INSERT INTO download_read_budget VALUES(strftime('%Y-%m','now'),5)");
  assert.equal((await call(null,'HEAD')).headers.get('Content-Length'),'3000000000');
  const r=await call('bytes=-1');assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes 2999999999-2999999999/3000000000');assert.equal((await r.arrayBuffer()).byteLength,1);
  assert.equal((await call('bytes=3000000000-')).status,416);assert.equal((await call(null,'HEAD')).status,503);assert.equal(reads,4);db.close();
});
