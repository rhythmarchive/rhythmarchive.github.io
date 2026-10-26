import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/core.js';
import { beijingDate, previousDate, collectReport, renderReport, runVersionMonitor, prepareReport, sendReport, processDailyOperations, handleOperationsRequest, type OperationsEnv } from '../src/daily-operations.js';
import { parseSource, queryVersions, verification, changeKind, VERSION_SOURCES, type Source, type Observation } from '../src/version-sources.js';
import { PUBLIC_GAME_SLUGS } from '../src/public-resource-registry.js';

class Database implements D1Database {
  sqlite = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true });
  queries: string[] = [];
  failOn = '';
  constructor() {
    const root = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(root).filter(x => x.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(file, root), 'utf8'));
  }
  prepare(sql: string): D1PreparedStatement {
    const self = this;
    const statement = (values: unknown[] = []): D1PreparedStatement => ({
      bind: (...args) => statement(args),
      async run<T>(): Promise<D1Result<T>> {
        self.queries.push(sql); if (self.failOn && sql.includes(self.failOn)) throw new Error('database_failure');
        return {meta: {changes: Number(self.sqlite.prepare(sql).run(...values as SQLInputValue[]).changes)}};
      },
      async all<T>(): Promise<D1Result<T>> {
        self.queries.push(sql); if (self.failOn && sql.includes(self.failOn)) throw new Error('database_failure');
        return {results: self.sqlite.prepare(sql).all(...values as SQLInputValue[]) as T[]};
      },
      async first<T>(): Promise<T | null> {
        self.queries.push(sql); if (self.failOn && sql.includes(self.failOn)) throw new Error('database_failure');
        return self.sqlite.prepare(sql).get(...values as SQLInputValue[]) as T ?? null;
      },
    });
    return statement();
  }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  row(sql: string): Record<string, unknown> { return this.sqlite.prepare(sql).get()!; }
}
const now = Date.parse('2026-10-27T00:30:00Z');
const day = '2026-10-26';
const source = VERSION_SOURCES.find(x => x.id === 'phigros:apple:us')!;
const observation = (v = '4.0.1'): Observation => parseSource(source, JSON.stringify({results: [{bundleId: source.identity,
  version: v, currentVersionReleaseDate: '2026-10-21T00:00:00Z', releaseNotes: '新增两首歌曲', trackViewUrl: 'https://apps.apple.com/us/app/id1454809109'}]}), now);
const siteGames = PUBLIC_GAME_SLUGS.map(slug => ({slug, displayName: slug, contentVersion: '1.0.0', count: 20,
  lastUpdatedAt: new Date(now - 2 * 86_400_000).toISOString(), categories: [{slug: 'jacket', label: '曲绘', count: 20}]}));
const website = async () => Response.json(siteGames);
const envFor = (DB: Database): OperationsEnv => ({DB, DAILY_REPORT_ENABLED: 'true', VERSION_MONITOR_ENABLED: 'true',
  RESEND_API_KEY: 'test-secret', RESOURCE_REPORT_EMAIL_TO: 'owner@example.test', UPDATE_REMINDER_ADMIN_TOKEN: 'test-admin'});

