import assert from "node:assert/strict";
import test from "node:test";
import {
  DOWNLOAD_DEDUPE_WINDOW_MS,
  MAX_RESOURCE_IDS,
  SITE_SESSION_WINDOW_MS,
  type Env,
  type ResourceStats,
  type SiteStats,
  type StatsEvent,
  type StatsStore,
  handleRequest,
  isValidResourceId,
} from "../src/core.js";

const visitorId = "11111111-1111-7111-8111-111111111111";
const otherVisitorId = "22222222-2222-7222-8222-222222222222";
const resourceId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const secondResourceId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const baseTime = Date.UTC(2026, 8, 6, 12, 0, 0);

class MemoryStatsStore implements StatsStore {
  private totalVisits = 0;
  private readonly dailyVisits = new Map<string, number>();
  private readonly resources = new Map<string, ResourceStats>();
  private readonly dedupe = new Map<string, number>();

  async recordEvent(event: StatsEvent, nowMs: number, date: string) {
    this.purge(nowMs);
    if (event.type === "site_visit") {
      const counted = this.claim(event.visitorId, "site", "", nowMs + SITE_SESSION_WINDOW_MS);
      if (counted) {
        this.totalVisits += 1;
        this.dailyVisits.set(date, (this.dailyVisits.get(date) ?? 0) + 1);
      }
      return {
        siteVisitCounted: counted,
        viewCounted: false,
        downloadCounted: false,
        site: await this.getSiteStats(date),
      };
    }

    const viewCounted = this.claim(event.visitorId, "view", event.resourceId, nowMs + SITE_SESSION_WINDOW_MS);
    if (viewCounted) this.increment(event.resourceId, "views");
    let downloadCounted = false;
    if (event.type === "resource_download") {
      downloadCounted = this.claim(event.visitorId, "download", event.resourceId, nowMs + DOWNLOAD_DEDUPE_WINDOW_MS);
      if (downloadCounted) this.increment(event.resourceId, "downloads");
    }
    const resource = (await this.getResourceStats([event.resourceId])).get(event.resourceId) ?? { views: 0, downloads: 0 };
    return {
      siteVisitCounted: false,
      viewCounted,
      downloadCounted,
      resource,
    };
  }

  async getSiteStats(date: string): Promise<SiteStats> {
    return { totalVisits: this.totalVisits, todayVisits: this.dailyVisits.get(date) ?? 0, date };
  }

  async getResourceStats(ids: readonly string[]): Promise<Map<string, ResourceStats>> {
    return new Map(ids.map((id) => [id, this.resources.get(id) ?? { views: 0, downloads: 0 }]));
  }

  private claim(visitor: string, kind: string, id: string, expiresAt: number): boolean {
    const key = `${visitor}:${kind}:${id}`;
    if (this.dedupe.has(key)) return false;
    this.dedupe.set(key, expiresAt);
    return true;
  }

  private increment(id: string, field: keyof ResourceStats): void {
    const current = this.resources.get(id) ?? { views: 0, downloads: 0 };
    current[field] += 1;
    this.resources.set(id, current);
  }

  private purge(nowMs: number): void {
    for (const [key, expiresAt] of this.dedupe) if (expiresAt <= nowMs) this.dedupe.delete(key);
  }
}

function makeEnv(store: StatsStore): Env & { store: StatsStore } {
  return { ALLOWED_ORIGINS: "https://rhythmarchive.github.io,http://localhost:4321", SITE_TIME_ZONE: "UTC", store };
}

function request(path: string, method: "GET" | "POST" | "OPTIONS", body?: unknown, origin = "https://rhythmarchive.github.io"): Request {
  return new Request(`https://stats.example.test${path}`, {
    method,
    headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function postEvent(store: StatsStore, event: StatsEvent, nowMs: number): Promise<Record<string, any>> {
  return responseJson(await handleRequest(request("/v1/events", "POST", event), makeEnv(store), { store, now: () => nowMs }));
}

test("site visits are deduplicated for 30 minutes and counted again after the window", async () => {
  const store = new MemoryStatsStore();
  const first = await postEvent(store, { type: "site_visit", visitorId }, baseTime);
  const repeated = await postEvent(store, { type: "site_visit", visitorId }, baseTime + SITE_SESSION_WINDOW_MS - 1);
  const nextSession = await postEvent(store, { type: "site_visit", visitorId }, baseTime + SITE_SESSION_WINDOW_MS);

  assert.equal(first.counted.siteVisit, true);
  assert.equal(first.site.totalVisits, 1);
  assert.equal(repeated.counted.siteVisit, false);
  assert.equal(repeated.site.totalVisits, 1);
  assert.equal(nextSession.counted.siteVisit, true);
  assert.equal(nextSession.site.totalVisits, 2);
});

test("detail and subsequent download share one resource view window", async () => {
  const store = new MemoryStatsStore();
  const detail = await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime);
  const download = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + 1_000);
  const repeatedDownload = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + 2_000);

  assert.deepEqual(detail.counted, { siteVisit: false, view: true, download: false });
  assert.deepEqual(download.counted, { siteVisit: false, view: false, download: true });
  assert.deepEqual(repeatedDownload.counted, { siteVisit: false, view: false, download: false });
  assert.deepEqual(download.resource, { resourceId, views: 1, downloads: 1 });
});

