import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  STATS_BATCH_SIZE,
  STATS_VISITOR_STORAGE_KEY,
  chunkResourceIds,
  createStatsClient,
  formatStatsCount,
  isValidResourceId,
  isValidVisitorId,
  normalizeStatsApiUrl,
} from "../src/lib/stats-client.js";

const visitorId = "11111111-1111-4111-8111-111111111111";
const resourceId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const secondResourceId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const siteRoot = path.resolve(process.cwd(), "apps", "site");

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("stats API config and batch helpers stay bounded", () => {
  assert.equal(normalizeStatsApiUrl(undefined), undefined);
  assert.equal(normalizeStatsApiUrl(""), undefined);
  assert.equal(normalizeStatsApiUrl("https://stats.example.test///"), "https://stats.example.test");
  assert.equal(normalizeStatsApiUrl("javascript:alert(1)"), undefined);
  assert.equal(formatStatsCount(3626), "3,626");
  assert.equal(isValidResourceId(resourceId), true);
  assert.equal(isValidResourceId("not-a-resource"), false);
  const ids = Array.from({ length: STATS_BATCH_SIZE }, (_, index) => String(index).padStart(8, "0") + "-1111-7111-8111-111111111111");
  assert.deepEqual(chunkResourceIds([resourceId, resourceId, ...ids]), [[resourceId, ...ids.slice(0, STATS_BATCH_SIZE - 1)], [ids.at(-1)]]);
});

test("browser default crypto.randomUUID creates a UUIDv4 visitor and tracks a site visit", async () => {
  const storage = new MemoryStorage();
  const eventCalls: Record<string, string>[] = [];
  const client = createStatsClient({
    apiUrl: "https://stats.example.test",
    storage,
    fetchImpl: async (_input, init) => {
      eventCalls.push(JSON.parse(String(init?.body)) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true, site: { totalVisits: 1, todayVisits: 1 } }), { status: 200 });
    },
  });

  assert.equal(typeof globalThis.crypto?.randomUUID, "function");
  assert.deepEqual(await client.trackSiteVisit(), { totalVisits: 1, todayVisits: 1 });
  const generated = storage.getItem(STATS_VISITOR_STORAGE_KEY);
  assert.ok(generated);
  assert.equal(isValidVisitorId(generated), true);
  assert.equal(generated[14], "4");
  assert.ok("89ab".includes(generated[19]!));
  assert.deepEqual(eventCalls, [{ type: "site_visit", visitorId: generated }]);
});

test("an existing UUIDv4 visitor in localStorage is reused without regeneration", () => {
  const storage = new MemoryStorage();
  storage.setItem(STATS_VISITOR_STORAGE_KEY, visitorId);
  let factoryCalls = 0;
  const client = createStatsClient({
    storage,
    visitorIdFactory: () => {
      factoryCalls += 1;
      return "not-a-uuid";
    },
  });

  assert.equal(client.getVisitorId(), visitorId);
  assert.equal(factoryCalls, 0);
});
test("configured client persists one random visitor ID and reads resource stats in shared batches", async () => {
  const storage = new MemoryStorage();
  const batchCalls: string[][] = [];
  const eventCalls: Record<string, string>[] = [];
  const client = createStatsClient({
    apiUrl: "https://stats.example.test///",
    storage,
    visitorIdFactory: () => visitorId,
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/v1/resources/stats")) {
        const ids = body.resourceIds as string[];
        batchCalls.push(ids);
        return new Response(JSON.stringify({ stats: Object.fromEntries(ids.map((id) => [id, { views: id === resourceId ? 12 : 0, downloads: 3 }])) }), { status: 200 });
      }
      eventCalls.push(body as Record<string, string>);
      return new Response(JSON.stringify({ ok: true, site: { totalVisits: 18524, todayVisits: 23 }, resource: { views: 12, downloads: 4 } }), { status: 200 });
    },
  });

  assert.equal(client.enabled, true);
  assert.deepEqual(await client.trackSiteVisit(), { totalVisits: 18524, todayVisits: 23 });
  assert.equal(storage.getItem(STATS_VISITOR_STORAGE_KEY), visitorId);
  assert.deepEqual(await client.getResourceStats([resourceId, secondResourceId, resourceId]), new Map([
    [resourceId, { views: 12, downloads: 3 }],
    [secondResourceId, { views: 0, downloads: 3 }],
  ]));
  assert.deepEqual(await client.getResourceStats([resourceId, secondResourceId]), new Map([
    [resourceId, { views: 12, downloads: 3 }],
    [secondResourceId, { views: 0, downloads: 3 }],
  ]));
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(await client.trackResourceDetail(resourceId), { views: 12, downloads: 4 });
  assert.deepEqual(await client.trackResourceDownload(secondResourceId), { views: 12, downloads: 4 });
  assert.deepEqual(eventCalls, [
    { type: "site_visit", visitorId },
    { type: "resource_detail", resourceId, visitorId },
    { type: "resource_download", resourceId: secondResourceId, visitorId },
  ]);
});

