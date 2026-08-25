import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyCatalog } from "../src/catalog.js";
import { buildReleaseDelta, manifestFromCatalog, readUnifiedManifest, writeUnifiedManifest, UnifiedAssetManifest } from "../src/release.js";
import { manifestFromExternalManifest } from "../src/external-manifest.js";
import { approveReviewPackage, buildReviewPackage, isReviewApproved, validateReviewPackageForDelta } from "../src/review-package.js";
import { buildStorageDiff } from "../src/storage-diff.js";
import { AssetRecord, GameRecord, getGameAdapter, getGameProfile, gameRecordsFromCatalog } from "../src/platform.js";
import { createWorkflowState, loadWorkflowState, saveWorkflowState, updateWorkflowState, workflowRoot } from "../src/workflow-state.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function entry(input: { identityKey: string; title: string; hash: string; status?: boolean }) {
  return {
    assetId: `asset-${input.identityKey}`,
    identityKey: input.identityKey,
    gameId: "arcaea" as const,
    assetType: "jacket" as const,
    variantKey: "default",
    title: input.title,
    aliases: [input.title],
    sourceIdentity: input.identityKey,
    file: { objectId: `sha256:${input.hash}`, objectKey: `objects/${input.hash}/jpg`, sha256: input.hash, sizeBytes: 100, width: 100, height: 100, mime: "image/jpeg" },
    metadata: { source: "test", ...(input.status === false ? { state: "draft" } : {}) },
    needsReview: false,
    needsRename: false,
    anomalies: [],
  };
}

function manifest(version: string, entries: ReturnType<typeof entry>[]) {
  return UnifiedAssetManifest.parse({ kind: "rhythm-unified-asset-manifest", schemaVersion: "1", gameId: "arcaea", version, generatedAt: "2026-08-25T00:00:00.000Z", sourceSnapshot: `snapshot:${version}`, entries });
}

test("game profiles expose a real adapter boundary and read-only probe", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "rhythm-platform-"));
  const source = path.join(temp, "sample.apk");
  await writeFile(source, "apk-placeholder", "utf8");
  const adapter = getGameAdapter("arcaea");
  const probe = await adapter.probe(source);
  assert.equal(probe.readOnly, true);
  assert.equal(probe.sourceKind, "apk");
  assert.equal(probe.exists, true);
  assert.equal(adapter.planExtraction(probe).outputBoundary, "temp");
  assert.equal(getGameProfile("rizline").adapterId, "rizline-remote");
});

test("GameRecord and AssetRecord project validated catalog information", () => {
  const catalog = createEmptyCatalog("2026-08-25T00:00:00.000Z");
  const games = gameRecordsFromCatalog(catalog);
  assert.equal(games.length, 4);
  assert.equal(GameRecord.parse(games[0]).gameId, "arcaea");
  const asset = AssetRecord.parse({ gameId: "arcaea", assetId: "asset-1", assetType: "jacket", title: "Test", aliases: ["test"], sourceIdentity: "arcaea:songId=test", metadata: {} });
  assert.equal(asset.assetType, "jacket");
});

test("formal Catalog becomes a unified manifest without draft resources", () => {
  const catalog = createEmptyCatalog("2026-08-25T00:00:00.000Z");
  const result = manifestFromCatalog(catalog, "arcaea", "legacy");
  assert.equal(result.gameId, "arcaea");
  assert.equal(result.entries.length, 0);
});

test("ReleaseDelta classifies NEW, CHANGED, REMOVED and UNCHANGED", () => {
  const previous = manifest("1.0", [entry({ identityKey: "same", title: "Same", hash: hashA }), entry({ identityKey: "changed", title: "Old", hash: hashA }), entry({ identityKey: "removed", title: "Removed", hash: hashA })]);
  const current = manifest("2.0", [entry({ identityKey: "same", title: "Same", hash: hashA }), entry({ identityKey: "changed", title: "New", hash: hashB }), entry({ identityKey: "new", title: "New", hash: hashC })]);
  const delta = buildReleaseDelta(previous, current);
  const statuses = new Map(delta.entries.map((item) => [item.identityKey, item.status]));
  assert.deepEqual(Object.fromEntries(statuses), { changed: "CHANGED", new: "NEW", removed: "REMOVED", same: "UNCHANGED" });
  assert.equal(delta.summary.reviewRequired, 1);
  assert.equal(delta.entries.find((item) => item.status === "REMOVED")?.needsReview, true);
});

