import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchDownload} from '../src/lib/download-source';

test('R2 preference, two failures, one-file fallback permits, and recovery without probes',async t=>{
 const primary='https://dl.rhythmarchive.top/objects/'+ 'a'.repeat(64)+'/png', backup='https://ros.example/file';
 const calls:string[]=[];let ok=true,allow=true,now=1234;
 t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async (url:URL|string)=>{calls.push(String(url));return new Response(null,{status:String(url).includes('/fallback/')?(allow?204:429):String(url)===primary&&!ok?503:200});});
 assert.equal((await fetchDownload(primary,backup)).automatic,false);ok=false;
 assert.equal((await fetchDownload(primary,backup)).response.status,503);assert.equal((await fetchDownload(primary,backup)).automatic,true);
 allow=false;await assert.rejects(fetchDownload(primary,backup));assert.equal(calls.filter(x=>x===backup).length,1);
 ok=true;now+=61000;assert.equal((await fetchDownload(primary,backup)).automatic,false);assert.equal(calls.at(-1),primary);
});
