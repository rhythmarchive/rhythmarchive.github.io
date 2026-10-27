import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('native Worker reads version and website sources and refuses redirects without following them', async () => {
  const result = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    stdin: { loader: 'ts', resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
      import { queryVersions, VERSION_SOURCES } from '../src/version-sources.ts';
      import { collectReport } from '../src/daily-operations.ts';
      export default { async fetch() {
        const source = VERSION_SOURCES.find(x=>x.id==='phigros:apple:us');
        const versions = await queryVersions(Date.now(), fetch, [source]);
        const db = {prepare(){return {bind(){return this},async all(){return {results:[]}}}}};
        const report = await collectReport(db,'2026-10-26',Date.parse('2026-10-27T00:30:00Z'));
        const redirected = await queryVersions(Date.now(), fetch, [{...source,url:'https://redirect.example/'}]);
        return Response.json({version:versions[0],website:report.website,redirected:redirected[0]});
      }};
    ` } });
  const urls: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'operations-runtime-test', modules: true,
    compatibilityDate: '2026-09-06', script: result.outputFiles[0]!.text,
    outboundService: async request => {
      urls.push(request.url);
      if (new URL(request.url).hostname === 'redirect.example') return new Response(null,{status:302,headers:{Location:'https://never-follow.example/'}});
      if (new URL(request.url).hostname === 'itunes.apple.com') return Response.json({results:[{bundleId:'games.Pigeon.Phigros',version:'4.0.1'}]});
      return Response.json([{slug:'phigros',displayName:'Phigros',contentVersion:'4.0.1',count:550,categories:[]}]);
    },
  }] }));
  try {
    const response = await mf.dispatchFetch('http://localhost/test');
    const body = await response.json() as {version:{status:string;version:string};website:{games:{contentVersion:string}[]};redirected:{status:string;error:string}};
    assert.equal(body.version.status,'ok'); assert.equal(body.version.version,'4.0.1');
    assert.equal(body.website.games[0]?.contentVersion,'4.0.1');
    assert.equal(body.redirected.status,'unavailable'); assert.equal(body.redirected.error,'http_302');
    assert(!urls.some(url=>url.includes('never-follow.example')));
  } finally { await mf.dispose(); }
});