test("visitor IDs accept UUIDv4 while resource IDs still require UUIDv7", async () => {
  assert.equal(isValidVisitorId(visitorId), true);
  assert.equal(isValidVisitorId("not-a-uuid"), false);
  assert.equal(isValidResourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), false);

  const storage = new MemoryStorage();
  storage.setItem(STATS_VISITOR_STORAGE_KEY, "not-a-uuid");
  let fetchCalls = 0;
  const client = createStatsClient({
    apiUrl: "https://stats.example.test",
    storage,
    visitorIdFactory: () => "still-not-a-uuid",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("", { status: 500 });
    },
  });

  assert.equal(await client.trackSiteVisit(), undefined);
  assert.equal(await client.trackResourceDetail(resourceId), undefined);
  assert.equal(fetchCalls, 0);
});
test("configured client reads and caches bounded resource rankings", async () => {
  const calls: string[] = [];
  const client = createStatsClient({
    apiUrl: "https://stats.example.test",
    storage: new MemoryStorage(),
    visitorIdFactory: () => visitorId,
    fetchImpl: async (input, init) => {
      calls.push(String(input) + " " + String(init?.method));
      return new Response(JSON.stringify({
        period: "7d",
        date: "2026-09-06",
        startDate: "2026-08-31",
        entries: [
          { resourceId, views: 12, downloads: 3 },
          { resourceId: secondResourceId, views: 4, downloads: 1 },
        ],
      }), { status: 200 });
    },
  });

  assert.deepEqual(await client.getResourceRanking("7d", 6), {
    period: "7d",
    date: "2026-09-06",
    startDate: "2026-08-31",
    entries: [
      { resourceId, views: 12, downloads: 3 },
      { resourceId: secondResourceId, views: 4, downloads: 1 },
    ],
  });
  assert.deepEqual(await client.getResourceRanking("7d", 6), {
    period: "7d",
    date: "2026-09-06",
    startDate: "2026-08-31",
    entries: [
      { resourceId, views: 12, downloads: 3 },
      { resourceId: secondResourceId, views: 4, downloads: 1 },
    ],
  });
  assert.deepEqual(calls, ["https://stats.example.test/v1/resources/ranking?period=7d&limit=6 GET"]);
});
test("missing or unavailable stats API never blocks site behavior", async () => {
  let fetchCalls = 0;
  const disabled = createStatsClient({ storage: new MemoryStorage(), fetchImpl: async () => { fetchCalls += 1; return new Response("", { status: 500 }); } });
  assert.equal(disabled.enabled, false);
  assert.equal(await disabled.trackSiteVisit(), undefined);
  assert.equal(await disabled.trackResourceDetail(resourceId), undefined);
  assert.equal((await disabled.getResourceStats([resourceId])).size, 0);

  const unavailable = createStatsClient({
    apiUrl: "https://stats.example.test",
    storage: new MemoryStorage(),
    visitorIdFactory: () => visitorId,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(await unavailable.trackSiteVisit(), undefined);
  assert.equal((await unavailable.getResourceStats([resourceId])).size, 0);
  assert.equal(fetchCalls, 0);
});

test("site wiring keeps the original data fallback and only marks real resource actions", () => {
  const page = fs.readFileSync(path.join(siteRoot, "src", "pages", "index.astro"), "utf8");
  const detail = fs.readFileSync(path.join(siteRoot, "src", "pages", "r", "[id]", "index.astro"), "utf8");
  const detailScript = fs.readFileSync(path.join(siteRoot, "src", "scripts", "detail.ts"), "utf8");
  const gallery = fs.readFileSync(path.join(siteRoot, "src", "scripts", "gallery.ts"), "utf8");
  const browse = fs.readFileSync(path.join(siteRoot, "src", "scripts", "browse-gallery.ts"), "utf8");
  const download = fs.readFileSync(path.join(siteRoot, "src", "scripts", "download.ts"), "utf8");
  const stats = fs.readFileSync(path.join(siteRoot, "src", "scripts", "stats.ts"), "utf8");
  assert.match(page, /formatCount\(games\.length\)/u);
  assert.match(page, /formatCount\(resourceCount\)/u);
  assert.match(page, /data-site-stats/u);
  assert.match(detail, /data-resource-id=\{resource\.resourceId\}/u);
  assert.match(detailScript, /trackResourceDetail/u);
  assert.match(gallery, /updateResourceStatsInDom\(grid!/u);
  assert.match(browse, /updateResourceStatsInDom\(grid!/u);
  assert.match(download, /trackResourceDownload/u);
  assert.match(stats, /data-stats-download/u);
  assert.doesNotMatch(gallery, /IntersectionObserver/u);
  assert.doesNotMatch(browse, /IntersectionObserver/u);
});
