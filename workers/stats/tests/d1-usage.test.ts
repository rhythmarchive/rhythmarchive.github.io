import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { D1StatsStore, handleRequest, type D1Database, type D1PreparedStatement, type D1Result, type StatsEvent } from "../src/core.js";
import { RANKING_CACHE_TTL_MS, type RankingCache } from "../src/ranking-cache.js";
import { PUBLIC_RESOURCE_IDS } from "../src/public-resource-registry.js";

class SqliteD1 implements D1Database {
  // Existing D1 migrations use SQLite's legacy double-quoted string literals.
  readonly sqlite = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });
  readonly queries: string[] = [];
  missingRateRow = false;
  failRateRead = false;
  failRanking = false;
  constructor() {
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }
  prepare(sql: string): D1PreparedStatement {
    const db = this;
    function statement(values: SQLInputValue[] = []): D1PreparedStatement {
      function execute() {
        db.queries.push(sql);
        if (db.failRateRead && sql.includes("SELECT window_started_at")) throw new Error("rate read failed");
        if (db.failRanking && sql.includes("SUM(daily_views) AS total_views")) throw new Error("ranking failed");
        return db.sqlite.prepare(sql);
      }
      return {
        bind: (...args) => statement(args as SQLInputValue[]),
        async run<T>(): Promise<D1Result<T>> {
          return { meta: { changes: Number(execute().run(...values).changes) } };
        },
        async first<T>(): Promise<T | null> {
          const prepared = execute();
          if (db.missingRateRow && sql.includes("SELECT window_started_at")) return null;
          return (prepared.get(...values) as T | undefined) ?? null;
        },
        async all<T>(): Promise<D1Result<T>> { return { results: execute().all(...values) as T[] }; },
      };
    }
    return statement();
  }
  plan(sql: string, ...args: SQLInputValue[]): string {
    return this.sqlite.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map((row) => row.detail).join(" | ");
  }
}

class TestCache implements RankingCache {
  readonly values = new Map<string, Response>();
  failMatch = false;
  failPut = false;
  async match(request: Request): Promise<Response | undefined> {
    if (this.failMatch) throw new Error("cache match failed");
    return this.values.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    if (this.failPut) throw new Error("cache put failed");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
    this.values.set(request.url, response.clone());
  }
}

