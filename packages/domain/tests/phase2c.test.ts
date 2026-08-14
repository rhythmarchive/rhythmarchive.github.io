import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import {
  ExtractorResult,
  adaptArcaeaLegacyReport,
  adaptPhigrosLegacyReport,
  applyReviewPolicy,
  confirmCandidateInWorkspace,
  createUuidV7,
  createWorkspaceFromExtractorResult,
  finalizeWorkspaceCandidate,
  loadWorkspaceState,
  overrideCandidateFilenameInWorkspace,
  overrideCandidateMetadataInWorkspace,
  resolveCandidateIdentityInWorkspace,
  type ExtractorCandidate,
} from "../src/index.js";

async function image(filePath: string, color = "#234567"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 96, height: 96, channels: 3, background: color } }).png().toFile(filePath);
}

function apk(root: string, role: "base" | "target", version: string) {
  return { role, version, filename: `${role}-${version}.apk`, absolutePath: path.join(root, `${role}-${version}.apk`), verification: "unverified" as const };
}

function candidate(root: string, game: "arcaea" | "phigros", options: { filename: string; sourceRelativePath: string; title?: string; artist?: string; confidence: "high" | "medium" | "low" | "unknown"; identityExact?: boolean; identityAmbiguous?: boolean; resourceType?: "jacket" | "character-avatar" } ): ExtractorCandidate {
  const sourcePath = path.join(root, options.filename);
  const requirements = applyReviewPolicy({
    game,
    resourceType: options.resourceType ?? "jacket",
    confidence: options.confidence,
    suggestedFilename: options.filename,
    suggestedTitle: options.title,
    suggestedArtist: options.artist,
    identityExact: options.identityExact,
    identityAmbiguous: options.identityAmbiguous,
    metadataComplete: Boolean(options.title && options.artist),
  });
  const evidence = [{ kind: "apk-relative-path" as const, detail: options.sourceRelativePath, confidence: options.confidence }];
  return ExtractorResult.shape.candidates.element.parse({
    id: createUuidV7(),
    sourcePath,
    sourceRelativePath: options.sourceRelativePath,
    sourceFilename: options.filename,
    sourceApkVersion: "2.0.0",
    suggestedFilename: options.filename,
    ...(options.title ? { suggestedTitle: options.title } : {}),
    ...(options.artist ? { suggestedArtist: options.artist } : {}),
    suggestedCategory: options.resourceType ?? "jacket",
    suggestedVariant: { key: "default", kind: "default", unresolved: [] },
    suggestedExternalIdentity: options.identityExact ? [{ namespace: game, key: game === "arcaea" ? "songId" : "addressablesKey", value: options.sourceRelativePath, source: game === "arcaea" ? "apk-metadata" : "phigros-key", confidence: "high" }] : [],
    metadata: options.artist ? { artist: options.artist } : {},
    confidence: options.confidence,
    evidence,
    reviewRequirements: requirements,
    requiresUpscale: false,
    ...(requirements.identityReviewRequired ? { initialStatus: "BLOCKED" as const, blockedReason: "identity is ambiguous" } : {}),
    provenance: {
      baseVersion: "1.0.0",
      targetVersion: "2.0.0",
      sourceApkVersion: "2.0.0",
      apkInternalRelativePath: options.sourceRelativePath,
      metadataSource: "fixture metadata",
      originalFilename: options.filename,
      mappingEvidence: evidence,
    },
  });
}

async function result(root: string, game: "arcaea" | "phigros", items: ExtractorCandidate[]) {
  return ExtractorResult.parse({
    status: "ok",
    game,
    sourceType: game === "arcaea" ? "arcaea_apk" : "phigros_apk",
    baseVersion: "1.0.0",
    targetVersion: "2.0.0",
    baseApk: apk(root, "base", "1.0.0"),
    targetApk: apk(root, "target", "2.0.0"),
    sourceSnapshot: "fixture-old-new",
    extractorVersion: "phase2c-fixture",
    candidates: items,
  });
}

