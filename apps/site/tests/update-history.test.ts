import assert from "node:assert/strict";
import test from "node:test";
import { findWorkspaceRoot, getSiteData } from "../src/lib/site-data";
import { loadRawUpdateHistory } from "../src/lib/update-history";

test("update history keeps explicit per-game baselines out of public records", () => {
  const raw = loadRawUpdateHistory(findWorkspaceRoot());
  assert.equal(raw.baselines.length, 6);
  assert.ok(raw.baselines.every((baseline) => baseline.game && baseline.releaseIds.length > 0));
  assert.ok(raw.records.every((record) => record.kind === "update"));
  assert.equal(new Set(raw.records.map((record) => record.id)).size, raw.records.length);
  const baselineIds = new Set(raw.baselines.map((baseline) => baseline.id));
  assert.ok(raw.records.every((record) => !baselineIds.has(record.id)));
  assert.ok(raw.records.every((record) => record.game !== "paradigm-reboot"));
});

test("public updates are sorted, deduplicated and limited to current public resources", () => {
  const data = getSiteData();
  assert.ok(data.updates.length > 0);
  assert.ok(data.updates.every((update) => update.game !== "paradigm-reboot"));
  for (let index = 1; index < data.updates.length; index += 1) {
    assert.ok(Date.parse(data.updates[index - 1]!.publishedAt) >= Date.parse(data.updates[index]!.publishedAt));
  }
  const publicIds = new Set(data.resources.map((resource) => resource.resourceId));
  for (const update of data.updates) {
    assert.equal(new Set(update.items.map((item) => item.resourceId)).size, update.items.length);
    assert.equal(update.availableItemCount, update.items.length);
    assert.equal(update.summary.count, update.items.length);
    assert.ok(update.items.every((item) => item.game === update.game && publicIds.has(item.resourceId)));
    assert.ok(!("releaseIds" in update));
    assert.ok(!("sourcePath" in update.items[0]!));
  }
});

test("public update projection omits Rizline internal resource versions", () => {
  const root = findWorkspaceRoot();
  const raw = loadRawUpdateHistory(root);
  const internalRecord = raw.records.find((record) => record.game === "rizline" && record.contentVersion === "v141_2_7_1_3c13bbff2bP");
  assert.ok(internalRecord);
  const publicUpdate = getSiteData().updates.find((update) => update.id === internalRecord.id);
  assert.ok(publicUpdate);
  assert.equal(publicUpdate.contentVersion, undefined);
});
