import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import gateway from './gateway.mjs';
test('monthly reservation precedes every R2 read, including ranges above 2 GiB', async()=>{
  const db=new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('./budget.sql',import.meta.url),'utf8'));
  let reads=0;
  const env={BUDGET:{prepare:sql=>({bind:n=>({run:()=>({meta:db.prepare(sql.replaceAll('?1',':n')).run({n})})})})},FILES:{head(){reads++;return {size:3000000000,etag:'abc',httpEtag:'"abc"',writeHttpMetadata(){}}},get(_,opts){reads++;assert.deepEqual(opts.range,{offset:2999999999,length:1});return {body:new Uint8Array([1])}}}};
  const call=(range,method='GET')=>gateway.fetch(new Request('https://dl.rhythmarchive.top/apk/arcaea/7.3.1c/'+'a'.repeat(64)+'/Arcaea_7.3.1c.apk',{method,headers:range?{Range:range}:{}}),env);
  assert.equal((await call()).status,503);assert.equal(reads,0);
  db.exec("INSERT INTO download_read_budget VALUES(strftime('%Y-%m','now'),5)");
  assert.equal((await call(null,'HEAD')).headers.get('Content-Length'),'3000000000');
  const r=await call('bytes=-1');assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes 2999999999-2999999999/3000000000');assert.equal((await r.arrayBuffer()).byteLength,1);
  assert.equal((await call('bytes=3000000000-')).status,416);assert.equal((await call(null,'HEAD')).status,503);assert.equal(reads,4);db.close();
});

test('ROS permit consumes exact verified bytes once; missing budget or foreign origin is rejected',async()=>{
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./fallback-budget.sql',import.meta.url),'utf8'));
  const env={BUDGET:{prepare:sql=>({bind:n=>({run:()=>({meta:db.prepare(sql.replaceAll('?1',':n')).run({n})})})})}};
  const grant=(origin='https://rhythmarchive.github.io')=>gateway.fetch(new Request('https://dl.rhythmarchive.top/fallback/objects/18fb2ce1ba89273ad7dc4c5f64426f7e723e8b52d065b1bf0fc1017a2f23515f/jpg',{method:'POST',headers:{Origin:origin}}),env);
  assert.equal((await grant()).status,429);db.exec("INSERT INTO ros_fallback_budget VALUES(date('now'),215325)");assert.equal((await grant('https://example.org')).status,403);assert.equal((await grant()).status,204);assert.equal((await grant()).status,429);db.close();
});

test('full immutable image hits bypass D1/R2; misses reserve once and protect the APK floor',async t=>{
 const copies=JSON.parse(readFileSync(new URL('../../catalog/r2-downloads.json',import.meta.url),'utf8'));const real=Object.keys(copies).find(k=>copies[k]>0&&copies[k]<300000);
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./budget.sql',import.meta.url),'utf8'));db.exec("INSERT INTO download_read_budget VALUES(strftime('%Y-%m','now'),1501)");
 let writes=0,reads=0,stored,pending;const cache={match:async()=>stored?.clone(),put:async(_,r)=>{stored=r}};
 Object.defineProperty(globalThis,'caches',{value:{default:cache},configurable:true});t.after(()=>{delete globalThis.caches;db.close()});
 const env={BUDGET:{prepare:sql=>({bind:n=>({run:()=>{writes++;return {meta:db.prepare(sql.replaceAll('?1',':n')).run({n})}}})})},FILES:{get(){reads++;return {size:copies[real],httpEtag:'"a"',body:new Uint8Array(copies[real]),writeHttpMetadata(h){h.set('Content-Type','image/png')}}}}};
 const send=()=>gateway.fetch(new Request('https://dl.rhythmarchive.top/'+real),env,{waitUntil:p=>pending=p});
 assert.equal((await send()).headers.get('X-Archive-Cache'),'MISS');await pending;assert.equal((await send()).headers.get('X-Archive-Cache'),'HIT');assert.equal(writes,1);assert.equal(reads,1);stored=undefined;assert.equal((await send()).status,503);assert.equal(reads,1);
});
