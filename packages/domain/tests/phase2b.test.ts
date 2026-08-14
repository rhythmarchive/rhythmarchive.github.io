import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import {
  Candidate,
  Catalog,
  Rendition,
  createPublishPlanDryRun,
  createReleaseManifestDraft,
  createUuidV7,
  createVersionWorkspace,
  finalizeWorkspaceCandidate,
  prepareUpscaleInputs,
  reconcileUpscaleOutputs,
  reconcileWorkspace,
  rejectCandidate,
  renameCandidateInWorkspace,
  scanWorkspace,
  selectUpscaleAttempt,
  summarizePublishPlan,
  approveCandidateInWorkspace,
  validateRawManifest,
  validateCandidate,
  validateReviewLog,
  validateWorkspaceScanSnapshot,
  assertSchemaVersions,
  replaceRenditionObject,
  renameRenditionDownloadFilename,
  loadWorkspaceState,
  type CandidateManifestAdapterInput,
} from "../src/index.js";

async function image(filePath: string, options: { width?: number; height?: number; alpha?: number; color?: string } = {}): Promise<void> {
  await sharp({
    create: {
      width: options.width ?? 96,
      height: options.height ?? 96,
      channels: options.alpha === undefined ? 3 : 4,
      background: options.color ?? (options.alpha === undefined ? "#224466" : { r: 220, g: 40, b: 90, alpha: options.alpha }),
    },
  }).png().toFile(filePath);
}

async function makeWorkspace(options: { requiresUpscale?: boolean; second?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-assets-gallery-v2-phase2b-"));
  const sourceDir = path.join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "foo.png");
  await image(source);
  const candidates: CandidateManifestAdapterInput["candidates"] = [{
    sourcePath: source,
    sourceRelativePath: "songs/foo.png",
    sourceFilename: "foo.png",
    suggestedFilename: "foo.png",
    resourceType: "jacket",
    title: "Foo",
    variantKey: "default",
    variantKind: "default",
    metadata: { artist: "fixture" },
    requiresUpscale: options.requiresUpscale ?? false,
  }];
  if (options.second) {
    const source2 = path.join(sourceDir, "bar.png");
    await image(source2, { color: "#663322" });
    candidates.push({
      sourcePath: source2,
      sourceRelativePath: "songs/bar.png",
      sourceFilename: "bar.png",
      suggestedFilename: "bar.png",
      resourceType: "jacket",
      title: "Bar",
      variantKey: "default",
      variantKind: "default",
      metadata: { artist: "fixture" },
      requiresUpscale: options.requiresUpscale ?? false,
    });
  }
  const workspace = await createVersionWorkspace({
    rootPath: path.join(root, "workspace"),
    game: "arcaea",
    baseVersion: "6.16.0",
    targetVersion: "6.17.0",
    sourceManifest: { game: "arcaea", sourceType: "arcaea_apk", sourceSnapshot: "fixture", extractorVersion: "fixture-adapter@1", candidates },
  });
  return { root, sourceDir, source, workspace };
}

