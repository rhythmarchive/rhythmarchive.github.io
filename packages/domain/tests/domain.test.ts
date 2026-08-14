import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Candidate,
  convertOptimizationPngToJpeg,
  createUuidV7,
  ensureWorkspaceLayout,
  immutableObjectKey,
  inspectImageAlpha,
  isOptimizationFilename,
  matchOptimizationOutputs,
  normalizeFilenameStem,
  objectIdFromSha256,
  renameCandidate,
  transitionCandidate,
  validateCandidate,
  validateCandidateManifest,
  validateCatalog,
  validateObject,
  validatePublishPlan,
  validatePublishPlanConsistency,
  validateReleaseManifest,
  validateReleaseManifestConsistency,
  validateRendition,
  validateResource,
  validateUpdateBatch,
  validateVariant,
  writeBatchManifest,
  type Candidate as CandidateType,
} from "../src/index.js";

const fixtureRoot = path.resolve("fixtures", "phase2a");

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), "utf8")) as T;
}

test("all primary schemas accept the valid JSON fixtures", async () => {
  assert.equal(validateResource(await fixture("valid-resource.json")).success, true);
  const catalog = await fixture("valid-catalog.json");
  assert.equal(validateCatalog(catalog).success, true);
  assert.equal(validateVariant((catalog as { variants: unknown[] }).variants[0]).success, true);
  assert.equal(validateRendition((catalog as { renditions: unknown[] }).renditions[0]).success, true);
  assert.equal(validateObject((catalog as { objects: unknown[] }).objects[0]).success, true);
  assert.equal(validateUpdateBatch(await fixture("valid-update-batch.json")).success, true);
  assert.equal(validateCandidate(await fixture("valid-candidate.json")).success, true);
  assert.equal(validateCandidateManifest(await fixture("valid-candidate-manifest.json")).success, true);
  assert.equal(validateReleaseManifest(await fixture("valid-release-manifest.json")).success, true);
  assert.equal(validatePublishPlan(await fixture("valid-publish-plan.json")).success, true);
});

test("invalid fixtures fail at runtime validation", async () => {
  const resource = validateResource(await fixture("invalid-resource.json"));
  assert.equal(resource.success, false);
  if (!resource.success) assert.ok(resource.issues.length >= 3);
  const plan = validatePublishPlan(await fixture("invalid-publish-plan.json"));
  assert.equal(plan.success, false);
});

test("UUIDv7 and Object identities are opaque and independent of filenames", () => {
  const id = createUuidV7(0x0198a8de0000);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const digest = "a".repeat(64);
  assert.equal(objectIdFromSha256(digest), `sha256:${digest}`);
  assert.equal(immutableObjectKey(digest, ".JPG"), `objects/${digest}/jpg`);
  assert.throws(() => immutableObjectKey(digest, "../jpg"));
  assert.notEqual(id, "Acid God.jpg");
});

test("human rename preserves Candidate identity and leaves an alias for matching", async () => {
  const original = (await fixture("valid-candidate.json")) as CandidateType;
  const parsed = Candidate.parse(original);
  const renamed = renameCandidate(parsed, "Testify Reviewed.jpg");
  assert.equal(renamed.id, original.id);
  assert.equal(renamed.naming.reviewedFilename, "Testify Reviewed.jpg");
  assert.equal(renamed.naming.finalFilename, original.naming.finalFilename, "review rename must not finalize the filename");
  assert.ok(renamed.naming.knownBasenames.includes("Testify.jpg"));
  assert.equal(renameCandidate(original, "Testify Approved.jpg", { finalize: true }).naming.finalFilename, "Testify Approved.jpg");
  const matched = matchOptimizationOutputs(renamed ? [renamed] : [], [{
    id: "0198a8de-0000-7000-8000-000000005104",
    filename: "Testify Reviewed_optimization.png",
    relativePath: "upscale-output/Testify Reviewed_optimization.png",
  }]);
  assert.equal(matched[0]?.state, "matched");
  assert.deepEqual(matched[0]?.candidateIds, [original.id]);
});