test("review approval and storage diff never turn removal into deletion", () => {
  const previous = manifest("1.0", [entry({ identityKey: "same", title: "Same", hash: hashA }), entry({ identityKey: "removed", title: "Removed", hash: hashA })]);
  const current = manifest("2.0", [entry({ identityKey: "same", title: "Same", hash: hashB }), entry({ identityKey: "new", title: "New", hash: hashC })]);
  const delta = buildReleaseDelta(previous, current);
  const review = buildReviewPackage(delta);
  assert.equal(review.status, "pending");
  const approved = approveReviewPackage(review, "test-reviewer");
  assert.equal(isReviewApproved(approved), true);
  const storage = buildStorageDiff(current, previous);
  assert.equal(storage.summary.uploads, 2);
  assert.equal(storage.entries.find((item) => item.status === "REMOVED")?.operation, "review");
});

test("unified manifest and workflow state are resumable on disk", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "rhythm-state-"));
  const source = path.join(temp, "source.apk");
  await writeFile(source, "source", "utf8");
  const manifestPath = path.join(temp, "manifest.json");
  const savedManifest = manifest("1.0", [entry({ identityKey: "one", title: "One", hash: hashA })]);
  await writeUnifiedManifest(savedManifest, manifestPath);
  assert.equal((await readUnifiedManifest(manifestPath)).entries.length, 1);
  const root = workflowRoot("arcaea", "1.0", temp);
  await mkdir(root, { recursive: true });
  const statePath = path.join(root, "state.json");
  const state = createWorkflowState({ gameId: "arcaea", version: "1.0", sourcePath: source, sourceSnapshot: "probe:test" });
  await saveWorkflowState(state, statePath);
  const updated = await updateWorkflowState(statePath, { phase: "normalize", completedSteps: ["probe", "ingest"], manifestPath });
  assert.equal((await loadWorkflowState(statePath)).phase, "normalize");
  assert.deepEqual(updated.completedSteps, ["probe", "ingest"]);
});

test("Rizline and In Falsus adapter manifests normalize into the same boundary", () => {
  const rizline = manifestFromExternalManifest({ generated_at: "2026-08-25T00:00:00.000Z", assets: [{ asset_family: "illustration", logical_key: "illustration.song.alpha.normal", semantic_id: "song.alpha", resolved_variant: "normal", decoded_sha256: hashA, width: 1024, height: 1024, parse_status: "SUCCESS", review_status: "APPROVED", export_path: "exports/illustrations/alpha.png" }] }, { gameId: "rizline", version: "2.7.0" });
  assert.equal(rizline.entries[0]?.assetType, "jacket");
  assert.equal(rizline.entries[0]?.file?.sha256, hashA);
  const infalsus = manifestFromExternalManifest({ songs: [{ identity: "infalsus:song:1", song_id: 1, base_name: "alpha", title: "Alpha", artist: "Artist", artwork: { identity: "infalsus:artwork:1:canonical", canonical: { pixel_sha256: hashB, width: 2048, height: 2048 } } }] }, { gameId: "infalsus", version: "demo" });
  assert.equal(infalsus.entries[0]?.assetType, "jacket");
  assert.equal(infalsus.entries[0]?.metadata.pixelSha256, hashB);
});

test("remote inputs stay declaration-only and review must match its delta", async () => {
  const adapter = getGameAdapter("rizline");
  const probe = await adapter.probe("https://cdn.example.test/rizline/manifest.json");
  assert.equal(probe.sourceKind, "remote");
  assert.equal(probe.sourcePath, "https://cdn.example.test/rizline/manifest.json");
  assert.match(probe.diagnostics[0] ?? "", /not fetched/u);
  const state = createWorkflowState({ gameId: "rizline", version: "remote", sourcePath: probe.sourcePath });
  assert.equal(state.sourcePath, probe.sourcePath);
  const previous = manifest("1.0", [entry({ identityKey: "removed", title: "Removed", hash: hashA })]);
  const current = manifest("2.0", [entry({ identityKey: "new", title: "New", hash: hashB })]);
  const delta = buildReleaseDelta(previous, current);
  const review = buildReviewPackage(delta);
  assert.equal(validateReviewPackageForDelta(review, delta).valid, true);
  const partialKeys = review.changedItems.slice(0, 1).map((item) => item.identityKey);
  assert.throws(() => approveReviewPackage(review, "partial", { approvedChangeKeys: partialKeys }), /every actionable change/u);
  const stale = { ...review, deltaSnapshot: "probe:stale" };
  assert.equal(validateReviewPackageForDelta(stale, delta).valid, false);
});
