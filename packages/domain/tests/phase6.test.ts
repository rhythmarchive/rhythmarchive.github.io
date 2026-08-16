import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  classifyPhigrosContentDiff,
  classifySemanticDiff,
  candidateSourceRecord,
  sourceInventoryRecord,
  createVersionWorkspace,
  confirmCandidateInWorkspace,
  prepareUpscaleInputs,
  reconcileUpscaleOutputs,
  selectUpscaleAttempt,
  convertSelectedUpscale,
  finalizeWorkspaceCandidate,
  loadWorkspaceState,
  createEmptyCatalog,
  createPublishPlanDryRun,
  createReleaseManifestDraft,
  executePublishPlan,
  MemoryStorageClient,
  createUuidV7,
  overrideCandidateFilenameInWorkspace,
  overrideCandidateMetadataInWorkspace,
  removeCandidateFromUpdate,
  replaceCandidateImageInWorkspace,
  restoreCandidateOriginal,
  runRealEsrgan,
  selectPreviewSource,
  verifyRealEsrganOutput,
  buildRealEsrganCommand,
  buildArcaeaSourceInventory,
  adaptPhigrosLegacyReport,
  createWorkspaceFromExtractorResult,
  type CandidateManifestAdapterInput,
  type RealEsrganConfig,
} from "../src/index.js";

async function image(filePath: string, color: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).png().toFile(filePath);
}

function candidateInput(sourcePath: string, options: { game?: "arcaea" | "phigros"; resourceType?: "jacket" | "background"; requiresUpscale?: boolean } = {}): CandidateManifestAdapterInput["candidates"][number] {
  const filename = path.basename(sourcePath);
  return {
    sourcePath,
    sourceRelativePath: options.game === "phigros" ? `bundles/songs.bundle/${filename}` : `songs/${filename}`,
    sourceFilename: filename,
    sourceGameVersion: "6.17.0",
    detection: "added",
    suggestedFilename: filename,
    resourceType: options.resourceType ?? "jacket",
    title: "Phase 6 fixture",
    variantKey: "default",
    variantKind: "default",
    metadata: { artist: "fixture" },
    confidence: "high",
    evidence: [{ kind: "apk-relative-path", detail: "fixture source path", confidence: "high" }],
    mappingEvidence: [{ kind: "metadata", detail: "fixture identity", confidence: "high" }],
    externalIdentities: [],
    requiresUpscale: options.requiresUpscale ?? false,
  };
}

test("same Update creation is idempotent and does not duplicate Candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-idempotent-"));
  try {
    const source = path.join(root, "source", "same.png");
    await image(source, "#345678");
    const options = {
      rootPath: path.join(root, "runtime", "updates", "same-update"),
      game: "arcaea" as const,
      baseVersion: "6.16.0",
      targetVersion: "6.17.0",
      sourceManifest: {
        game: "arcaea" as const,
        sourceType: "arcaea_apk" as const,
        sourceSnapshot: "phase6-fixture",
        candidates: [candidateInput(source)],
      },
    };
    const first = await createVersionWorkspace(options);
    const second = await createVersionWorkspace(options);
    assert.equal(second.created, false);
    assert.equal(second.batch.id, first.batch.id);
    assert.deepEqual(second.candidates.map((candidate) => candidate.id), first.candidates.map((candidate) => candidate.id));
    assert.equal(second.candidates.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only Arcaea jacket candidates are eligible for Real-ESRGAN", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-upscale-policy-"));
  try {
    const jacket = path.join(root, "jacket.png");
    const background = path.join(root, "background.png");
    const phigros = path.join(root, "phigros.png");
    await Promise.all([image(jacket, "#123456"), image(background, "#654321"), image(phigros, "#111111")]);
    const make = (game: "arcaea" | "phigros", source: string, resourceType: "jacket" | "background") => createVersionWorkspace({
      rootPath: path.join(root, game, resourceType),
      game,
      baseVersion: "1.0",
      targetVersion: "1.1",
      sourceManifest: { game, sourceType: game === "arcaea" ? "arcaea_apk" : "phigros_apk", sourceSnapshot: "phase6-fixture", candidates: [candidateInput(source, { game, resourceType, requiresUpscale: true })] },
    });
    const [arcaeaJacket, arcaeaBackground, phigrosJacket] = await Promise.all([
      make("arcaea", jacket, "jacket"),
      make("arcaea", background, "background"),
      make("phigros", phigros, "jacket"),
    ]);
    assert.equal(arcaeaJacket.candidates[0]!.processing.requiresUpscale, true);
    assert.equal(arcaeaBackground.candidates[0]!.processing.requiresUpscale, false);
    assert.equal(phigrosJacket.candidates[0]!.processing.requiresUpscale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phigros same bundle/path with different image bytes is content-changed", () => {
  const oldRecord = { bundlePath: "assets/songs/foo.bundle", objectName: "jacket", objectPathId: "42", imageContentHash: "a".repeat(64) };
  const newRecord = { ...oldRecord, imageContentHash: "b".repeat(64) };
  const diff = classifyPhigrosContentDiff([oldRecord], [newRecord]);
  assert.equal(diff.entries[0]!.kind, "content-changed");
  assert.equal(diff.summary.contentChanged, 1);
  assert.equal(diff.entries[0]!.detail, "assets/songs/foo.bundle::42");
});