test('Beijing boundaries and previous day use UTC+8, not host clock', () => {
  assert.equal(beijingDate(Date.parse('2026-10-26T16:00:00Z')), '2026-10-27');
  assert.equal(previousDate(now), day);
});
test('strict platform identity, mirror date semantics, and announcements without version', () => {
  assert.throws(() => parseSource(source, '{"results":[{"bundleId":"other","version":"9.9"}]}', now), /identity/);
  const mirror = VERSION_SOURCES.find(x => x.id === 'arcaea:616:arcaea-c')!;
  const value = parseSource(mirror, JSON.stringify([{packageName: mirror.identity, variants: [{slug:'arcaea-c', release:{version:'7.0.260c',publishedAt:'2026-10-12T00:00:00Z'}}]}]), now);
  assert.equal(value.dateMeaning, 'mirror-indexed'); assert.equal(verification(value, [value]).status, 'unverified');
  const steam = VERSION_SOURCES.find(x => x.adapter === 'steam')!;
  const news = parseSource(steam, JSON.stringify({appnews:{appid:3971950,newsitems:[{gid:'123',date:123,feedname:'steam_community_announcements',is_external_url:false,title:'New song pack',contents:'New tracks',url:'https://steamcommunity.com/announcements/123'}]}}), now);
  assert.equal(news.releaseId, '123'); assert.equal(news.version, null); assert.equal(news.dateMeaning, 'announcement');
});
test('TapTap reference table and verified public Hykb markup parse without executing scripts', () => {
  const tap = VERSION_SOURCES.find(x => x.id === 'phigros:taptap')!;
  const values = [{identifier:1,apk_whats_new:2},tap.identity,{version_label:3,update_date:4,whatsnew:5},'4.0.1.2 (160)',1792560780,{text:6},'<div>新增歌曲</div>'];
  const parsed = parseSource(tap, `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(values)}</script>`, now);
  assert.equal(parsed.version,'4.0.1.2'); assert.equal(parsed.notes,'新增歌曲');
  const hykb = VERSION_SOURCES.find(x => x.id === 'phigros:hykb')!;
  const value = parseSource(hykb, '<title>Phigros_最新消息</title><div class="game-log js_text"><div class="sp-head">版本  4.0.1.2 2026-10-21</div>新增曲目<br/>修复</div>', now);
  assert.equal(value.version,'4.0.1.2'); assert.equal(value.publishedAt,'2026-10-20T16:00:00.000Z');
});
test('query isolation, shared URL only fetched once, oversized and malformed bodies fail closed', async () => {
  const sources = VERSION_SOURCES.filter(x => x.adapter === 'mirror616'); let calls = 0;
  const result = await queryVersions(now, async () => {calls++; return new Response('not-json');}, sources);
  assert.equal(calls,1); assert.equal(result.length,sources.length); assert(result.every(x => x.status === 'unavailable'));
  const huge = await queryVersions(now, async () => new Response('x'.repeat(800 * 1024)), [source]);
  assert.equal(huge[0]?.error,'body_too_large');
  const goodAndBad = await queryVersions(now, async url => String(url).includes('itunes') ? Response.json({results:[{bundleId:source.identity,version:'4.0.1'}]}) : new Response('blocked',{status:403}), [source, sources[0]!]);
  assert.deepEqual(goodAndBad.map(x => x.status),['ok','unavailable']);
});
test('cross verification never merges channels or accepts mirror alone; detects regression and metadata', () => {
  const a = observation(), b = {...a, sourceId:'second',authority:'mirror' as const};
  assert.equal(verification(a,[a,b]).status,'multi-source');
  assert.equal(verification(a,[a,{...b,channel:'android-taptap-cn'}]).status,'single-source');
  assert.equal(verification(a,[a,{...b,version:'4.0.2'}]).status,'conflict');
  assert.equal(changeKind(a,{...a,notes:'revised'}),'metadata');
  assert.equal(changeKind(a,{...a,version:'4.0.0'}),'regression');
  assert.equal(changeKind({...a,version:'4.0'}, {...a,version:'4.0.0'}),'metadata');
});
test('first success baseline, next day change, failure preserves baseline, repeated day is no-op', async () => {
  const db = new Database(), env = envFor(db); let version = '4.0.1', failing = false, calls = 0;
  const upstream = async (url: RequestInfo | URL) => {
    calls++; if (failing || String(url) !== source.url) return new Response('',{status:503});
    return Response.json({results:[{bundleId:source.identity,version}]});
  };
  assert.equal(await runVersionMonitor(env,now,upstream),'complete');
  assert.equal(db.row('SELECT COUNT(*) AS n FROM version_changes').n,0);
  const n = calls; assert.equal(await runVersionMonitor(env,now,upstream),'already_claimed'); assert.equal(calls,n);
  version='4.0.2'; await runVersionMonitor(env,now+86_400_000,upstream);
  assert.equal(db.row('SELECT COUNT(*) AS n FROM version_changes').n,1);
  failing=true; await runVersionMonitor(env,now+2*86_400_000,upstream);
  assert.equal(JSON.parse(String(db.row('SELECT observation_json FROM version_source_state').observation_json)).version,'4.0.2');
  version='4.0.2'; await runVersionMonitor(env,now+4*86_400_000,upstream);
  assert.equal(db.row("SELECT COUNT(*) AS n FROM version_changes WHERE run_date='2026-10-31'").n,0);
  failing=false; version='4.0.1'; await runVersionMonitor(env,now+3*86_400_000,upstream);
  assert.equal(db.row("SELECT kind FROM version_changes WHERE run_date='2026-10-30'").kind,'regression');
  assert.equal(JSON.parse(String(db.row('SELECT observation_json FROM version_source_state').observation_json)).version,'4.0.2');
});
test('report queries real SQLite, full midnight boundaries, historical comparison and missing days', async () => {
  const db=new Database();
  db.sqlite.exec(`UPDATE site_totals SET total_visits=100;
    INSERT INTO site_daily VALUES('2026-10-26',20,0),('2026-10-25',10,0),('2026-10-19',5,0);
    INSERT INTO resource_stats VALUES('r1',100,40,0);
    INSERT INTO resource_daily_stats VALUES('r1','2026-10-26',10,4,0),('r1','2026-10-25',5,2,0),('r1','2026-10-19',2,1,0);`);
  const start=Date.parse('2026-10-26T00:00:00+08:00');
  for(const [i,time] of [start-1,start,start+86_400_000-1,start+86_400_000].entries())
    db.sqlite.prepare(`INSERT INTO resource_reports(id,resource_id,kind,description,created_at,due_at,expires_at) VALUES(?, 'r1','manual:other','private feedback',?,0,?)`).run(String(i),time,now+86_400_000);
  const report=await collectReport(db,day,now,website);
  assert.equal(report.feedback?.length,2); assert.equal(report.traffic?.length,8);
  assert.equal(report.traffic?.filter(x=>x.visits===null).length,5);
  assert.equal(report.website.games?.length,10);
  const text=renderReport(report); assert.match(text,/网站 1.0.0/); assert.match(text,/环比 \+10 \(100.0%\)/);
  assert.match(text,/上周同日 \+15 \(300.0%\)/); assert.match(text,/无法确认是否有更新/);
  assert.match(text,/private feedback/); assert.match(text,/BEGIN_RHYTHM_ARCHIVE_REPORT_JSON/);
  assert.match(text,/https:\/\/rhythmarchive.github.io\/r\/r1\//);
  db.failOn='site_totals'; const partial=await collectReport(db,day,now,website);
  assert.equal(partial.totals,null); assert(partial.issues.some(x=>x.includes('累计统计查询失败')));
});
test('report freeze, concurrent claim, identical retry key/payload, separate reminder budget', async () => {
  const db=new Database(), env=envFor(db);
  await prepareReport(env,day,now,website);
  const original=db.row('SELECT email_json FROM daily_operations_reports').email_json;
  const requests: {key:string|null;body:unknown}[]=[];
  const resend=async (_url: RequestInfo | URL,init?: RequestInit) => {
    requests.push({key:new Headers(init?.headers).get('Idempotency-Key'),body:init?.body});
    return new Response('',{status:503});
  };
  const statuses=await Promise.all([sendReport(env,day,now,resend),sendReport(env,day,now,resend)]);
  assert(statuses.includes('retry')); assert.equal(requests.length,1);
  assert.equal(await sendReport(env,day,now+60_000,resend),'not_due');
  await prepareReport({...env,RESOURCE_REPORT_EMAIL_TO:'different@example.test'},day,now+1,website);
  assert.equal(db.row('SELECT email_json FROM daily_operations_reports').email_json,original);
  await sendReport(env,day,now+15*60_000,resend);
  await sendReport(env,day,now+30*60_000,resend);
  assert.deepEqual(requests[0],requests[1]); assert.equal(requests.length,3);
  assert.equal(db.row('SELECT status FROM daily_operations_reports').status,'needs_review');
  assert.equal(db.row('SELECT COALESCE(SUM(attempts),0) AS n FROM update_reminder_email_daily').n,0);
});
test('uncertain send cannot cross provider idempotency window; success cannot replay', async () => {
  const db=new Database(),env=envFor(db); await prepareReport(env,day,now,website);
  await sendReport(env,day,now,async()=>{throw new Error('network');});
  let calls=0; const resend=async()=>{calls++;return Response.json({id:'provider-id'});};
  assert.equal(await sendReport(env,day,now+23*3_600_000,resend),'not_due'); assert.equal(calls,0);
  assert.equal(db.row('SELECT last_error FROM daily_operations_reports').last_error,'idempotency_window_expired');
  const db2=new Database(),env2=envFor(db2);await prepareReport(env2,day,now,website);
  assert.equal(await sendReport(env2,day,now,resend),'sent');
  assert.equal(await sendReport(env2,day,now+1000,resend),'not_due');assert.equal(calls,1);
});
test('scheduler 08:00 monitor / 08:30 mail, failure isolation and no added work on normal ticks', async () => {
  const db=new Database(),env=envFor(db);let mails=0;
  const upstream=async(url: RequestInfo | URL)=>String(url).includes('game-index')?website():String(url).includes('resend')?(mails++,Response.json({id:'id'})):new Response('',{status:503});
  await processDailyOperations(env,Date.parse('2026-10-27T00:05:00Z'),upstream);assert.equal(db.queries.length,0);
  await processDailyOperations(env,Date.parse('2026-10-27T00:00:00Z'),upstream);assert.equal(mails,0);
  assert.equal(db.row('SELECT COUNT(*) AS n FROM version_source_state').n,0);
  await processDailyOperations(env,now,upstream);assert.equal(mails,1);
  await processDailyOperations(env,now+15*60_000,upstream);assert.equal(mails,1);
});
test('admin fails closed; preview does not write, send or expose data to anonymous requests', async () => {
  const db=new Database(),env=envFor(db),url='https://api.example/v1/admin/operations/reports/2026-10-26';
  assert.equal((await handleOperationsRequest(new Request(url),env,now,website)).status,401);
  const response=await handleOperationsRequest(new Request(url,{headers:{Authorization:'Bearer test-admin'}}),env,now,website);
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(db.row('SELECT COUNT(*) AS n FROM daily_operations_reports').n,0);
  const publicTables=db.row('SELECT total_visits FROM site_totals');assert.equal(publicTables.total_visits,0);
});

test('resource totals survive absent visit row; ROS failures stay explicit without stopping report', async () => {
  const db=new Database();db.sqlite.exec(`INSERT INTO resource_daily_stats VALUES('r1','2026-10-26',12,3,0)`);
  const snapshot=await collectReport(db,day,now,website,{snapshot:async()=>({state:'unavailable',observedAt:new Date(now).toISOString(),reason:'not-configured'})});
  const current=snapshot.traffic?.find(x=>x.date===day);
  assert.equal(current?.visits,null);assert.equal(current?.views,12);assert.equal(current?.downloads,3);
  assert.equal(snapshot.ros.state,'unavailable');assert.match(renderReport(snapshot),/not-configured/);
});
test('daily report budget is independent and capped across manual backfills', async () => {
  const db=new Database(),env=envFor(db);let calls=0;
  const resend=async()=>{calls++;return Response.json({id:'id'});};
  for (const date of ['2026-10-23','2026-10-24','2026-10-25','2026-10-26']) {
    await prepareReport(env,date,now,website);await sendReport(env,date,now,resend);
  }
  assert.equal(calls,3);assert.equal(db.row('SELECT attempts FROM daily_operations_email_daily').attempts,3);
  assert.equal(db.row("SELECT attempts FROM daily_operations_reports WHERE report_date='2026-10-26'").attempts,0);
});
test('sensitive body cleanup still runs with both features disabled and no mail configuration', async () => {
  const db=new Database();
  db.sqlite.exec(`INSERT INTO daily_operations_reports(report_date,created_at,snapshot_json,email_json,status) VALUES('2026-10-20',1,'private','private','sent')`);
  await processDailyOperations({DB:db},Date.parse('2026-10-27T00:15:00Z'),website);
  assert.equal(db.row('SELECT snapshot_json FROM daily_operations_reports').snapshot_json,'');
  assert.equal(db.row('SELECT email_json FROM daily_operations_reports').email_json,'');
  assert.equal(db.row('SELECT status FROM daily_operations_reports').status,'sent');
});
