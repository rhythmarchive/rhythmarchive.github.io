import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { D1StatsStore, handleRequest, processPendingUpdateReminderNotifications, UPDATE_REMINDER_DAILY_EMAIL_LIMIT, type D1Database, type D1PreparedStatement, type D1Result, type StatsEvent } from "../src/core.js";
import { RANKING_CACHE_TTL_MS, type RankingCache } from "../src/ranking-cache.js";
import { PUBLIC_RESOURCE_IDS } from "../src/public-resource-registry.js";

class SqliteD1 implements D1Database {
  // Existing D1 migrations use SQLite's legacy double-quoted string literals.
  readonly sqlite = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });
  readonly queries: string[] = [];
  missingRateRow = false;
  failRateRead = false;
  failRanking = false;
  constructor(through = "9999") {
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name.slice(0, 4) <= through).sort()) {
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
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
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


const emailConfig = { RESEND_API_KEY: "test-key", UPDATE_REMINDER_EMAIL_TO: "owner", TURNSTILE_REQUIRED: "false" };
function reminderRequest(visitor: string) {
  return new Request("https://stats.example.test/v1/update-reminders", {
    method: "POST", headers: { Origin: "https://rhythmarchive.github.io", "Content-Type": "application/json" },
    body: JSON.stringify({ visitorId: visitor, game: "arcaea" }),
  });
}

test("real D1 sends each counted reminder and atomically deduplicates concurrent visitors", async () => {
  const db = new SqliteD1();
  const store = new D1StatsStore(db);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 204 }); };
  const env = { DB: db, ...emailConfig };
  assert.equal((await handleRequest(reminderRequest(visitorId), env, { now: () => now, fetchImpl })).status, 202);
  assert.equal((await handleRequest(reminderRequest(crypto.randomUUID()), env, { now: () => now + 1, fetchImpl })).status, 202);
  assert.equal((await handleRequest(reminderRequest(visitorId), env, { now: () => now + 2, fetchImpl })).status, 409);
  assert.equal(calls, 2);
  const concurrentVisitor = crypto.randomUUID();
  const results = await Promise.all([store.recordUpdateReminder(concurrentVisitor, "arcaea", now + 3), store.recordUpdateReminder(concurrentVisitor, "arcaea", now + 3)]);
  assert.deepEqual(results.map(r => r.status).sort(), ["accepted", "duplicate"]);
  assert.equal((await store.listPendingUpdateReminders())[0]!.cycleEffectiveReminderCount, 3);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM update_reminder_notifications").get()!.n, 3);
  const limited = await handleRequest(reminderRequest(crypto.randomUUID()), { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } }, { now: () => now + 4, fetchImpl });
  assert.equal(limited.status, 429);
  assert.equal(calls, 2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM update_reminder_notifications").get()!.n, 3);
});

test("D1 daily budget is shared, atomic, conservative, and resets at UTC midnight", async () => {
  const db = new SqliteD1();
  const stores = [new D1StatsStore(db), new D1StatsStore(db)];
  const results = await Promise.all(Array.from({ length: 120 }, (_, i) => stores[i % 2]!.consumeUpdateReminderEmailBudget(now)));
  assert.equal(results.filter(Boolean).length, UPDATE_REMINDER_DAILY_EMAIL_LIMIT);
  assert.equal(await stores[0]!.consumeUpdateReminderEmailBudget(Date.UTC(2026, 9, 3, 23, 59, 59)), false);
  assert.equal(await stores[1]!.consumeUpdateReminderEmailBudget(Date.UTC(2026, 9, 4)), true);
});