test("optimization matching exposes ambiguous and unmatched outputs instead of guessing", async () => {
  const candidate = Candidate.parse(await fixture("valid-candidate.json"));
  const second = { ...candidate, id: "0198a8de-0000-7000-8000-000000005002" } as CandidateType;
  const outputs = [
    { id: "0198a8de-0000-7000-8000-000000005201", filename: "Testify Final_optimization.png", relativePath: "upscale-output/a/Testify Final_optimization.png" },
    { id: "0198a8de-0000-7000-8000-000000005202", filename: "Unknown_optimization.png", relativePath: "upscale-output/Unknown_optimization.png" },
  ];
  const results = matchOptimizationOutputs([candidate, second], outputs);
  assert.equal(results[0]?.state, "ambiguous");
  assert.equal(results[0]?.candidateIds.length, 2);
  assert.equal(results[1]?.state, "unmatched");
  const explicit = matchOptimizationOutputs([candidate], [{ ...outputs[1]!, filename: "ExternallyRenamed_optimization.png", manifestCandidateId: candidate.id }]);
  assert.equal(explicit[0]?.state, "matched");
  assert.equal(explicit[0]?.matchedBy, "manifest");
  const nonOptimization = matchOptimizationOutputs([candidate], [{ ...outputs[1]!, filename: "ExternallyRenamed.png" }]);
  assert.equal(nonOptimization[0]?.state, "unmatched");
  const duplicateOutputs = matchOptimizationOutputs([candidate], [outputs[0]!, { ...outputs[0]!, id: "0198a8de-0000-7000-8000-000000005203" }]);
  assert.equal(duplicateOutputs.length, 2, "multiple optimization attempts remain visible for manual selection");
  assert.deepEqual(duplicateOutputs.map((item) => item.candidateIds), [[candidate.id], [candidate.id]]);
  const currentAliasCandidate = candidate;
  const historicalAliasCandidate = {
    ...candidate,
    id: "0198a8de-0000-7000-8000-000000005003",
    naming: { ...candidate.naming, reviewedFilename: "Other Reviewed.jpg", finalFilename: "Other Final.jpg", knownBasenames: ["Testify Final.jpg"] },
    files: candidate.files.map((file) => ({ ...file, candidateId: "0198a8de-0000-7000-8000-000000005003", filename: "Other Final.jpg" })),
  } as CandidateType;
  const priority = matchOptimizationOutputs([currentAliasCandidate, historicalAliasCandidate], [{ ...outputs[0]!, filename: "Testify Final_optimization.png" }]);
  assert.deepEqual(priority[0]?.candidateIds, [candidate.id], "current reviewed/final basename outranks another Candidate's historical alias");
});

test("real high-risk fixture records preserve unresolved and multi-variant semantics", async () => {
  const cases = await fixture<{ cases: Array<Record<string, unknown>> }>("real-cases.json");
  const tripleCases = cases.cases.filter((item) => item.kind === "three-visual-variants");
  assert.ok(tripleCases.length >= 2);
  const unresolved = cases.cases.find((item) => item.id === "arcaea-asgore-256-unresolved");
  assert.equal(unresolved?.semanticStatus, "unresolved");
  const phigros = cases.cases.find((item) => item.id === "phigros-risk-cases");
  assert.equal((phigros?.examples as Array<{ metadata?: { artist?: unknown } }>)[0]?.metadata?.artist, null);
});

test("same Object can be referenced by different semantic Resources", async () => {
  const catalog = (await fixture("valid-catalog.json")) as { resources: Array<{ id: string }>; renditions: Array<{ objectId: string; variantId: string }> };
  const shared = catalog.renditions.filter((rendition) => rendition.objectId === "sha256:20f0801520c91d418516d2be942511554a2d3e2ebe495e97068be826a2bd2636");
  assert.equal(shared.length, 2);
  assert.notEqual(catalog.resources[1]?.id, catalog.resources[2]?.id);
});

test("Catalog, ReleaseManifest and PublishPlan cross-reference validators enforce publication boundaries", async () => {
  const catalog = await fixture("valid-catalog.json");
  assert.equal(validateCatalog(catalog).success, true);
  assert.equal(validateReleaseManifestConsistency(await fixture("valid-release-manifest.json"), catalog).success, true);
  assert.equal(validatePublishPlanConsistency(await fixture("valid-publish-plan.json"), catalog).success, true);

  const catalogWithLocalPath = structuredClone(catalog) as { resources: Array<{ provenance: Array<{ sourceRelativePath: string }> }> };
  catalogWithLocalPath.resources[0]!.provenance[0]!.sourceRelativePath = "E:\\曲绘\\secret.jpg";
  assert.equal(validateCatalog(catalogWithLocalPath).success, false);

  const plan = structuredClone(await fixture("valid-publish-plan.json")) as { catalogMutations: Array<{ objectId?: string }> };
  plan.catalogMutations[0]!.objectId = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  assert.equal(validatePublishPlanConsistency(plan, catalog).success, false);

  const invalidDerivedSource = structuredClone(catalog) as { renditions: Array<{ id: string; renditionType: string; sourceRenditionId?: string }> };
  const upscaled = invalidDerivedSource.renditions.find((rendition) => rendition.renditionType === "upscaled");
  assert.ok(upscaled);
  upscaled.sourceRenditionId = upscaled.id;
  assert.equal(validateCatalog(invalidDerivedSource).success, false, "upscaled rendition cannot derive from another upscaled rendition");
});

