import assert from "node:assert/strict";
import test from "node:test";
import { sortResourcesByViews } from "../src/lib/resource-views-sort";
import { parseBrowseUrlState, serializeBrowseUrlState } from "../src/lib/browse-gallery";

test("views sort orders the whole result set, keeps ties stable and preserves the source", async () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const result = await sortResourcesByViews(items, (item) => item.id, {
    async getResourceStats(ids) {
      assert.deepEqual(ids, ["a", "b", "c", "d"]);
      return new Map([["a", { views: 0, downloads: 100 }], ["b", { views: 12, downloads: 0 }], ["c", { views: 12, downloads: 50 }], ["d", { views: 30, downloads: 0 }]]);
    },
  });
  assert.deepEqual(result.map((item) => item.id), ["d", "b", "c", "a"]);
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c", "d"]);
});

test("missing counts report failure instead of being treated as zero", async () => {
  await assert.rejects(sortResourcesByViews(["a", "b"], (id) => id, {
    async getResourceStats() { return new Map([["a", { views: 1, downloads: 0 }]]); },
  }), /unavailable/);
});

test("every Browse game restores views sorting from its URL", () => {
  for (const game of ["arcaea", "phigros", "rizline", "infalsus"] as const) {
    const state = parseBrowseUrlState(game, "sort=views-desc", []);
    assert.equal(state.sort, "views-desc");
    assert.equal(serializeBrowseUrlState(state).get("sort"), "views-desc");
  }
});
