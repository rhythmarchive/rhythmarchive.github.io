import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadFormalCatalog, getSiteData } from "../src/lib/site-data.js";
import { rankSearchEntries } from "../src/lib/search.js";
import { buildSearchQuickLinks } from "../src/lib/search-quick-links.js";
import type { PublicSearchEntry } from "../src/lib/types.js";

test("Catalog cache reuses a validated snapshot and rejects edited invalid data", () => {
  const originalCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhythm-catalog-cache-"));
  const catalogPath = path.join(root, "catalog", "index.json");
  fs.mkdirSync(path.dirname(catalogPath));
  const value = { catalogSchemaVersion: "1.0", catalogId: "019f0000-0000-7000-8000-000000000001", generatedAt: "2026-10-01T00:00:00Z", resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] };
  const read = fs.readFileSync;
  let reads = 0;
  try {
    process.chdir(root);
    fs.writeFileSync(catalogPath, JSON.stringify(value));
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === catalogPath) reads++;
      return (read as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof read;
    const first = loadFormalCatalog();
    assert.equal(loadFormalCatalog(), first);
    assert.equal(reads, 1);
    fs.writeFileSync(catalogPath, JSON.stringify({ ...value, generatedAt: "2026-10-02T00:00:00Z" }));
    fs.utimesSync(catalogPath, new Date(), new Date(Date.now() + 1000));
    assert.equal(loadFormalCatalog().generatedAt, "2026-10-02T00:00:00Z");
    assert.equal(reads, 2);
    fs.writeFileSync(catalogPath, "{}");
    assert.throws(() => loadFormalCatalog(), /failed runtime validation/);
  } finally {
    fs.readFileSync = read;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search understands game names, aliases and category scopes", () => {
  const entry = (resourceId: string, game: PublicSearchEntry["game"], category = "jacket"): PublicSearchEntry => ({ resourceId, route: `/r/${resourceId}/`, title: "Sky", game, category, categoryLabel: category === "jacket" ? "曲绘" : "头像", keywords: [] });
  const entries = [entry("a", "arcaea"), entry("b", "arcaea", "character-avatar"), entry("c", "phigros"), entry("d", "paradigm-reboot")];
  assert.deepEqual(rankSearchEntries(entries, "Arcaea 曲绘").map((r) => r.resourceId), ["a"]);
  assert.equal(rankSearchEntries(entries, "韵律源点").length, 2);
  assert.deepEqual(rankSearchEntries(entries, "Paradigm Reboot").map((r) => r.resourceId), ["d"]);
  assert.deepEqual(rankSearchEntries(entries, "", { game: "phigros", category: "jacket" }).map((r) => r.resourceId), ["c"]);
  assert.equal(rankSearchEntries(entries, "", { game: "arcaea", category: "startup" }).length, 0);
});

test("site versions follow adopted sources and quick-link counts follow destinations", () => {
  const data = getSiteData();
  const manifest = JSON.parse(fs.readFileSync("catalog/browse/manifest.json", "utf8"));
  assert.equal(data.games.find((game) => game.slug === "arcaea")?.contentVersion, manifest.games.arcaea.sourceVersion);
  const link = buildSearchQuickLinks(data).find((entry) => entry.href === "/arcaea/jacket/");
  assert.equal(link?.count, data.games.find((game) => game.slug === "arcaea")?.categories.find((category) => category.slug === "jacket")?.count);
});