test("Arcaea source inventory uses song identity and difficulty variant from the APK path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-arcaea-inventory-"));
  try {
    const source = path.join(root, "assets", "songs", "testify", "1080_base_2.jpg");
    await image(source, "#456789");
    const records = await buildArcaeaSourceInventory({ sourcePath: path.join(root, "assets"), runtimeRoot: path.join(root, "runtime") });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.resourceType, "jacket");
    assert.equal(records[0]!.sourceKey, "testify");
    assert.equal(records[0]!.sourceKeyType, "songId");
    assert.equal(records[0]!.variantKey, "FTR");
    assert.match(records[0]!.imageContentHash!, /^[0-9a-f]{64}$/u);
    const variantDiff = classifySemanticDiff([
      { identity: "arcaea:songid=testify", variantKey: "PST", contentHash: "a".repeat(64), game: "arcaea", resourceType: "jacket" },
      { identity: "arcaea:songid=testify", variantKey: "FTR", contentHash: "b".repeat(64), game: "arcaea", resourceType: "jacket" },
    ], [{ identity: "arcaea:songid=testify", variantKey: "FTR", contentHash: "c".repeat(64), game: "arcaea", resourceType: "jacket" }]);
    assert.equal(variantDiff.summary.contentChanged, 1);
    assert.equal(variantDiff.summary.unmatched, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phigros source inventory is retained separately from changed candidate files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-inventory-"));
  try {
    const outputDir = path.join(root, "extract");
    const outputImage = path.join(outputDir, "曲绘", "changed.png");
    await image(outputImage, "#765432");
    const reportPath = path.join(outputDir, "phigros-update-report.json");
    const hash = "c".repeat(64);
    await writeFile(reportPath, JSON.stringify({
      outputDir,
      sourceInventory: [{ category: "曲绘", bundle: "assets/aa/Android/foo.bundle", objectName: "Illustration", objectPathId: "42", imageContentHash: hash }],
      exported: [{ category: "曲绘", outputPath: "曲绘/changed.png", bundle: "assets/aa/Android/foo.bundle", objectName: "Illustration", objectPathId: "42", width: 32, height: 32, detection: "changed", imageContentHash: hash }],
    }));
    const result = await adaptPhigrosLegacyReport({
      reportPath,
      baseVersion: "3.19.4",
      targetVersion: "3.19.5",
      baseApk: { role: "base", version: "3.19.4", filename: "old.apk", absolutePath: path.join(root, "old.apk"), verification: "unverified" },
      targetApk: { role: "target", version: "3.19.5", filename: "new.apk", absolutePath: path.join(root, "new.apk"), verification: "unverified" },
    });
    const workspace = await createWorkspaceFromExtractorResult(result, { rootPath: path.join(root, "runtime", "update") });
    const persisted = JSON.parse(await readFile(path.join(workspace.rootPath, "metadata", "source-inventory.json"), "utf8"));
    assert.equal(persisted.records[0].game, "phigros");
    assert.equal(persisted.records[0].objectPathId, "42");
    assert.equal(workspace.candidates[0]!.provenance?.imageContentHash, hash);
    assert.equal(
      sourceInventoryRecord(persisted.records[0]).identity,
      candidateSourceRecord(workspace.candidates[0]!).identity,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing source records removal without implying Catalog or ROS deletion", () => {
  const diff = classifySemanticDiff([{
    identity: "arcaea:songid=old-song",
    contentHash: "a".repeat(64),
    game: "arcaea",
    resourceType: "jacket",
    resourceId: "resource-1",
    sourceRelativePath: "songs/old.jpg",
  }], []);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.removed[0]!.kind, "removed");
  assert.equal(diff.removed[0]!.resourceId, "resource-1");
});

