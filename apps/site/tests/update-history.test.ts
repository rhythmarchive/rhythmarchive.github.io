import assert from "node:assert/strict";
import test from "node:test";
import { findWorkspaceRoot, getSiteData } from "../src/lib/site-data";
import { loadRawUpdateHistory } from "../src/lib/update-history";

test("update history keeps explicit per-game baselines out of public records", () => {
  const raw = loadRawUpdateHistory(findWorkspaceRoot());
  assert.equal(raw.baselines.length, 7);
  assert.ok(raw.baselines.every((baseline) => baseline.game && baseline.releaseIds.length > 0));
  assert.ok(raw.records.every((record) => record.kind === "update"));
  assert.equal(new Set(raw.records.map((record) => record.id)).size, raw.records.length);
  const baselineIds = new Set(raw.baselines.map((baseline) => baseline.id));
  assert.ok(raw.records.every((record) => !baselineIds.has(record.id)));
  const paradigmRecords = raw.records.filter((record) => record.game === "paradigm-reboot");
  assert.equal(paradigmRecords.length, 2);
  assert.equal(paradigmRecords.find((record) => record.contentVersion === "4.11")?.items.length, 11);
  const paradigm412Record = paradigmRecords.find((record) => record.id === "72ff7c5a-72c0-706b-b4f6-1cedc1fd1bd6");
  assert.ok(paradigm412Record);
  assert.deepEqual(paradigm412Record.releaseIds, ["403073df-99ca-7c80-8fba-1816c143dea8"]);
  assert.equal(paradigm412Record.publishedAt, "2026-10-01T12:43:19.103Z");
  assert.deepEqual(paradigm412Record.items.map((item) => item.resourceId), [
    "4d546982-7a98-7e83-b2c4-bc06fb9713a4",
    "4008f590-98bb-71ae-b9b2-aef2ca0424af",
    "9f4c3c2d-e306-79d0-8bfe-4490cc915ae8",
    "3679cd79-e9b9-70c1-b4f7-d938d8f5fe65",
  ]);
  assert.ok(raw.baselines.some((baseline) => baseline.game === "orzmic" && baseline.contentVersion === "3.17.0"));
  assert.equal(raw.records.filter((record) => record.game === "orzmic").length, 0);
});

test("public updates are sorted, deduplicated and limited to current public resources", () => {
  const data = getSiteData();
  assert.ok(data.updates.length > 0);
  assert.equal(data.updates.find((update) => update.game === "paradigm-reboot")?.items.length, 4);
  assert.equal(data.updates.find((update) => update.game === "paradigm-reboot" && update.contentVersion === "4.11")?.items.length, 11);
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