test("createWorkspace is idempotent and persists independent manifest families", async () => {
  const fixture = await makeWorkspace();
  try {
    const root = fixture.workspace.rootPath;
    for (const directory of ["raw", "work", "upscale-input", "upscale-output", "processed", "metadata"]) assert.equal((await stat(path.join(root, directory))).isDirectory(), true);
    const initial = await loadWorkspaceState(root);
    assert.equal(initial.candidates.length, 1);
    assert.equal(initial.candidates[0]!.id, fixture.workspace.candidates[0]!.id);
    assert.equal((await readFile(path.join(root, "metadata/raw-manifest.json"), "utf8")).includes("sha256"), true);
    assert.equal(validateRawManifest(JSON.parse(await readFile(path.join(root, "metadata/raw-manifest.json"), "utf8"))).success, true);
    assert.equal(validateReviewLog(JSON.parse(await readFile(path.join(root, "metadata/review-log.json"), "utf8"))).success, true);
    const repeated = await createVersionWorkspace({
      rootPath: root,
      game: "arcaea",
      baseVersion: "6.16.0",
      targetVersion: "6.17.0",
      sourceManifest: { game: "arcaea", sourceType: "arcaea_apk", sourceSnapshot: "different", candidates: [] },
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.candidates[0]!.id, initial.candidates[0]!.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Explorer rename, move, content replacement, missing and raw integrity are filesystem-reconciled", async () => {
  const fixture = await makeWorkspace();
  try {
    const root = fixture.workspace.rootPath;
    const originalId = fixture.workspace.candidates[0]!.id;
    await rename(path.join(root, "work", "foo.png"), path.join(root, "work", "Foo.png"));
    let scan = await reconcileWorkspace(root);
    assert.equal(scan.diffs.some((diff) => diff.kind === "RENAMED" && diff.candidateId === originalId), true);
    await rename(path.join(root, "work", "Foo.png"), path.join(root, "work", "Testify.png"));
    scan = await reconcileWorkspace(root);
    assert.equal(scan.diffs.some((diff) => diff.kind === "RENAMED" && diff.candidateId === originalId), true);
    let state = await loadWorkspaceState(root);
    assert.equal(state.candidates.find((candidate) => candidate.id === originalId)!.files.find((file) => file.role === "work-original")!.relativePath, "work/Testify.png");
    assert.equal(state.candidates.find((candidate) => candidate.id === originalId)!.id, originalId);

    await mkdir(path.join(root, "work", "BYD"), { recursive: true });
    await rename(path.join(root, "work", "Testify.png"), path.join(root, "work", "BYD", "Testify.png"));
    scan = await reconcileWorkspace(root);
    assert.equal(scan.diffs.some((diff) => diff.kind === "MOVED" && diff.candidateId === originalId), true);

    await image(path.join(root, "work", "BYD", "Testify.png"), { width: 120, height: 80, alpha: 0.5 });
    scan = await reconcileWorkspace(root);
    assert.equal(scan.diffs.some((diff) => diff.kind === "MODIFIED_CONTENT" && diff.candidateId === originalId), true);
    state = await loadWorkspaceState(root);
    const replaced = state.candidates.find((candidate) => candidate.id === originalId)!;
    const replacedFile = replaced.files.find((file) => file.role === "work-original")!;
    assert.equal(replacedFile.revisions.length >= 4, true);
    assert.equal(replacedFile.width, 120);
    assert.equal(replacedFile.height, 80);
    assert.equal(replacedFile.alpha, "translucent");
    assert.notEqual(replaced.status, "REJECTED");

    await unlink(path.join(root, "work", "BYD", "Testify.png"));
    scan = await reconcileWorkspace(root);
    assert.equal(scan.diffs.some((diff) => diff.kind === "MISSING" && diff.candidateId === originalId), true);
    state = await loadWorkspaceState(root);
    assert.equal(state.candidates.find((candidate) => candidate.id === originalId)!.status, "BLOCKED");
    assert.notEqual(state.candidates.find((candidate) => candidate.id === originalId)!.status, "REJECTED");

    const rawFile = path.join(root, "raw", "candidates", originalId, "foo.png");
    await writeFile(rawFile, Buffer.from("raw changed"));
    const rawScan = await scanWorkspace(root);
    assert.equal(rawScan.rawIntegrity.some((issue) => issue.code === "RAW_SOURCE_MODIFIED"), true);
    await unlink(rawFile);
    assert.equal((await scanWorkspace(root)).rawIntegrity.some((issue) => issue.code === "RAW_SOURCE_MISSING"), true);
    await writeFile(path.join(root, "raw", "unexpected.bin"), Buffer.from("unexpected"));
    assert.equal((await scanWorkspace(root)).rawIntegrity.some((issue) => issue.code === "RAW_SOURCE_UNEXPECTED"), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("duplicate same-hash rename is blocked and new work files become manual Candidates", async () => {
  const fixture = await makeWorkspace();
  try {
    const root = fixture.workspace.rootPath;
    const originalId = fixture.workspace.candidates[0]!.id;
    const oldPath = path.join(root, "work", "foo.png");
    const content = await readFile(oldPath);
    await unlink(oldPath);
    await mkdir(path.join(root, "work", "a"), { recursive: true });
    await mkdir(path.join(root, "work", "b"), { recursive: true });
    await writeFile(path.join(root, "work", "a", "one.png"), content);
    await writeFile(path.join(root, "work", "b", "two.png"), content);
    const scan = await reconcileWorkspace(root);
    assert.equal(scan.diffs.some((diff) => diff.kind === "AMBIGUOUS" && diff.candidateId === originalId && diff.code === "BLOCKED_AMBIGUOUS_RENAME"), true);
    const state = await loadWorkspaceState(root);
    assert.equal(state.candidates.find((candidate) => candidate.id === originalId)!.status, "BLOCKED");
    assert.equal(state.candidates.filter((candidate) => candidate.sourceEvidence.sourceType === "manual").length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("manual rename aliases keep optimization output matched after external filesystem rename", async () => {
  const fixture = await makeWorkspace({ requiresUpscale: true });
  try {
    const root = fixture.workspace.rootPath;
    const id = fixture.workspace.candidates[0]!.id;
    const prepared = await prepareUpscaleInputs(root);
    assert.equal(prepared.entries.length, 1);
    await mkdir(path.join(root, "upscale-output"), { recursive: true });
    await image(path.join(root, "upscale-output", "foo_optimization.png"), { width: 192, height: 192, color: "#8899aa" });
    await rename(path.join(root, "work", "foo.png"), path.join(root, "work", "Testify.png"));
    await reconcileWorkspace(root);
    const matched = await reconcileUpscaleOutputs(root);
    assert.equal(matched.outputs[0]!.state, "matched");
    assert.deepEqual(matched.outputs[0]!.candidateIds, [id]);
    const state = await loadWorkspaceState(root);
    assert.equal(state.candidates.find((candidate) => candidate.id === id)!.id, id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("multiple optimization attempts remain unselected, then explicit selection is converted to JPG", async () => {
  const fixture = await makeWorkspace({ requiresUpscale: true });
  try {
    const root = fixture.workspace.rootPath;
    const id = fixture.workspace.candidates[0]!.id;
    await prepareUpscaleInputs(root);
    await image(path.join(root, "upscale-output", "foo_optimization.png"), { width: 192, height: 192, color: "#8899aa" });
    await image(path.join(root, "upscale-output", "foo_opt.png"), { width: 192, height: 192, color: "#aa9988" });
    const result = await reconcileUpscaleOutputs(root);
    assert.equal(result.outputs.filter((output) => output.state === "matched").length, 2);
    const afterScan = await loadWorkspaceState(root);
    const candidate = afterScan.candidates.find((item) => item.id === id)!;
    assert.equal(candidate.processing.selectedOutputFileId, undefined);
    assert.equal(candidate.processing.optimizationMatches.length, 2);
    const selected = await selectUpscaleAttempt(root, id, candidate.processing.optimizationMatches[0]!.outputFileId);
    assert.ok(selected.processing.selectedOutputFileId);
    const selectedOutput = selected.files.find((file) => file.id === selected.processing.selectedOutputFileId)!;
    const converted = await (await import("../src/index.js")).convertSelectedUpscale(root, id);
    assert.equal(converted.conversion.status, "converted");
    assert.equal(converted.candidate.processing.conversion?.quality, 95);
    assert.equal((await stat(path.join(root, "upscale-output", "foo_optimization.png"))).isFile(), true);
    assert.equal((await stat(path.join(root, "processed", "foo.jpg"))).isFile(), true);
    await unlink(path.join(root, ...selectedOutput.relativePath.split("/")));
    await reconcileUpscaleOutputs(root);
    const missingState = await loadWorkspaceState(root);
    const missingCandidate = missingState.candidates.find((item) => item.id === id)!;
    assert.equal(missingCandidate.status, "BLOCKED");
    assert.equal(missingCandidate.processing.selectedOutputFileId, undefined);
    assert.equal(missingCandidate.files.some((file) => file.role === "upscale-output" && file.availability === "missing"), true);
    assert.equal(missingState.reviewLog.events.some((event) => event.type === "upscale-attempt-failure" && event.candidateId === id), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("one optimization output matching two Candidates is BLOCKED_AMBIGUOUS_UPSCALE", async () => {
  const fixture = await makeWorkspace({ requiresUpscale: true, second: true });
  try {
    const root = fixture.workspace.rootPath;
    await renameCandidateInWorkspace(root, fixture.workspace.candidates[0]!.id, "same.png");
    await renameCandidateInWorkspace(root, fixture.workspace.candidates[1]!.id, "same.png");
    await prepareUpscaleInputs(root);
    await unlink(path.join(root, "metadata", "upscale-map.json"));
    await image(path.join(root, "upscale-output", "same_optimization.png"), { width: 192, height: 192, color: "#8899aa" });
    const result = await reconcileUpscaleOutputs(root);
    assert.equal(result.outputs[0]!.state, "ambiguous");
    assert.equal(result.outputs[0]!.code, "BLOCKED_AMBIGUOUS_UPSCALE");
    assert.equal(result.outputs[0]!.candidateIds.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inactive historical upscale mapping cannot override the active Candidate binding", async () => {
  const fixture = await makeWorkspace({ requiresUpscale: true, second: true });
  try {
    const root = fixture.workspace.rootPath;
    const state = await loadWorkspaceState(root);
    const first = state.candidates[0]!;
    const second = state.candidates[1]!;
    const firstWork = first.files.find((file) => file.role === "work-original")!;
    const secondWork = second.files.find((file) => file.role === "work-original")!;
    await writeFile(path.join(root, "metadata", "upscale-map.json"), JSON.stringify({
      workspaceSchemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      entries: [
        { inputFilename: "shared.png", candidateId: first.id, sourceHash: firstWork.sha256, sourceRelativePath: firstWork.relativePath, active: true },
        { inputFilename: "shared.png", candidateId: second.id, sourceHash: secondWork.sha256, sourceRelativePath: secondWork.relativePath, active: false },
      ],
    }));
    await image(path.join(root, "upscale-output", "shared_optimization.png"), { width: 192, height: 192, color: "#8899aa" });
    const result = await reconcileUpscaleOutputs(root);
    assert.equal(result.outputs[0]!.state, "matched");
    assert.deepEqual(result.outputs[0]!.candidateIds, [first.id]);
    assert.equal(result.outputs[0]!.matchedBy, "manifest");
    await writeFile(path.join(root, "metadata", "upscale-map.json"), JSON.stringify({
      workspaceSchemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      entries: [
        { inputFilename: "shared.png", candidateId: first.id, sourceHash: firstWork.sha256, sourceRelativePath: firstWork.relativePath, active: true },
        { inputFilename: "shared.png", candidateId: second.id, sourceHash: secondWork.sha256, sourceRelativePath: secondWork.relativePath, active: true },
      ],
    }));
    const ambiguous = await reconcileUpscaleOutputs(root);
    assert.equal(ambiguous.outputs[0]!.state, "ambiguous");
    assert.equal(ambiguous.outputs[0]!.code, "BLOCKED_AMBIGUOUS_UPSCALE");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ready Candidate produces a release draft and publish dry-run without ignored review history", async () => {
  const fixture = await makeWorkspace();
  try {
    const root = fixture.workspace.rootPath;
    const id = fixture.workspace.candidates[0]!.id;
    await rename(path.join(root, "work", "foo.png"), path.join(root, "work", "Foo Final.png"));
    await reconcileWorkspace(root);
    await renameCandidateInWorkspace(root, id, "Foo Final.jpg", { finalize: true });
    await approveCandidateInWorkspace(root, id, { decision: "accept-new-resource" });
    const resourceId = createUuidV7();
    const variantId = createUuidV7();
    const renditionId = createUuidV7();
    const ready = await finalizeWorkspaceCandidate(root, id, { target: { resourceId, variantId, renditionId }, downloadFilename: "Foo Final.jpg", metadataValid: true });
    assert.equal(ready.status, "READY");
    const state = await loadWorkspaceState(root);
    const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, workspaceRoot: root, catalog: { catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] } });
    assert.equal(manifest.publishedRenditions[0]!.downloadFilename, "Foo Final.jpg");
    assert.equal("ignoredCandidates" in manifest, false);
    const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog: { catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] }, releaseManifest: manifest, workspaceRoot: root });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.objectsToCreate.length, 1);
    assert.equal(plan.catalogMutations.some((mutation) => mutation.operation === "create-resource"), true);
    assert.equal(summarizePublishPlan(plan, manifest).addedResources, 1);
    assert.equal(plan.notes.some((note) => note.includes("ROS")), true);
    const invalidManifest = {
      ...manifest,
      changes: [],
      affectedResourceIds: [createUuidV7()],
      publishedRenditions: [{ ...manifest.publishedRenditions[0]!, resourceId: createUuidV7(), variantId: createUuidV7(), renditionId: createUuidV7() }],
    };
    await assert.rejects(
      () => createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog: { catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] }, releaseManifest: invalidManifest, workspaceRoot: root }),
      /ReleaseManifest references are invalid/,
    );
    const finalFile = state.candidates[0]!.files.find((file) => file.role === "work-original")!;
    await writeFile(path.join(root, ...finalFile.relativePath.split("/")), Buffer.from("final bytes changed after READY"));
    await assert.rejects(
      () => createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, workspaceRoot: root, catalog: { catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] } }),
      /final file bytes no longer match/,
    );
    await writeFile(path.join(root, "raw", "candidates", id, "foo.png"), Buffer.from("raw tampered after READY"));
    await assert.rejects(
      () => createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, workspaceRoot: root, catalog: { catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] } }),
      /raw integrity blocks publication/,
    );
    await assert.rejects(
      () => createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog: { catalogSchemaVersion: "1.0", catalogId: createUuidV7(), generatedAt: new Date().toISOString(), resources: [], variants: [], renditions: [], objects: [], releaseManifestIds: [] }, releaseManifest: manifest, workspaceRoot: root }),
      /raw integrity blocks publication/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("explicit rejection is local ReviewLog state and never a ReleaseManifest entry", async () => {
  const fixture = await makeWorkspace();
  try {
    const id = fixture.workspace.candidates[0]!.id;
    await rejectCandidate(fixture.workspace.rootPath, id, "not part of this update");
    const state = await loadWorkspaceState(fixture.workspace.rootPath);
    assert.equal(state.candidates[0]!.status, "REJECTED");
    assert.equal(state.reviewLog.events.some((event) => event.type === "rejected" && event.candidateId === id), true);
    assert.equal(state.batch.status, "READY_TO_PUBLISH");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace scan snapshot has its own schema boundary", async () => {
  const fixture = await makeWorkspace();
  try {
    const scan = await scanWorkspace(fixture.workspace.rootPath);
    assert.equal(validateWorkspaceScanSnapshot(scan.snapshot).success, true);
    assert.equal((scan.snapshot as { workspaceSchemaVersion: string }).workspaceSchemaVersion, "1.0");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema version families are validated independently", () => {
  assert.doesNotThrow(() => assertSchemaVersions({ catalogSchemaVersion: "1.0", workspaceSchemaVersion: "1.0", releaseSchemaVersion: "1.0", publishPlanSchemaVersion: "1.0" }));
  assert.throws(() => assertSchemaVersions({ catalogSchemaVersion: "9.0", workspaceSchemaVersion: "1.0" }), /catalogSchemaVersion/);
});

test("READY validation rejects unresolved upscale attempts", async () => {
  const candidate = Candidate.parse(JSON.parse(await readFile(path.resolve("fixtures", "phase2a", "valid-candidate.json"), "utf8")));
  const invalid = Candidate.parse({
    ...candidate,
    processing: {
      ...candidate.processing,
      optimizationMatches: candidate.processing.optimizationMatches.map((match) => ({ ...match, state: "ambiguous" as const, competingCandidateIds: [candidate.id] })),
    },
  });
  const result = validateCandidate(invalid);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.issues.some((issue) => issue.path === "processing.optimizationMatches"), true);
});

test("Rendition role identity survives Object replacement and download filename edits", () => {
  const rendition = Rendition.parse({
    catalogSchemaVersion: "1.0",
    id: createUuidV7(),
    variantId: createUuidV7(),
    renditionType: "upscaled",
    origin: "derived",
    publishable: true,
    objectId: `sha256:${"a".repeat(64)}`,
    downloadFilename: "Testify.jpg",
    sourceRenditionId: createUuidV7(),
    generatedBy: "converter",
    createdAt: new Date().toISOString(),
  });
  const replaced = replaceRenditionObject(rendition, `sha256:${"b".repeat(64)}`);
  assert.equal(replaced.id, rendition.id);
  assert.notEqual(replaced.objectId, rendition.objectId);
  const renamed = renameRenditionDownloadFilename(replaced, "Testify - void.jpg");
  assert.equal(renamed.id, rendition.id);
  assert.equal(renamed.objectId, replaced.objectId);
  assert.equal(renamed.downloadFilename, "Testify - void.jpg");
  const original = Rendition.parse({ ...rendition, renditionType: "original", origin: "source", generatedBy: "extractor", sourceRenditionId: undefined });
  const replacedOriginal = replaceRenditionObject(original, `sha256:${"c".repeat(64)}`);
  assert.equal(replacedOriginal.id, original.id);
  assert.notEqual(replacedOriginal.objectId, original.objectId);
});

test("existing Catalog rendition replacement keeps the semantic slot and plans the old Object for retention GC", async () => {
  const fixture = await makeWorkspace();
  try {
    const root = fixture.workspace.rootPath;
    const id = fixture.workspace.candidates[0]!.id;
    await renameCandidateInWorkspace(root, id, "Acid God New.jpg", { finalize: true });
    await approveCandidateInWorkspace(root, id, { decision: "accept-new-rendition" });
    const catalog = Catalog.parse(JSON.parse(await readFile(path.resolve("fixtures", "phase2a", "valid-catalog.json"), "utf8")));
    const target = { resourceId: catalog.resources[0]!.id, variantId: catalog.variants[0]!.id, renditionId: catalog.renditions[0]!.id };
    await finalizeWorkspaceCandidate(root, id, { target, downloadFilename: "Acid God New.jpg", metadataValid: true });
    const state = await loadWorkspaceState(root);
    const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, catalog, workspaceRoot: root });
    assert.equal(manifest.changes.some((change) => change.changeType === "replaced-rendition" && change.renditionId === target.renditionId), true);
    assert.equal(manifest.publishedRenditions[0]!.renditionId, target.renditionId);
    const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog, releaseManifest: manifest, workspaceRoot: root });
    assert.equal(plan.catalogMutations.some((mutation) => mutation.operation === "replace-rendition" && mutation.renditionId === target.renditionId), true);
    assert.equal(plan.objectsEligibleForGC.length >= 1, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
