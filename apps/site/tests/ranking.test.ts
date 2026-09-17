import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { mapResourceRankingEntries } from "../src/lib/ranking.js";
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
  assert.ok(home.indexOf("<ResourceRanking") < home.indexOf("class=\"page-container home-games\""));
  assert.match(component, /data-ranking-cards-url/u);
  assert.match(component, /data-ranking-period="7d"/u);
  assert.match(component, /data-ranking-period="all"/u);
  assert.match(script, /mapResourceRankingEntries/u);
  assert.match(script, /暂时不可用/u);
  assert.match(stats, /\/v1\/resources\/ranking/u);
  assert.match(generator, /ranking-cards\.json/u);
  assert.match(sitemap, /"\/ranking\/"/u);
});