test("candidate and batch state machines keep review, processing and publication stages explicit", async () => {
  const candidate = Candidate.parse(await fixture("valid-candidate.json"));
  assert.equal(transitionCandidate({ ...candidate, status: "EXTRACTED" }, "NAMING_REVIEW").status, "NAMING_REVIEW");
  assert.throws(() => transitionCandidate({ ...candidate, status: "EXTRACTED" }, "READY"));
  const pendingCandidate = structuredClone(candidate) as CandidateType;
  pendingCandidate.processing.state = "upscale-pending";
  delete pendingCandidate.processing.processedFileId;
  delete pendingCandidate.processing.conversion;
  assert.throws(() => transitionCandidate({ ...pendingCandidate, status: "NAMING_REVIEW" }, "FINAL_REVIEW"), /complete conversion/);
  assert.equal(candidate.processing.state, "ready");
  assert.equal(candidate.processing.conversion?.sourcePngRetained, true);
});

test("workspace helper creates a real browsable version workspace and an atomic batch manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-assets-gallery-v2-phase2a-"));
  try {
    await ensureWorkspaceLayout(root);
    for (const directory of ["raw", "work", "upscale-input", "upscale-output", "processed", "metadata"]) {
      assert.equal((await stat(path.join(root, directory))).isDirectory(), true);
    }
    const batch = await fixture("valid-update-batch.json");
    const manifestPath = await writeBatchManifest(root, batch);
    assert.equal((await stat(manifestPath)).isFile(), true);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), batch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filename normalization covers current and historical optimization suffixes", () => {
  assert.equal(isOptimizationFilename("Testify_optimization.png"), true);
  assert.equal(isOptimizationFilename("Testify_opt.jpg"), true);
  assert.equal(isOptimizationFilename("Testify.jpg_opt.jpg"), true);
  assert.equal(normalizeFilenameStem("Testify_optimization.png"), "testify");
  assert.equal(normalizeFilenameStem("Testify.jpg_opt.jpg"), "testify");
  assert.equal(normalizeFilenameStem("Testify_opt.jpg"), "testify");
  assert.equal(normalizeFilenameStem("Testify.jpeg_opt.jpg"), "testify");
  assert.equal(normalizeFilenameStem("Testify.png_opt.png"), "testify");
});

test("JPEG conversion is non-destructive and alpha requires an explicit policy", async () => {
  const imageDir = path.resolve("fixtures", "phase2a", "images");
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-assets-gallery-v2-conversion-"));
  try {
    const input = path.join(imageDir, "Acid God_optimization.png");
    const output = path.join(root, "processed", "Acid God.jpg");
    const result = await convertOptimizationPngToJpeg({ inputPath: input, outputPath: output, conversion: { quality: 95 } });
    assert.equal(result.status, "converted");
    assert.equal(result.renditionType, "upscaled");
    assert.equal(result.sourcePngRetained, true);
    assert.equal((await stat(input)).isFile(), true);
    assert.equal((await stat(output)).isFile(), true);
    const skipped = await convertOptimizationPngToJpeg({ inputPath: input, outputPath: output });
    assert.equal(skipped.status, "skipped");

    const invalidOutput = path.join(root, "processed", "invalid.jpg");
    await writeFile(invalidOutput, "not a jpeg", "utf8");
    const invalidExisting = await convertOptimizationPngToJpeg({ inputPath: input, outputPath: invalidOutput });
    assert.equal(invalidExisting.status, "failed");
    assert.equal((await stat(input)).isFile(), true);

    const transparent = path.join(imageDir, "Transparent_optimization.png");
    const alpha = await inspectImageAlpha(transparent);
    assert.equal(alpha.hasActualTransparency, true);
    const blocked = await convertOptimizationPngToJpeg({ inputPath: transparent, outputPath: path.join(root, "processed", "blocked.jpg") });
    assert.equal(blocked.status, "blocked");
    const flattened = await convertOptimizationPngToJpeg({ inputPath: transparent, outputPath: path.join(root, "processed", "flattened.jpg"), conversion: { alphaPolicy: "flatten-white" } });
    assert.equal(flattened.status, "converted");
    assert.equal(flattened.sourcePngRetained, true);
    const samePath = await convertOptimizationPngToJpeg({ inputPath: input, outputPath: input, overwrite: true });
    assert.equal(samePath.status, "failed");
    assert.equal((await stat(input)).isFile(), true, "same-path rejection must retain the source PNG");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