test("81st reminder stays counted but is never sent or replayed tomorrow", async () => {
  const db = new SqliteD1();
  const store = new D1StatsStore(db);
  const env = { DB: db, ...emailConfig };
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 204 }); };
  for (let i = 0; i < 80; i++) {
    await store.recordUpdateReminder(crypto.randomUUID(), "arcaea", now + i);
    await processPendingUpdateReminderNotifications(env, { store, now: now + i, fetchImpl });
  }
  const capped = await handleRequest(reminderRequest(crypto.randomUUID()), env, { store, now: () => now + 80, fetchImpl });
  assert.equal(capped.status, 202);
  assert.equal(calls, 80);
  const summary = (await store.listPendingUpdateReminders())[0]!;
  assert.equal(summary.cycleEffectiveReminderCount, 81);
  assert.equal(summary.lastNotificationError, "daily_limit_reached");
  assert.equal(summary.nextNotificationAt, null);
  await store.retryUpdateReminderNotification("arcaea", now + 86_400_000);
  await processPendingUpdateReminderNotifications(env, { store, now: now + 86_400_000, fetchImpl });
  assert.equal(calls, 80);
  await store.recordUpdateReminder(crypto.randomUUID(), "arcaea", now + 86_400_001);
  await processPendingUpdateReminderNotifications(env, { store, now: now + 86_400_001, fetchImpl });
  assert.equal(calls, 81);
  assert.equal((await store.listPendingUpdateReminders())[0]!.cycleEffectiveReminderCount, 82);
});

test("each failed email retries independently with stable Resend payload and key", async () => {
  const db = new SqliteD1();
  const store = new D1StatsStore(db);
  const env = { DB: db, ...emailConfig };
  const calls: { body: string; key: string | null }[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: String(init?.body), key: new Headers(init?.headers).get("Idempotency-Key") });
    return new Response(null, { status: calls.length === 1 ? 503 : 204 });
  };
  await store.recordUpdateReminder(visitorId, "arcaea", now);
  await processPendingUpdateReminderNotifications(env, { store, now, fetchImpl });
  await store.recordUpdateReminder(crypto.randomUUID(), "arcaea", now + 1000);
  await processPendingUpdateReminderNotifications(env, { store, now: now + 1000, fetchImpl });
  await processPendingUpdateReminderNotifications(env, { store, now: now + 300_000, fetchImpl });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[2]);
  assert.notEqual(calls[0]!.key, calls[1]!.key);
  assert.equal(db.sqlite.prepare("SELECT attempts FROM update_reminder_email_daily WHERE send_date = ?").get(date)!.attempts, 3);
  const summary = (await store.listPendingUpdateReminders())[0]!;
  assert.equal(summary.notificationStatus, "sent");
  assert.equal(summary.notificationAttempts, 1);
  assert.equal(summary.lastNotificationError, null);
});

test("budget storage failure keeps the reminder accepted and sends no email", async () => {
  const db = new SqliteD1();
  const store = new D1StatsStore(db);
  store.consumeUpdateReminderEmailBudget = async () => { throw new Error("budget unavailable"); };
  let calls = 0;
  const result = await handleRequest(reminderRequest(visitorId), { DB: db, ...emailConfig }, {
    store, now: () => now, fetchImpl: async () => { calls++; return new Response(null, { status: 204 }); },
  });
  assert.equal(result.status, 202);
  assert.equal(calls, 0);
  assert.equal((await store.listPendingUpdateReminders())[0]!.effectiveReminderCount, 1);
});

test("migration preserves legacy history without replaying sent cycles", () => {
  const db = new SqliteD1("0005");
  db.sqlite.exec(`INSERT INTO update_reminder_cycles
    (game, cycle_number, first_reminded_at, last_reminded_at, effective_reminder_count, notification_status, notification_attempts)
    VALUES ('arcaea', 1, 1, 2, 22, 'sent', 1), ('phigros', 1, 1, 2, 3, 'failed', 2)`);
  db.sqlite.exec(readFileSync(new URL("../migrations/0006_update_reminder_emails.sql", import.meta.url), "utf8"));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM update_reminder_cycles").get()!.n, 2);
  assert.deepEqual({ ...db.sqlite.prepare("SELECT id, reminder_count, notification_status, notification_attempts FROM update_reminder_notifications").get()! },
    { id: "legacy-2", reminder_count: 3, notification_status: "failed", notification_attempts: 2 });
});
