import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  checkLegacyMigrationConsistency,
  executeLegacyMigration,
  MemoryStorageClient,
  scanLegacyAssets,
  validateLegacyMigrationPlan,
} from "../src/index.js";

async function image(filePath: string, format: "jpeg" | "png" = "jpeg"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const pipeline = sharp({ create: { width: 96, height: 96, channels: 3, background: "#5060a0" } });
  if (format === "png") await pipeline.png().toFile(filePath);
  else await pipeline.jpeg().toFile(filePath);
}

async function migrationFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-legacy-migration-"));
  const original = path.join(root, "Arcaea", "曲绘", "Testify.jpg");
  const upscaled = path.join(root, "Arcaea", "曲绘（AI超分后）", "Testify.jpg");
  const phigros = path.join(root, "Phigros", "曲绘", "Track - Artist.jpg");
  await image(original);
  await image(upscaled, "png");
  await image(phigros);
  const plan = await scanLegacyAssets({
    sourceRoot: root,
    sourceResolver: (_item, classification) => classification.game === "arcaea" ? "legacy-curated" : "legacy",
    now: "2026-08-14T00:00:00.000Z",
  });
  return { root, plan, original };
}

test("Legacy migration uploads one preview set per proposal and resumes by skipping immutable Objects", async () => {
  const { root, plan, original } = await migrationFixture();
  try {
    assert.equal(validateLegacyMigrationPlan(plan).valid, true);
    assert.equal(plan.stats.blockingIssueCount, 0);
    assert.equal(plan.stats.thumbnailCount, plan.proposals.length * 3);
    const before = await readFile(original);
    const storage = new MemoryStorageClient();
    const runtimeRoot = path.join(root, "runtime");
    const catalogPath = path.join(root, "catalog", "index.json");
    const releasesDirectory = path.join(root, "catalog", "releases");
    const first = await executeLegacyMigration({ plan, storage, runtimeRoot, catalogPath, releasesDirectory });
    assert.equal(first.uploadedObjectCount, first.catalog.objects.length);
    assert.equal(first.skippedObjectCount, 0);
    assert.equal(first.failedUploadCount, 0);
    assert.equal(first.catalog.resources.length, 2);
    assert.equal(first.catalog.renditions.filter((rendition) => rendition.renditionType.startsWith("thumbnail")).length, 6);
    assert.equal(first.catalog.renditions.filter((rendition) => rendition.publishable).length, 3);
    assert.equal(first.releaseManifestPaths.length, 2);
    assert.deepEqual(await readFile(original), before);
    for (const object of first.catalog.objects) assert.equal((await storage.headObject(object.objectKey)).cacheControl, "public, max-age=31536000, immutable");

    const consistency = await checkLegacyMigrationConsistency({ storage, catalogPath, runtimeRoot });
    assert.equal(consistency.status, "PASS");
    assert.equal(consistency.missingObjectCount, 0);
    assert.equal(consistency.failedUploadCount, 0);
    assert.equal(consistency.resourceCount, 2);
    assert.equal(consistency.objectCount, first.catalog.objects.length);

    const second = await executeLegacyMigration({ plan, storage, runtimeRoot, catalogPath, releasesDirectory });
    assert.equal(second.uploadedObjectCount, 0);
    assert.equal(second.skippedObjectCount, first.catalog.objects.length);
    assert.equal(second.failedUploadCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("Legacy migration keeps Catalog absent after an upload failure and continues on retry", async () => {
  const { root, plan } = await migrationFixture();
  try {
    const storage = new MemoryStorageClient();
    storage.failOnPutNumber = 2;
    const catalogPath = path.join(root, "catalog", "index.json");
    await assert.rejects(() => executeLegacyMigration({ plan, storage, runtimeRoot: path.join(root, "runtime"), catalogPath, releasesDirectory: path.join(root, "catalog", "releases") }), /ROS Object upload failed/u);
    await assert.rejects(() => access(catalogPath));
    assert.equal(storage.objects.size, 1);
    delete storage.failOnPutNumber;
    const result = await executeLegacyMigration({ plan, storage, runtimeRoot: path.join(root, "runtime"), catalogPath, releasesDirectory: path.join(root, "catalog", "releases") });
    assert.equal(result.uploadedObjectCount, result.catalog.objects.length - 1);
    assert.equal(result.skippedObjectCount, 1);
    assert.equal(result.failedUploadCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
