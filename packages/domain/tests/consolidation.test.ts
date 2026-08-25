import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContentAdditionManifest } from "../src/content.js";
import { probeOnboardingSource, createOnboardingPlan } from "../src/onboarding.js";
import { buildReleaseDelta, UnifiedAssetManifest } from "../src/release.js";
import { canTransitionWorkflow, createWorkflowState, transitionWorkflowState, WorkflowState } from "../src/workflow-state.js";
import { adapterContractFor, listRegisteredAdapters } from "../../../tools/adapter-registry.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function file(hash: string) {
  return { objectId: "sha256:" + hash, objectKey: "objects/" + hash + "/jpg", sha256: hash, sizeBytes: 100, width: 100, height: 100, mime: "image/jpeg" };
}

test("unregistered candidates can be probed without entering the formal Game registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rhythm-onboarding-"));
  try {
    await mkdir(path.join(root, "assets", "aa"), { recursive: true });
    await mkdir(path.join(root, "libil2cpp"), { recursive: true });
    await writeFile(path.join(root, "globalgamemanagers"), "unity marker", "utf8");
    await writeFile(path.join(root, "libil2cpp", "global-metadata.dat"), "il2cpp marker", "utf8");
    await writeFile(path.join(root, "assets", "aa", "catalog.json"), "addressables marker", "utf8");
    const candidate = await probeOnboardingSource("Example New Game", root);
    assert.equal(candidate.slug, "example-new-game");
    assert.equal(candidate.sourceKind, "directory");
    assert.equal(candidate.readOnly, true);
    assert.equal(candidate.detectedEngine, "unity");
    assert.equal(candidate.detectedRuntime, "il2cpp");
    assert.ok(candidate.detectedMarkers.some((marker) => marker.includes("globalgamemanagers")));
    assert.ok(candidate.detectedMarkers.some((marker) => marker.includes("catalog.json")));
    assert.equal(candidate.sourceSnapshot.startsWith("onboard:"), true);
    const plan = createOnboardingPlan(candidate);
    assert.equal(plan.profile.lifecycle, "analysis-only");
    assert.deepEqual(plan.profile.selectionPolicy.selectedAssetTypes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkflowState enforces sequential transitions and preserves a resumable blocker", () => {
  const state = createWorkflowState({ gameId: "unknown-game", candidateSlug: "unknown-game", workflowKind: "game-reconnaissance", version: "recon", sourcePath: "C:\\\\input.apk" });
  assert.equal(canTransitionWorkflow(state.phase, "ingest"), true);
  assert.equal(canTransitionWorkflow(state.phase, "diff"), false);
  const ingested = transitionWorkflowState(state, "ingest");
  assert.deepEqual(ingested.completedSteps, ["probe", "ingest"]);
  const blocked = transitionWorkflowState(ingested, "blocked", { blockers: ["adapter marker disappeared"] });
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.resumePhase, "ingest");
  assert.deepEqual(blocked.blockers, ["adapter marker disappeared"]);
  const resumed = transitionWorkflowState(blocked, "ingest");
  assert.equal(resumed.phase, "ingest");
  assert.deepEqual(resumed.blockers, []);
  assert.equal(resumed.resumePhase, undefined);
  assert.throws(() => transitionWorkflowState(resumed, "review"), /invalid workflow transition/u);
  assert.equal(WorkflowState.parse(resumed).gameId, "unknown-game");
});

test("content additions preserve unchanged entries and enter the shared delta", () => {
  const previous = UnifiedAssetManifest.parse({
    kind: "rhythm-unified-asset-manifest",
    schemaVersion: "1",
    gameId: "arcaea",
    version: "1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    sourceSnapshot: "snapshot:previous",
    entries: [{
      assetId: "asset-a",
      identityKey: "arcaea|jacket|song-a|default",
      gameId: "arcaea",
      assetType: "jacket",
      variantKey: "default",
      title: "Old title",
      aliases: ["song-a"],
      sourceIdentity: "song-a",
      file: file(hashA),
      metadata: { artist: "Artist" },
      needsReview: false,
      needsRename: false,
      anomalies: [],
    }],
  });
  const current = buildContentAdditionManifest({
    kind: "rhythm-content-addition",
    schemaVersion: "1",
    gameId: "arcaea",
    version: "1.1",
    entries: [
      { sourceIdentity: "song-a", assetType: "jacket", variantKey: "default", title: "New title", origin: "metadata-only", metadata: { artist: "New Artist" } },
      { sourceIdentity: "song-a", assetType: "jacket", variantKey: "event", title: "Event art", origin: "new-variant", file: file(hashB) },
      { sourceIdentity: "song-b", assetType: "jacket", variantKey: "default", title: "Manual art", origin: "manual", file: file(hashC) },
    ],
    notes: ["curated activity batch"],
  }, previous, "2026-08-25T00:00:00.000Z");
  assert.equal(current.entries.length, 3);
  assert.equal(current.entries.find((entry) => entry.variantKey === "default")?.file?.sha256, hashA);
  assert.equal(current.entries.find((entry) => entry.variantKey === "default")?.metadata.contentOrigin, "metadata-only");
  const delta = buildReleaseDelta(previous, current);
  const statuses = new Map(delta.entries.map((entry) => [entry.identityKey, entry.status]));
  assert.equal(statuses.get("arcaea|jacket|song-a|default"), "CHANGED");
  assert.equal(statuses.get("arcaea|jacket|song-a|event"), "NEW");
  assert.equal(statuses.get("arcaea|jacket|song-b|default"), "NEW");
  assert.equal(delta.summary.removed, 0);
});

test("adapter registry exposes a stable contract independently of CLI game branches", () => {
  const contract = adapterContractFor("phigros");
  assert.equal(contract.adapterId, "phigros-apk");
  assert.deepEqual(contract.capabilities, ["probe", "extract", "normalize", "validate"]);
  assert.deepEqual(Object.keys(contract.operations), ["probe", "extract", "normalize", "validate"]);
  assert.equal(contract.operations.extract, "adapter-registry.extract");
  const adapters = listRegisteredAdapters();
  assert.equal(adapters.length, 5);
  assert.deepEqual(adapters.flatMap((adapter) => adapter.games), ["arcaea", "phigros", "rizline", "infalsus", "rotaeno"]);
  assert.ok(adapters.every((adapter) => adapter.capabilities.includes("extract")));
});