test("high-confidence Arcaea requires confirmation but not a filename edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase2c-arcaea-confirm-"));
  try {
    const sourcePath = path.join(root, "Testify.jpg");
    await image(sourcePath);
    const extracted = await result(root, "arcaea", [candidate(root, "arcaea", { filename: "Testify.jpg", sourceRelativePath: "songs/testify/1080_base.jpg", title: "Testify", artist: "Void", confidence: "high", identityExact: true })]);
    const workspace = await createWorkspaceFromExtractorResult(extracted, { rootPath: path.join(root, "workspace") });
    const id = workspace.candidates[0]!.id;
    assert.equal(workspace.candidates[0]!.reviewRequirements.reviewRequired, true);
    assert.equal(workspace.candidates[0]!.reviewRequirements.manualNamingRequired, false);
    const confirmed = await confirmCandidateInWorkspace(workspace.rootPath, id, { now: "2026-08-14T00:00:00Z" });
    assert.equal(confirmed.review.confirmed, true);
    assert.equal(confirmed.naming.reviewedFilename, undefined);
    assert.equal(confirmed.naming.finalFilename, undefined);
    const stateAfterConfirm = await loadWorkspaceState(workspace.rootPath);
    assert.equal(stateAfterConfirm.reviewLog.events.some((event) => event.type === "manual-rename" && event.candidateId === id), false);
    const ready = await finalizeWorkspaceCandidate(workspace.rootPath, id, { target: { resourceId: createUuidV7(), variantId: createUuidV7(), renditionId: createUuidV7() }, metadataValid: true });
    assert.equal(ready.status, "READY");
    assert.equal(ready.naming.finalFilename, "Testify.jpg");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit filename and metadata overrides are distinct from confirmation and retain provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase2c-overrides-"));
  try {
    const sourcePath = path.join(root, "internal.png");
    await image(sourcePath, "#567123");
    const extracted = await result(root, "phigros", [candidate(root, "phigros", { filename: "internal.png", sourceRelativePath: "Assets/Tracks/Partial/Illustration.jpg", title: "Partial", confidence: "medium" })]);
    const workspace = await createWorkspaceFromExtractorResult(extracted, { rootPath: path.join(root, "workspace") });
    const id = workspace.candidates[0]!.id;
    await assert.rejects(() => confirmCandidateInWorkspace(workspace.rootPath, id), /metadata override/);
    const corrected = await overrideCandidateMetadataInWorkspace(workspace.rootPath, id, { artist: "Correct Artist", metadata: { source: "human" } }, { now: "2026-08-14T00:00:00Z" });
    assert.equal(corrected.review.confirmed, false);
    assert.equal(corrected.review.overrides.artist, "Correct Artist");
    assert.equal(corrected.suggestedMapping.metadata.artist, undefined);
    assert.equal(corrected.provenance?.apkInternalRelativePath, "Assets/Tracks/Partial/Illustration.jpg");
    const renamed = await overrideCandidateFilenameInWorkspace(workspace.rootPath, id, "Partial - Correct Artist.jpg", { now: "2026-08-14T00:00:00Z" });
    assert.equal(renamed.id, id);
    assert.equal(renamed.naming.finalFilename, "Partial - Correct Artist.jpg");
    assert.equal(renamed.review.overrides.filename, "Partial - Correct Artist.jpg");
    const confirmed = await confirmCandidateInWorkspace(workspace.rootPath, id, { now: "2026-08-14T00:00:00Z" });
    assert.equal(confirmed.review.confirmed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous Arcaea identity is blocked until resolved, and difficulty evidence remains a Variant proposal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase2c-identity-"));
  try {
    const sourcePath = path.join(root, "unknown.png");
    await image(sourcePath);
    const ambiguous = await result(root, "arcaea", [candidate(root, "arcaea", { filename: "unknown.png", sourceRelativePath: "songs/unknown/1080_base_3.jpg", title: "Unknown", artist: "Artist", confidence: "low", identityExact: false, identityAmbiguous: true })]);
    const workspace = await createWorkspaceFromExtractorResult(ambiguous, { rootPath: path.join(root, "workspace") });
    const id = workspace.candidates[0]!.id;
    assert.equal(workspace.candidates[0]!.status, "BLOCKED");
    await assert.rejects(() => confirmCandidateInWorkspace(workspace.rootPath, id), /BLOCKED/);
    const resolved = await resolveCandidateIdentityInWorkspace(workspace.rootPath, id, { resourceId: createUuidV7() });
    assert.equal(resolved.id, id);
    assert.equal(resolved.sourceEvidence.sourceRelativePath, "songs/unknown/1080_base_3.jpg");
    assert.equal(resolved.review.overrides.resourceId !== undefined, true);
    assert.equal(resolved.status, "NAMING_REVIEW");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Arcaea _256 remains unresolved instead of being silently reclassified", () => {
  const requirements = applyReviewPolicy({
    game: "arcaea",
    resourceType: "jacket",
    confidence: "high",
    suggestedTitle: "Asgore",
    suggestedArtist: "Artist",
    suggestedFilename: "Asgore_256.jpg",
    identityExact: true,
    metadataComplete: true,
    variantUnresolved: true,
  });
  assert.equal(requirements.reviewRequired, true);
  assert.equal(requirements.manualNamingRequired, false);
  assert.equal(requirements.reasons.includes("variant semantics are unresolved"), true);
});

test("legacy Arcaea and Phigros reports adapt real output files without publishing them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-phase2c-legacy-adapter-"));
  try {
    const arcaeaOut = path.join(root, "arcaea-output");
    const arcaeaImage = path.join(arcaeaOut, "曲绘", "Testify.jpg");
    await image(arcaeaImage);
    await mkdir(path.join(arcaeaOut, "_metadata"), { recursive: true });
    await writeFile(path.join(arcaeaOut, "_metadata", "songlist.json"), JSON.stringify({ songs: [{ id: "testify", title_localized: { en: "Testify" }, artist: "Void", difficulties: [] }] }));
    const arcaeaReport = path.join(arcaeaOut, "arcaea-update-report.json");
    await writeFile(arcaeaReport, JSON.stringify({ outputDir: arcaeaOut, copied: [{ category: "曲绘", sourcePath: "songs/testify/1080_base.jpg", outputPath: "曲绘/Testify.jpg" }] }));
    const arcaea = await adaptArcaeaLegacyReport({ reportPath: arcaeaReport, baseVersion: "1.0.0", targetVersion: "2.0.0", baseApk: apk(root, "base", "1.0.0"), targetApk: apk(root, "target", "2.0.0") });
    assert.equal(arcaea.status, "ok");
    assert.equal(arcaea.candidates[0]!.suggestedTitle, "Testify");
    assert.equal(arcaea.candidates[0]!.provenance.apkInternalRelativePath, "songs/testify/1080_base.jpg");

    const phigrosOut = path.join(root, "phigros-output");
    const phigrosImage = path.join(phigrosOut, "曲绘", "Track - Artist.png");
    await image(phigrosImage, "#773311");
    const phigrosReport = path.join(phigrosOut, "phigros-update-report.json");
    await writeFile(phigrosReport, JSON.stringify({ outputDir: phigrosOut, exported: [{ category: "曲绘", outputPath: "曲绘/Track - Artist.png", bundle: "assets/aa/Android/abc.bundle", objectName: "Illustration", width: 1000, height: 1000, nameSource: "catalog-track-key", sourceKey: "Assets/Tracks/Track.Artist.3/Illustration.jpg" }] }));
    const phigros = await adaptPhigrosLegacyReport({ reportPath: phigrosReport, baseVersion: "3.19.4", targetVersion: "3.19.5", baseApk: apk(root, "base", "3.19.4"), targetApk: apk(root, "target", "3.19.5") });
    assert.equal(phigros.status, "ok");
    assert.equal(phigros.candidates[0]!.suggestedTitle, "Track");
    assert.equal(phigros.candidates[0]!.suggestedArtist, "Artist");
    assert.equal(phigros.candidates[0]!.reviewRequirements.metadataReviewRequired, false);
    assert.equal(phigros.candidates[0]!.provenance?.addressablesKey, "Assets/Tracks/Track.Artist.3/Illustration.jpg");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
