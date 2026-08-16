import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  MemoryStorageClient,
  S3StorageClient,
  createEmptyCatalog,
  createPublishPlanDryRun,
  createReleaseManifestDraft,
  createUuidV7,
  createVersionWorkspace,
  executePublishPlan,
  finalizeWorkspaceCandidate,
  fullLegacyMigrationAllowed,
  loadRosStorageConfig,
  loadWorkspaceState,
  rosStorageStatus,
  runRosCanary,
  scanLegacyAssets,
  selectPreviewSource,
  validateRendition,
  applyReviewPolicy,
  isUpscaleEligible,
  confirmCandidateInWorkspace,
} from "../src/index.js";

async function image(filePath: string, color = "#5060a0"): Promise<void> {
  await sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function readyWorkspace(root: string) {
  const sourcePath = path.join(root, "source", "Testify.jpg");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(sourcePath), { recursive: true }));
  await image(sourcePath);
  const workspaceRoot = path.join(root, "runtime", "arcaea", "6.17.0");
  const workspace = await createVersionWorkspace({
    rootPath: workspaceRoot,
    game: "arcaea",
    baseVersion: "6.16.0",
    targetVersion: "6.17.0",
    sourceManifest: {
      game: "arcaea",
      sourceType: "arcaea_apk",
      sourceSnapshot: "phase4-test",
      extractorVersion: "phase4-test",
      candidates: [{
        sourcePath,
        sourceRelativePath: "songs/testify/1080_base.jpg",
        sourceFilename: "Testify.jpg",
        sourceGameVersion: "6.17.0",
        detection: "added",
        evidence: [{ kind: "apk-relative-path", detail: "songs/testify/1080_base.jpg", confidence: "high" }],
        mappingEvidence: [{ kind: "metadata", detail: "test metadata", confidence: "high" }],
        suggestedFilename: "Testify.jpg",
        resourceType: "jacket",
        title: "Testify",
        variantKey: "default",
        variantKind: "default",
        metadata: { artist: "void" },
        externalIdentities: [],
        confidence: "high",
        reviewRequirements: { reviewRequired: true, manualNamingRequired: false, metadataReviewRequired: false, identityReviewRequired: false, upscaleRecommended: false, upscaleRequired: false, reasons: [] },
        requiresUpscale: false,
      }],
    },
  });
  const candidateId = workspace.candidates[0]!.id;
  await confirmCandidateInWorkspace(workspaceRoot, candidateId);
  await finalizeWorkspaceCandidate(workspaceRoot, candidateId, { target: { resourceId: createUuidV7(), variantId: createUuidV7(), renditionId: createUuidV7() }, metadataValid: true });
  return { workspaceRoot, state: await loadWorkspaceState(workspaceRoot) };
}

test("ROS config is safe and not-configured storage never exposes credentials", async () => {
  const config = loadRosStorageConfig({ ROS_ACCESS_KEY: "ak-test", ROS_SECRET_KEY: "sk-test" });
  const publicStatus = rosStorageStatus(config);
  assert.equal(publicStatus.configured, true);
  assert.equal("accessKey" in publicStatus, false);
  assert.equal("secretKey" in publicStatus, false);
  const storage = new S3StorageClient(loadRosStorageConfig({}));
  assert.equal(storage.status, "NOT_CONFIGURED");
  await assert.rejects(() => storage.objectExists("objects/" + "a".repeat(64) + "/jpg"), /NOT_CONFIGURED|not configured/u);
});

test("memory storage uses immutable cache metadata and duplicate object checks", async () => {
  const storage = new MemoryStorageClient();
  const objectKey = `objects/${"a".repeat(64)}/jpg`;
  await storage.putObject({ objectKey, body: new Uint8Array([1, 2, 3]), sizeBytes: 3, contentType: "image/jpeg" });
  assert.equal(await storage.objectExists(objectKey), true);
  const head = await storage.headObject(objectKey);
  assert.equal(head.cacheControl, "public, max-age=31536000, immutable");
  assert.equal((await storage.verifyObject(objectKey, { sizeBytes: 3 })).verified, true);
});