test("direct download counts one view and one download", async () => {
  const store = new MemoryStatsStore();
  const first = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime);
  const repeated = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + DOWNLOAD_DEDUPE_WINDOW_MS - 1);
  const laterDownload = await postEvent(store, { type: "resource_download", visitorId, resourceId }, baseTime + DOWNLOAD_DEDUPE_WINDOW_MS);
  const newViewWindow = await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime + SITE_SESSION_WINDOW_MS);

  assert.deepEqual(first.counted, { siteVisit: false, view: true, download: true });
  assert.deepEqual(repeated.counted, { siteVisit: false, view: false, download: false });
  assert.deepEqual(laterDownload.counted, { siteVisit: false, view: false, download: true });
  assert.equal(newViewWindow.counted.view, true);
  assert.deepEqual(newViewWindow.resource, { resourceId, views: 2, downloads: 2 });
});

test("batch stats reads do not create views and return all requested IDs", async () => {
  const store = new MemoryStatsStore();
  await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime);
  const response = await handleRequest(request("/v1/resources/stats", "POST", { resourceIds: [resourceId, secondResourceId, resourceId] }), makeEnv(store), { store, now: () => baseTime + 1_000 });
  const payload = await responseJson(response);

  assert.equal(response.status, 200);
  assert.deepEqual(payload.stats, {
    [resourceId]: { views: 1, downloads: 0 },
    [secondResourceId]: { views: 0, downloads: 0 },
  });
  const afterRead = await postEvent(store, { type: "resource_detail", visitorId, resourceId }, baseTime + 2_000);
  assert.equal(afterRead.counted.view, false);
});

test("invalid resource IDs and oversized batches are rejected", async () => {
  const store = new MemoryStatsStore();
  const invalidEvent = await handleRequest(request("/v1/events", "POST", { type: "resource_detail", visitorId, resourceId: "not-a-resource" }), makeEnv(store), { store, now: () => baseTime });
  const invalidBatch = await handleRequest(request("/v1/resources/stats", "POST", { resourceIds: ["not-a-resource"] }), makeEnv(store), { store, now: () => baseTime });
  const tooLarge = await handleRequest(request("/v1/resources/stats", "POST", { resourceIds: Array.from({ length: MAX_RESOURCE_IDS + 1 }, (_, index) => `${String(index).padStart(8, "0")}-1111-7111-8111-111111111111`) }), makeEnv(store), { store, now: () => baseTime });

  assert.equal(invalidEvent.status, 400);
  assert.equal((await responseJson(invalidEvent)).error, "invalid_resource_id");
  assert.equal(invalidBatch.status, 400);
  assert.equal((await responseJson(invalidBatch)).error, "invalid_resource_id");
  assert.equal(tooLarge.status, 400);
  assert.equal((await responseJson(tooLarge)).error, "resource_id_batch_too_large");
  assert.equal(isValidResourceId(resourceId), true);
  assert.equal(isValidResourceId("/r/not-a-resource/"), false);
});

test("CORS only exposes configured origins", async () => {
  const store = new MemoryStatsStore();
  const allowed = await handleRequest(request("/health", "GET"), makeEnv(store));
  const preflight = await handleRequest(request("/v1/events", "OPTIONS"), makeEnv(store), { store });
  const rejected = await handleRequest(request("/health", "GET", undefined, "https://evil.example.test"), makeEnv(store));

  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://rhythmarchive.github.io");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://rhythmarchive.github.io");
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
});

test("D1 unavailability returns a non-blocking service error", async () => {
  const response = await handleRequest(request("/v1/site/stats", "GET"), { ALLOWED_ORIGINS: "https://rhythmarchive.github.io" });
  assert.equal(response.status, 503);
  assert.equal((await responseJson(response)).error, "stats_unavailable");
});
