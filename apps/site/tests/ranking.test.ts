import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { mapResourceRankingEntries, RANKING_SHARD_COUNT, rankingShardKey } from "../src/lib/ranking.js";
import type { ResourceRankingEntry } from "../src/lib/stats-client.js";
import type { PublicRankingCard } from "../src/lib/types.js";

const siteRoot = path.resolve(process.cwd(), "apps", "site");

function card(resourceId: string, title = resourceId): PublicRankingCard {
  return {
    resourceId,
    route: "/r/" + resourceId + "/",
    game: "arcaea",
    resourceType: "jacket",
    displayTitle: title,
    categoryLabel: "曲绘",
    image: null,
    fallback: null,
  };
}

test("ranking mapping preserves API order and ignores stale public resource IDs", () => {
  const cards = [card("present-a", "A"), card("present-b", "B")];
  const entries: ResourceRankingEntry[] = [
    { resourceId: "stale-id", views: 99, downloads: 99 },
    { resourceId: "present-b", views: 8, downloads: 2 },
    { resourceId: "present-a", views: 7, downloads: 5 },
    { resourceId: "present-b", views: 1, downloads: 1 },
  ];
  assert.deepEqual(mapResourceRankingEntries(cards, entries).map((entry) => ({
    resourceId: entry.resourceId,
    views: entry.views,
    downloads: entry.downloads,
  })), [
    { resourceId: "present-b", views: 8, downloads: 2 },
    { resourceId: "present-a", views: 7, downloads: 5 },
  ]);
});

test("ranking page uses public card data while Stats Worker stays numeric-only", () => {
  const home = fs.readFileSync(path.join(siteRoot, "src", "pages", "index.astro"), "utf8");
  const component = fs.readFileSync(path.join(siteRoot, "src", "components", "ResourceRanking.astro"), "utf8");
  const script = fs.readFileSync(path.join(siteRoot, "src", "scripts", "ranking.ts"), "utf8");
  const stats = fs.readFileSync(path.join(siteRoot, "src", "lib", "stats-client.ts"), "utf8");
  const generator = fs.readFileSync(path.join(siteRoot, "scripts", "generate-public-data.ts"), "utf8");
  const sitemap = fs.readFileSync(path.join(siteRoot, "src", "pages", "sitemap.xml.ts"), "utf8");

  assert.ok(home.indexOf("<RecentUpdates />") < home.indexOf("<ResourceRanking"));
  assert.ok(home.indexOf("class=\"page-container home-games\"") < home.indexOf("<ResourceRanking"));
  assert.match(component, /data-ranking-shards-url/u);
  // Six home rows must not pull the whole search card projection.
  assert.doesNotMatch(component + script, /search-cards/u);
  assert.match(component, /data-ranking-period="7d"/u);
  assert.match(component, /data-ranking-period="all"/u);
  assert.match(script, /mapResourceRankingEntries/u);
  assert.match(script, /暂时不可用/u);
  assert.match(stats, /\/v1\/resources\/ranking/u);
  assert.match(generator, /rankingShardKey\(resource\.resourceId\)/u);
  assert.match(sitemap, /"\/ranking\/"/u);
});

test("ranking shards are stable, bounded and keyed by the random UUID tail", () => {
  const keys = new Set<string>();
  for (let index = 0; index < 512; index += 1) keys.add(rankingShardKey("01a00090-2a2d-70ad-8998-bf48655bc6" + index.toString(16).padStart(2, "0").slice(-2)));
  assert.equal(keys.size, RANKING_SHARD_COUNT);
  assert.ok([...keys].every((key) => /^[0-7][0-9a-f]$/u.test(key)));
  assert.equal(rankingShardKey("6e36bb71-31f4-776a-8f45-06742af78fa6"), rankingShardKey("6e36bb71-31f4-776a-8f45-06742af78fa6"));
  assert.equal(rankingShardKey("01a00090-2a2d-70ad-8998-bf48655bc6ff"), "7f");
});