test("review image replacement is workspace-local and restore returns the extractor bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-review-"));
  try {
    const original = path.join(root, "source", "original.png");
    const replacement = path.join(root, "replacement.png");
    await image(original, "#102030");
    await image(replacement, "#304050");
    const workspace = await createVersionWorkspace({
      rootPath: path.join(root, "runtime", "update"),
      game: "arcaea",
      baseVersion: "6.16.0",
      targetVersion: "6.17.0",
      sourceManifest: { game: "arcaea", sourceType: "arcaea_apk", sourceSnapshot: "phase6-fixture", candidates: [candidateInput(original, { requiresUpscale: true })] },
    });
    const candidateId = workspace.candidates[0]!.id;
    await overrideCandidateMetadataInWorkspace(workspace.rootPath, candidateId, { title: "Manual title", artist: "Manual artist" });
    await overrideCandidateFilenameInWorkspace(workspace.rootPath, candidateId, "manual-name.jpg");
    const replaced = await replaceCandidateImageInWorkspace(workspace.rootPath, candidateId, replacement);
    const replacedWork = replaced.files.find((file) => file.role === "work-original");
    const raw = replaced.files.find((file) => file.role === "raw-original");
    assert.notEqual(replacedWork?.sha256, raw?.sha256);
    assert.equal(candidateSourceRecord(replaced).contentHash, replacedWork?.sha256);
    assert.equal(replaced.processing.state, "needs-upscale");
    const removed = await removeCandidateFromUpdate(workspace.rootPath, candidateId, "ignored");
    assert.equal(removed.review.disposition, "ignored");
    assert.equal(removed.status, "REJECTED");
    const restored = await restoreCandidateOriginal(workspace.rootPath, candidateId);
    const restoredWork = restored.files.find((file) => file.role === "work-original");
    assert.equal(restored.review.disposition, "active");
    assert.deepEqual(restored.review.overrides, {});
    assert.equal(restored.naming.finalFilename, undefined);
    assert.equal(restoredWork?.sha256, raw?.sha256);
    await assert.rejects(() => access(path.join(workspace.rootPath, "catalog", "index.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Real-ESRGAN command and output verification stay thin and explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-esrgan-"));
  try {
    const input = path.join(root, "input.png");
    const output = path.join(root, "output.png");
    await image(input, "#506070");
    await sharp({ create: { width: 128, height: 128, channels: 3, background: "#506070" } }).png().toFile(output);
    const config: RealEsrganConfig = { executable: path.join(root, "realesrgan-ncnn-vulkan.exe"), modelDir: path.join(root, "models"), modelName: "realesrgan-x4plus-anime", scale: 4, tile: 0, gpu: "auto", jobs: "1:2:2" };
    const command = buildRealEsrganCommand(config, input, output);
    assert.deepEqual(command.args, ["-i", input, "-o", output, "-n", "realesrgan-x4plus-anime"]);
    assert.equal((await verifyRealEsrganOutput(input, output)).ok, true);
    const failed = await runRealEsrgan({ config, inputPath: input, outputPath: path.join(root, "missing-output.png") });
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview source chooses the adopted upscaled rendition", () => {
  const original = { renditionType: "original" as const, id: "original" };
  const upscaled = { renditionType: "upscaled" as const, id: "upscaled" };
  assert.equal(selectPreviewSource([original, upscaled]), upscaled);
});

test("transparent upscale output is retained as PNG unless a flatten policy is explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-alpha-upscale-"));
  try {
    const source = path.join(root, "source", "jacket.png");
    await image(source, "#506070");
    const workspace = await createVersionWorkspace({
      rootPath: path.join(root, "runtime", "update"),
      game: "arcaea",
      baseVersion: "6.16.0",
      targetVersion: "6.17.0",
      sourceManifest: { game: "arcaea", sourceType: "arcaea_apk", sourceSnapshot: "phase6-fixture", candidates: [candidateInput(source, { requiresUpscale: true })] },
    });
    const candidateId = workspace.candidates[0]!.id;
    await confirmCandidateInWorkspace(workspace.rootPath, candidateId);
    const prepared = await prepareUpscaleInputs(workspace.rootPath);
    const inputFilename = prepared.entries[0]!.inputFilename;
    const outputPath = path.join(workspace.rootPath, "upscale-output", `${inputFilename}_optimization.png`);
    await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 160, g: 80, b: 50, alpha: 0.4 } } }).png().toFile(outputPath);
    const reconciled = await reconcileUpscaleOutputs(workspace.rootPath);
    const outputFileId = reconciled.candidates.find((candidate) => candidate.id === candidateId)!.processing.optimizationMatches[0]!.outputFileId;
    await selectUpscaleAttempt(workspace.rootPath, candidateId, outputFileId);
    const converted = await convertSelectedUpscale(workspace.rootPath, candidateId);
    assert.equal(converted.conversion.status, "converted");
    assert.equal(converted.conversion.outputFormat, "png");
    assert.equal(converted.conversion.alphaPolicy, "preserve-png");
    const processed = converted.candidate.files.find((file) => file.role === "processed-upscaled");
    assert.ok(processed?.filename.endsWith(".png"));
    assert.equal(converted.candidate.processing.conversion?.outputPngSha256, processed?.sha256);
    assert.equal((await sharp(path.join(workspace.rootPath, processed!.relativePath)).metadata()).hasAlpha, true);
    await access(outputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upscaled publish keeps an original companion and one shared preview set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase6-publish-upscaled-"));
  try {
    const source = path.join(root, "source", "jacket.png");
    await image(source, "#506070");
    const workspace = await createVersionWorkspace({
      rootPath: path.join(root, "runtime", "update"),
      game: "arcaea",
      baseVersion: "6.16.0",
      targetVersion: "6.17.0",
      sourceManifest: { game: "arcaea", sourceType: "arcaea_apk", sourceSnapshot: "phase6-fixture", candidates: [candidateInput(source, { requiresUpscale: true })] },
    });
    const candidateId = workspace.candidates[0]!.id;
    await confirmCandidateInWorkspace(workspace.rootPath, candidateId);
    const prepared = await prepareUpscaleInputs(workspace.rootPath);
    const inputFilename = prepared.entries[0]!.inputFilename;
    await sharp({ create: { width: 128, height: 128, channels: 3, background: "#a06050" } }).png().toFile(path.join(workspace.rootPath, "upscale-output", `${inputFilename}_optimization.png`));
    const reconciled = await reconcileUpscaleOutputs(workspace.rootPath);
    const reconciledCandidate = reconciled.candidates.find((candidate) => candidate.id === candidateId)!;
    const outputFileId = reconciledCandidate.processing.optimizationMatches[0]!.outputFileId;
    await selectUpscaleAttempt(workspace.rootPath, candidateId, outputFileId);
    await convertSelectedUpscale(workspace.rootPath, candidateId);
    const target = { resourceId: createUuidV7(), variantId: createUuidV7(), renditionId: createUuidV7(), sourceRenditionId: createUuidV7() };
    await finalizeWorkspaceCandidate(workspace.rootPath, candidateId, { target, metadataValid: true });
    const state = await loadWorkspaceState(workspace.rootPath);
    const catalog = createEmptyCatalog();
    const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, catalog, workspaceRoot: workspace.rootPath });
    assert.equal(manifest.publishedRenditions.length, 2);
    const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog, releaseManifest: manifest, workspaceRoot: workspace.rootPath });
    const storage = new MemoryStorageClient();
    const published = await executePublishPlan({ batch: state.batch, candidates: state.candidates, catalog, manifest, plan, workspaceRoot: workspace.rootPath, storage, catalogPath: path.join(root, "catalog", "index.json"), releasesDirectory: path.join(root, "catalog", "releases") });
    const variantRenditions = published.catalog.renditions.filter((rendition) => rendition.variantId === target.variantId);
    assert.equal(variantRenditions.find((rendition) => rendition.id === target.renditionId)?.renditionType, "upscaled");
    assert.equal(variantRenditions.find((rendition) => rendition.id === target.sourceRenditionId)?.renditionType, "original");
    assert.equal(variantRenditions.filter((rendition) => rendition.renditionType.startsWith("thumbnail-")).length, 3);
    assert.ok(variantRenditions.filter((rendition) => rendition.renditionType.startsWith("thumbnail-")).every((rendition) => rendition.sourceRenditionId === target.renditionId || rendition.sourceRenditionId === target.sourceRenditionId));
    const rerunManifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, catalog: published.catalog, workspaceRoot: workspace.rootPath });
    const rerunPlan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog: published.catalog, releaseManifest: rerunManifest, workspaceRoot: workspace.rootPath });
    assert.equal(rerunPlan.objectsToCreate.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