test("publish uploads only missing objects and writes Catalog after successful verification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase4-publish-"));
  try {
    const { workspaceRoot, state } = await readyWorkspace(root);
    const catalog = createEmptyCatalog();
    const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, catalog, workspaceRoot });
    const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog, releaseManifest: manifest, workspaceRoot });
    const storage = new MemoryStorageClient();
    const catalogPath = path.join(root, "catalog", "index.json");
    const first = await executePublishPlan({ plan, manifest, batch: state.batch, candidates: state.candidates, catalog, workspaceRoot, storage, catalogPath, releasesDirectory: path.join(root, "catalog", "releases") });
    assert.equal(first.uploadedObjectKeys.length, plan.objectsToCreate.length);
    assert.equal(first.skippedObjectKeys.length, 0);
    assert.equal(first.catalog.objects.length, plan.objectsToCreate.length);
    assert.equal(first.releaseManifest.status, "published");
    assert.equal((await stat(catalogPath)).isFile(), true);
    assert.equal((await stat(path.join(root, "catalog", "releases", `${first.releaseManifest.id}.json`))).isFile(), true);
    const second = await executePublishPlan({ plan, manifest, batch: state.batch, candidates: state.candidates, catalog, workspaceRoot, storage, catalogPath, releasesDirectory: path.join(root, "catalog", "releases") });
    assert.equal(second.uploadedObjectKeys.length, 0);
    assert.equal(second.skippedObjectKeys.length, plan.objectsToCreate.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish failure keeps Catalog absent and leaves workspace available for retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase4-publish-fail-"));
  try {
    const { workspaceRoot, state } = await readyWorkspace(root);
    const catalog = createEmptyCatalog();
    const manifest = await createReleaseManifestDraft({ batch: state.batch, candidates: state.candidates, catalog, workspaceRoot });
    const plan = await createPublishPlanDryRun({ batch: state.batch, candidates: state.candidates, catalog, releaseManifest: manifest, workspaceRoot });
    const catalogPath = path.join(root, "catalog", "index.json");
    const storage = new MemoryStorageClient();
    storage.failOnPutNumber = 1;
    await assert.rejects(() => executePublishPlan({ plan, manifest, batch: state.batch, candidates: state.candidates, catalog, workspaceRoot, storage, catalogPath }), /upload failed|ROS/u);
    await assert.rejects(() => access(catalogPath));
    assert.equal((await stat(path.join(workspaceRoot, "metadata", "batch.json"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Legacy dry-run pairs Arcaea original and AI without modifying the source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase4-legacy-"));
  try {
    const original = path.join(root, "Arcaea", "曲绘", "Testify.jpg");
    const ai = path.join(root, "Arcaea", "曲绘（AI超分后）", "Testify.jpg");
    const avatar = path.join(root, "Phigros", "头像", "Avatar.png");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(original), { recursive: true }));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(ai), { recursive: true }));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(avatar), { recursive: true }));
    await image(original, "#5060a0");
    await image(ai, "#a06050");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#202020" } }).png().toFile(avatar);
    const before = await readFile(original);
    const plan = await scanLegacyAssets({ sourceRoot: root, now: "2026-08-14T00:00:00.000Z" });
    assert.equal(plan.readOnly, true);
    assert.equal(plan.stats.fileCount, 3);
    assert.equal(plan.stats.sourceFileCount, 2);
    assert.equal(plan.stats.upscaledCount, 1);
    assert.equal(plan.stats.thumbnailCount, 6);
    assert.equal(plan.stats.thumbnailCount, plan.proposals.length * 3);
    assert.equal(plan.stats.estimatedRosObjectCount, new Set(plan.files.map((file) => file.sha256).filter((value): value is string => Boolean(value))).size + plan.stats.thumbnailCount);
    assert.equal(plan.proposals.some((proposal) => proposal.original === "Arcaea/曲绘/Testify.jpg" && proposal.upscaled === "Arcaea/曲绘（AI超分后）/Testify.jpg"), true);
    assert.deepEqual(await readFile(original), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview source prefers upscaled and previews are not download renditions", () => {
  const original = { renditionType: "original" as const, sourceRelativePath: "original.jpg" };
  const upscaled = { renditionType: "upscaled" as const, sourceRelativePath: "upscaled.jpg" };
  assert.equal(selectPreviewSource([original, upscaled]), upscaled);
  assert.equal(selectPreviewSource([original]), original);
  assert.equal(selectPreviewSource([{ renditionType: "unresolved" as const }]), undefined);
  const preview = validateRendition({
    schemaVersion: "1.0",
    catalogSchemaVersion: "1.0",
    id: createUuidV7(),
    variantId: createUuidV7(),
    renditionType: "thumbnail-320",
    origin: "derived",
    publishable: false,
    objectId: `sha256:${"a".repeat(64)}`,
    downloadFilename: "320.webp",
    generatedBy: "thumbnailer",
    createdAt: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(preview.success, true);
  assert.equal(validateRendition({
    schemaVersion: "1.0",
    catalogSchemaVersion: "1.0",
    id: createUuidV7(),
    variantId: createUuidV7(),
    renditionType: "thumbnail-320",
    origin: "derived",
    publishable: true,
    objectId: `sha256:${"b".repeat(64)}`,
    downloadFilename: "320.webp",
    generatedBy: "thumbnailer",
    createdAt: "2026-08-14T00:00:00.000Z",
  }).success, false);
});

test("Legacy dry-run separates blocking issues from migration warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase4-legacy-issues-"));
  try {
    const assets = [
      [path.join(root, "Arcaea", "剧情", "a", "bg.jpg"), "#5060a0"],
      [path.join(root, "Arcaea", "剧情", "b", "bg.jpg"), "#a06050"],
      [path.join(root, "Arcaea", "曲绘", "Warning_2.jpg"), "#5060a0"],
      [path.join(root, "Phigros", "曲绘", "NoArtist.jpg"), "#a06050"],
      [path.join(root, "Arcaea", "曲绘", "foo_256.jpg"), "#6050a0"],
    ] as const;
    for (const [filePath, color] of assets) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
      await image(filePath, color);
    }
    const optimizationPath = path.join(root, "Arcaea", "剧情", "needs_optimization.png");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(optimizationPath), { recursive: true }));
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#205020" } }).png().toFile(optimizationPath);

    const plan = await scanLegacyAssets({ sourceRoot: root, now: "2026-08-14T00:00:00.000Z" });
    assert.equal("issues" in plan, false);
    assert.equal(plan.stats.sourceFileCount, plan.files.filter((file) => file.renditionType !== "upscaled").length);
    assert.equal(plan.stats.blockingIssueCount, plan.blockingIssues.length);
    assert.equal(plan.stats.warningCount, plan.warnings.length);
    assert.equal(plan.blockingIssues.some((issue) => issue.code === "PAIR_AMBIGUOUS"), true);
    assert.equal(plan.blockingIssues.some((issue) => issue.code === "OPTIMIZATION_PNG_REQUIRES_CONVERSION"), true);
    assert.equal(plan.warnings.some((issue) => issue.code === "PHIGROS_METADATA_WARNING"), true);
    assert.equal(plan.warnings.some((issue) => issue.code === "SPECIAL_DIFFICULTY_WARNING"), true);
    assert.equal(plan.warnings.some((issue) => issue.code === "UNRESOLVED_256_WARNING"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Legacy difficulty suffix only applies to Arcaea jacket resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase4-legacy-difficulty-"));
  try {
    const suffixes = [0, 1, 2, 3, 4] as const;
    for (const suffix of suffixes) {
      const files = [
        path.join(root, "Arcaea", "剧情", "lephon", `story_${suffix}.jpg`),
        path.join(root, "Arcaea", "曲包封面", `pack_${suffix}.jpg`),
        path.join(root, "Arcaea", "曲绘", `Song_${suffix}.jpg`),
      ];
      for (const filePath of files) {
        await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
        await image(filePath, `#${suffix}${suffix}${suffix}000`);
      }
    }
    const plan = await scanLegacyAssets({ sourceRoot: root, now: "2026-08-14T00:00:00.000Z" });
    const storyFiles = plan.files.filter((file) => file.sourceRelativePath.includes("/剧情/"));
    const packFiles = plan.files.filter((file) => file.sourceRelativePath.includes("/曲包封面/"));
    const jacketFiles = plan.files.filter((file) => file.sourceRelativePath.includes("/曲绘/") && !file.sourceRelativePath.includes("曲绘（AI超分后）"));
    assert.equal(storyFiles.every((file) => file.difficulty === undefined), true);
    assert.equal(packFiles.every((file) => file.difficulty === undefined), true);
    assert.deepEqual(jacketFiles.map((file) => file.difficulty), ["PST", "PRS", "FTR", "BYD", "ETR"]);
    assert.equal(plan.warnings.some((issue) => issue.code === "SPECIAL_DIFFICULTY_WARNING" && issue.sourceRelativePath?.includes("/剧情/")), false);
    assert.equal(plan.warnings.some((issue) => issue.code === "SPECIAL_DIFFICULTY_WARNING" && issue.sourceRelativePath?.includes("/曲包封面/")), false);
    assert.equal(plan.warnings.filter((issue) => issue.code === "SPECIAL_DIFFICULTY_WARNING" && issue.sourceRelativePath?.includes("/曲绘/")).length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first migration keeps curated Arcaea jackets and current APK non-jackets separate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase4-migration-boundary-"));
  try {
    const jacket = path.join(root, "Arcaea", "曲绘", "Curated.jpg");
    const upscaled = path.join(root, "Arcaea", "曲绘（AI超分后）", "Curated.jpg_opt.jpg");
    const historicalStory = path.join(root, "Arcaea", "剧情", "20-6.jpg");
    const phigros = path.join(root, "Phigros", "曲绘", "Legacy.jpg");
    const currentStory = path.join(root, "current-apk", "story.jpg");
    for (const filePath of [jacket, upscaled, historicalStory, phigros, currentStory]) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
      await image(filePath, filePath === currentStory ? "#205020" : "#5060a0");
    }
    const plan = await scanLegacyAssets({
      sourceRoot: root,
      fileFilter: (item) => /^Arcaea\/(?:曲绘|曲绘（AI超分后）)\//u.test(item.relativePath) || /^Phigros\//u.test(item.relativePath),
      sourceResolver: (_item, classification) => classification.game === "arcaea" ? "legacy-curated" : "legacy",
      additionalFiles: [{
        absolutePath: currentStory,
        sourceRelativePath: "Arcaea/current-apk/app-data/story/cg/story.jpg",
        sourceFilename: "story.jpg",
        source: "current-apk",
        game: "arcaea",
        resourceType: "story-cg",
        category: "story-cg",
        renditionType: "original",
      }],
    });
    assert.equal(plan.files.some((file) => file.sourceRelativePath.includes("Arcaea/剧情")), false);
    assert.equal(plan.files.some((file) => file.sourceRelativePath === "Arcaea/current-apk/app-data/story/cg/story.jpg"), true);
    assert.equal(plan.files.some((file) => file.source === "legacy-curated" && file.renditionType === "upscaled"), true);
    assert.equal(plan.proposals.some((proposal) => proposal.source === "current-apk" && proposal.resourceType === "story-cg"), true);
    assert.equal(plan.blockingIssues.length, 0);
    assert.equal(plan.blockingIssues.some((issue) => issue.code === "OPTIMIZATION_PNG_REQUIRES_CONVERSION" || issue.code === "UNSAFE_UPSCALE_PAIR" || issue.code === "PAIR_AMBIGUOUS"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Arcaea upscale policy only permits jacket resources", () => {
  assert.equal(isUpscaleEligible("arcaea", "jacket"), true);
  assert.equal(applyReviewPolicy({ game: "arcaea", resourceType: "jacket", confidence: "high", suggestedTitle: "Song", suggestedFilename: "Song.jpg" }).upscaleRecommended, true);
  for (const resourceType of ["story-cg", "character-portrait", "pack-cover", "background"] as const) {
    assert.equal(isUpscaleEligible("arcaea", resourceType), false);
    assert.equal(applyReviewPolicy({ game: "arcaea", resourceType, confidence: "high", suggestedTitle: "Asset", suggestedFilename: "Asset.jpg" }).upscaleRecommended, false);
  }
  assert.equal(isUpscaleEligible("phigros", "jacket"), false);
  assert.equal(applyReviewPolicy({ game: "phigros", resourceType: "jacket", confidence: "high", suggestedTitle: "Song", suggestedArtist: "Artist", suggestedFilename: "Song.jpg" }).upscaleRecommended, false);
});

test("full Legacy migration is disabled unless explicitly enabled", () => {
  assert.equal(fullLegacyMigrationAllowed({ ALLOW_FULL_LEGACY_MIGRATION: "0" }), false);
  assert.equal(fullLegacyMigrationAllowed({ ALLOW_FULL_LEGACY_MIGRATION: "1" }), true);
});

test("ROS canary stops cleanly before credentials are configured", async () => {
  const storage = new S3StorageClient(loadRosStorageConfig({}));
  const result = await runRosCanary({ storage, samples: [] });
  assert.equal(result.status, "NOT_CONFIGURED");
  assert.equal(result.code, "ROS_NOT_CONFIGURED");
});

test("ROS canary can use a synthetic sample and clean only its canary object", async () => {
  const storage = new MemoryStorageClient();
  const objectKey = "_canary/phase4-test.webp";
  const body = new Uint8Array([1, 2, 3, 4]);
  const result = await runRosCanary({
    storage,
    samples: [{ objectKey, sizeBytes: body.byteLength, mime: "image/webp", body, publicRead: true }],
    cacheControl: "public, max-age=31536000, immutable",
    cleanupAfter: true,
    corsOrigin: "https://example.com",
    publicFetch: async () => ({ ok: true, status: 200, headers: new Headers({ "access-control-allow-origin": "https://example.com" }) }),
    rangeFetch: async () => ({ ok: true, status: 206, headers: new Headers({ "content-range": "bytes 0-3/4" }) }),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.put, 1);
  assert.equal(result.head, 1);
  assert.equal(result.contentLength, "OK");
  assert.equal(result.cacheControl, "OK");
  assert.equal(result.publicRead, 1);
  assert.equal(result.range, "AVAILABLE");
  assert.equal(result.cors, "AVAILABLE");
  assert.equal(result.duplicateCheck, "OK");
  assert.equal(result.cleanup, "OK");
  assert.equal(storage.objects.has(objectKey), false);
});