const visitorId = "11111111-1111-4111-8111-111111111111";
const resourceId = [...PUBLIC_RESOURCE_IDS][0]!;
const now = Date.UTC(2026, 9, 3, 12);
const date = "2026-10-03";
const rankingPath = "/v1/resources/ranking?period=7d&limit=6";
function req(path: string, body?: StatsEvent, origin = "https://rhythmarchive.github.io") {
  return new Request("https://stats.example.test" + path, {
    method: body ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function api(db: SqliteD1, request: Request, at = now, cache?: TestCache) {
  return handleRequest(request, { DB: db, SITE_TIME_ZONE: "UTC", ALLOWED_ORIGINS: "https://rhythmarchive.github.io,http://localhost:4321" }, {
    now: () => at, ...(cache ? { rankingCache: cache } : {}),
  });
}
async function seed(db: SqliteD1) {
  await new D1StatsStore(db).recordEvent({ type: "resource_detail", visitorId, resourceId }, now, date);
  db.queries.length = 0;
}

test("real SQLite dedupe expires exactly without Cron and preserves view/download windows", async () => {
  const db = new SqliteD1();
  const store = new D1StatsStore(db);
  const site: StatsEvent = { type: "site_visit", visitorId };
  assert.equal((await store.recordEvent(site, now, date)).siteVisitCounted, true);
  assert.equal((await store.recordEvent(site, now + 1_799_999, date)).siteVisitCounted, false);
  assert.equal((await store.recordEvent(site, now + 1_800_000, date)).siteVisitCounted, true);
  const detail: StatsEvent = { type: "resource_detail", visitorId, resourceId };
  const download: StatsEvent = { type: "resource_download", visitorId, resourceId };
  assert.equal((await store.recordEvent(detail, now, date)).viewCounted, true);
  assert.deepEqual((await store.recordEvent(download, now, date)).resource, { views: 1, downloads: 1 });
  assert.equal((await store.recordEvent(download, now + 9_999, date)).downloadCounted, false);
  assert.equal((await store.recordEvent(download, now + 10_000, date)).downloadCounted, true);
  const concurrent = await Promise.all([store.recordEvent(detail, now + 1_800_000, date), store.recordEvent(detail, now + 1_800_000, date)]);
  assert.equal(concurrent.filter((event) => event.viewCounted).length, 1);
  assert.deepEqual((await store.getResourceStats([resourceId])).get(resourceId), { views: 2, downloads: 2 });
  assert.equal(db.queries.some((sql) => /DELETE FROM event_dedupe/u.test(sql)), false);
  // Other expired keys remain for Cron rather than being removed by this request.
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM event_dedupe WHERE dedupe_kind='download'").get()!.n, 1);
  await store.cleanup(now + 1_800_001, date);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM event_dedupe WHERE dedupe_kind='download'").get()!.n, 0);
});

test("real D1 rate limits preserve scope, thresholds and exact window reset without hot cleanup", async () => {
  for (const [scope, window, max] of [["events", 60_000, 60], ["resource-stats", 60_000, 60], ["stats-read", 60_000, 120], ["update-reminders", 600_000, 20]] as const) {
    const db = new SqliteD1();
    const store = new D1StatsStore(db);
    for (let i = 0; i < max; i++) assert.equal((await store.consumeRequestRateLimit("ip", scope, now, window, max)).allowed, true);
    assert.deepEqual(await store.consumeRequestRateLimit("ip", scope, now + window - 1, window, max), { allowed: false, retryAfterSeconds: 1 });
    assert.equal((await store.consumeRequestRateLimit("ip", "other", now, window, max)).allowed, true);
    assert.equal((await store.consumeRequestRateLimit("ip", scope, now + window, window, max)).allowed, true);
    assert.equal(db.queries.some((sql) => /DELETE FROM request_rate_limits/u.test(sql)), false);
    assert.equal(db.queries.length, 2 * (max + 3));
  }
});

test("missing or failing durable rate state fails closed even with a cached ranking", async () => {
  const db = new SqliteD1();
  const cache = new TestCache();
  await seed(db);
  assert.equal((await api(db, req(rankingPath), now, cache)).status, 200);
  for (const mode of ["missing", "failure"]) {
    db.missingRateRow = mode === "missing";
    db.failRateRead = mode === "failure";
    assert.equal((await api(db, req(rankingPath), now, cache)).status, 503);
  }
});

test("real endpoint SQL counts fall without changing event counters", async () => {
  const db = new SqliteD1();
  async function event(type: StatsEvent["type"], expected: number, at = now) {
    db.queries.length = 0;
    const body: StatsEvent = type === "site_visit" ? { type, visitorId } : { type, visitorId, resourceId };
    assert.equal((await api(db, req("/v1/events", body), at)).status, 200);
    assert.equal(db.queries.length, expected, type);
    assert.equal(db.queries.some((sql) => sql.includes("DELETE")), false);
  }
  await event("site_visit", 7);
  await event("site_visit", 5);
  await event("resource_detail", 6);
  await event("resource_detail", 4);
  await event("resource_download", 7);
  await event("resource_download", 5);
  await event("resource_download", 9, now + 1_800_000);
});

test("ranking cache reuses data for 60s, separates date/period/limit and keeps per-request CORS", async () => {
  const db = new SqliteD1();
  const cache = new TestCache();
  await seed(db);
  const first = await api(db, req(rankingPath), now, cache);
  const payload = await first.json();
  assert.equal(db.queries.length, 3);
  db.queries.length = 0;
  const hit = await api(db, req("/v1/resources/ranking?limit=6&period=7d&ignored=value", undefined, "http://localhost:4321"), now + 1, cache);
  assert.deepEqual(await hit.json(), payload);
  assert.equal(hit.headers.get("Access-Control-Allow-Origin"), "http://localhost:4321");
  assert.equal(hit.headers.get("Cache-Control"), "no-store");
  assert.equal(db.queries.length, 2);
  db.sqlite.exec("UPDATE resource_daily_stats SET daily_views=20");
  assert.deepEqual(await (await api(db, req(rankingPath), now + RANKING_CACHE_TTL_MS - 1, cache)).json(), payload);
  const refreshed = await (await api(db, req(rankingPath), now + RANKING_CACHE_TTL_MS, cache)).json() as { entries: { views: number }[] };
  assert.equal(refreshed.entries[0]!.views, 20);
  for (const [path, at] of [["/v1/resources/ranking?period=all&limit=6", now], ["/v1/resources/ranking?period=7d&limit=30", now], [rankingPath, now + 86_400_000]] as const) {
    db.queries.length = 0;
    assert.equal((await api(db, req(path), at, cache)).status, 200);
    assert.equal(db.queries.length, 3);
  }
  assert.equal(cache.values.size, 4);
});

test("concurrent ranking misses share one aggregation; failures are never cached", async () => {
  const db = new SqliteD1();
  const cache = new TestCache();
  await seed(db);
  const responses = await Promise.all([api(db, req(rankingPath), now, cache), api(db, req(rankingPath), now, cache)]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(db.queries.filter((sql) => sql.includes("SUM(daily_views) AS total_views")).length, 1);
  assert.equal(db.queries.length, 5);
  cache.values.clear();
  db.failRanking = true;
  assert.equal((await api(db, req(rankingPath), now, cache)).status, 503);
  assert.equal(cache.values.size, 0);
  db.failRanking = false;
  assert.equal((await api(db, req(rankingPath), now, cache)).status, 200);
  for (const mode of ["match", "put", "invalid-data"]) {
    cache.values.clear();
    cache.failMatch = mode === "match";
    cache.failPut = mode === "put";
    if (mode === "invalid-data") {
      // Reuse a known key but corrupt its body.
      cache.failMatch = false; cache.failPut = false;
      await api(db, req(rankingPath), now, cache);
      const key = [...cache.values.keys()][0]!;
      cache.values.set(key, new Response("not JSON"));
    }
    db.queries.length = 0;
    assert.equal((await api(db, req(rankingPath), now, cache)).status, 200);
    assert.equal(db.queries.length, 3);
  }
});

test("cached rankings still enforce durable/native limits and origin validation", async () => {
  const db = new SqliteD1();
  const cache = new TestCache();
  await seed(db);
  for (let i = 0; i < 120; i++) assert.equal((await api(db, req(rankingPath), now, cache)).status, 200);
  db.queries.length = 0;
  assert.equal((await api(db, req(rankingPath), now, cache)).status, 429);
  assert.equal(db.queries.length, 2);
  for (const mode of ["reject", "throw"]) {
    db.queries.length = 0;
    const response = await handleRequest(req(rankingPath), { DB: db, RATE_LIMITER: { limit: async () => {
      if (mode === "throw") throw new Error("native unavailable");
      return { success: false };
    } } }, { rankingCache: cache, now: () => now });
    assert.equal(response.status, mode === "throw" ? 503 : 429);
    assert.equal(db.queries.length, 0);
  }
  db.queries.length = 0;
  assert.equal((await api(db, req(rankingPath, undefined, "https://evil.example"), now, cache)).status, 403);
  assert.equal(db.queries.length, 0);
});

test("scheduled rate cleanup is an indexed range and ranking date index is retained", async () => {
  const db = new SqliteD1();
  assert.match(db.plan("DELETE FROM request_rate_limits WHERE window_started_at + ? <= ?", 86_400_000, now), /SCAN request_rate_limits/u);
  await new D1StatsStore(db).cleanup(now, date);
  const cleanup = db.queries.find((sql) => sql.includes("DELETE FROM request_rate_limits"))!;
  assert.match(db.plan(cleanup, now - 86_400_000), /SEARCH request_rate_limits USING INDEX request_rate_limits_window_idx/u);
  assert.match(db.plan("SELECT window_started_at,request_count FROM request_rate_limits WHERE rate_key=? AND scope=?", "ip", "events"), /SEARCH request_rate_limits USING INDEX/u);
  db.queries.length = 0;
  await new D1StatsStore(db).getResourceRanking("7d", date, 6);
  assert.match(db.plan(db.queries[0]!, "2026-09-27", date, 6), /USING COVERING INDEX resource_daily_stats_date_rank_idx/u);
  db.sqlite.prepare("INSERT INTO request_rate_limits VALUES ('expired','events',?,1),('active','events',?,1)").run(now - 86_400_000, now);
  await new D1StatsStore(db).cleanup(now, date);
  assert.deepEqual(db.sqlite.prepare("SELECT rate_key FROM request_rate_limits").all().map((row) => row.rate_key), ["active"]);
});
