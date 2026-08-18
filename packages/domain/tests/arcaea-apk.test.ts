import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import {
  ARCAEA_APK_LATEST_KEY,
  assertArcaeaPublicApkUrl,
  MemoryStorageClient,
  StorageError,
  arcaeaReleaseObjectKey,
  canonicalArcaeaApkFilename,
  compareArcaeaVersion,
  parseArcaeaApkManifest,
  runArcaeaApkUpdate,
  type ArcaeaDiscovery,
  type StorageClient,
} from "../src/index.js";

const PUBLIC_BASE_URL = "https://rhythm-assets.cn-nb1.rains3.com";

function discovery(version: string): ArcaeaDiscovery {
  return {
    version,
    officialFilename: `arcaea_${version}.apk`,
    sourceUrl: `https://arcaea-static.lowiro-cdn.net/download?filename=arcaea_${version}.apk`,
    sourceHost: "arcaea-static.lowiro-cdn.net",
    discoveredAt: "2026-08-17T00:00:00.000Z",
  };
}

function apkFixture(): Uint8Array {
  return zipSync({
    "AndroidManifest.xml": new Uint8Array([3, 0, 8, 0]),
    "classes.dex": new Uint8Array([1, 2, 3, 4]),
  });
}

function manifestEntry(version: string, sha256 = "a".repeat(64), fileSize = 10) {
  return {
    version,
    versionCode: null,
    fileName: canonicalArcaeaApkFilename(version),
    fileSize,
    sha256,
    url: `${PUBLIC_BASE_URL}/${arcaeaReleaseObjectKey(version)}`,
    publishedAt: "2026-08-16T00:00:00.000Z",
  };
}

async function putManifest(storage: MemoryStorageClient, latest: string, previous: string | null): Promise<void> {
  const value = {
    schemaVersion: 1,
    game: "arcaea",
    generatedAt: "2026-08-16T00:00:00.000Z",
    latest: manifestEntry(latest),
    previous: previous ? manifestEntry(previous) : null,
  };
  await storage.putObject({ objectKey: ARCAEA_APK_LATEST_KEY, body: JSON.stringify(value), contentType: "application/json; charset=utf-8" });
}

class RecordingStorage extends MemoryStorageClient {
  readonly putKeys: string[] = [];
  readonly putLargeKeys: string[] = [];
  readonly largeInputs: Array<Parameters<StorageClient["putLargeObject"]>[0]> = [];
  readonly deleteKeys: string[] = [];
  readonly getKeys: string[] = [];
  readonly events: string[] = [];
  override async putObject(input: Parameters<StorageClient["putObject"]>[0]): Promise<void> {
    this.putKeys.push(input.objectKey);
    this.events.push(`put:${input.objectKey}`);
    await super.putObject(input);
  }
  override async putLargeObject(input: Parameters<StorageClient["putLargeObject"]>[0]): Promise<void> {
    this.putLargeKeys.push(input.objectKey);
    this.largeInputs.push(input);
    this.events.push(`put-large:${input.objectKey}`);
    await super.putLargeObject(input);
  }
  override async headObject(objectKey: string) {
    this.events.push(`head:${objectKey}`);
    return super.headObject(objectKey);
  }
  override async getObject(objectKey: string) {
    this.getKeys.push(objectKey);
    return super.getObject(objectKey);
  }
  override async deleteObject(objectKey: string): Promise<void> {
    this.deleteKeys.push(objectKey);
    await super.deleteObject(objectKey);
  }
}

class DeleteFailureStorage extends MemoryStorageClient {
  override async deleteObject(_objectKey: string): Promise<void> {
    throw new StorageError("DELETE_FAILED", "ROS delete failed.");
  }
}

class DeleteFailureOnceStorage extends MemoryStorageClient {
  private failed = false;
  override async deleteObject(objectKey: string): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new StorageError("DELETE_FAILED", "ROS delete failed.");
    }
    await super.deleteObject(objectKey);
  }
}

class ManifestFailureOnceStorage extends MemoryStorageClient {
  private failed = false;
  override async putObject(input: Parameters<StorageClient["putObject"]>[0]): Promise<void> {
    if (input.objectKey === ARCAEA_APK_LATEST_KEY && !this.failed) {
      this.failed = true;
      throw new StorageError("PUT_FAILED", "ROS put failed.");
    }
    await super.putObject(input);
  }
}

async function runFixture(options: {
  storage: StorageClient;
  version: string;
  download?: (discovery: ArcaeaDiscovery, directory: string) => Promise<string>;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcaea-apk-test-"));
  const bytes = apkFixture();
  let downloadCount = 0;
  try {
    const result = await runArcaeaApkUpdate({
      storage: options.storage,
      discover: async () => discovery(options.version),
      download: options.download ?? (async (found, directory) => {
        downloadCount += 1;
        const filePath = path.join(directory, canonicalArcaeaApkFilename(found.version));
        await writeFile(filePath, bytes);
        return filePath;
      }),
      stagingDirectory: root,
      minimumSizeBytes: 1,
      publicValidate: async () => undefined,
      now: () => new Date("2026-08-17T01:15:00.000Z"),
      log: () => undefined,
    });
    return { result, root, downloadCount, bytes };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("compareArcaeaVersion is narrow and rejects unknown formats", () => {
  assert.ok(compareArcaeaVersion("6.17.0", "6.16.2") > 0);
  assert.ok(compareArcaeaVersion("6.16.0c", "6.16.0") > 0);
  assert.throws(() => compareArcaeaVersion("latest", "6.16.0"), /Invalid Arcaea version/iu);
});

test("public APK URLs are restricted to the configured ROS origin", () => {
  assert.throws(() => assertArcaeaPublicApkUrl("https://evil.example/apk/arcaea/releases/6.17.1/Arcaea_6.17.1.apk"), /outside the configured ROS public origin/iu);
  assert.equal(parseArcaeaApkManifest({ schemaVersion: 1, game: "arcaea", generatedAt: "2026-08-17T00:00:00.000Z", latest: { ...manifestEntry("6.17.1"), url: "https://evil.example/apk/arcaea/releases/6.17.1/Arcaea_6.17.1.apk" }, previous: null }), null);
});

test("same public version performs zero download and zero ROS write", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  await putManifest(storage, "6.17.0", "6.16.2");
  const before = JSON.stringify([...storage.objects.entries()]);
  const result = await runFixture({ storage, version: "6.17.0" });
  assert.equal(result.result.status, "no-update");
  assert.equal(result.downloadCount, 0);
  assert.equal(JSON.stringify([...storage.objects.entries()]), before);
  assert.deepEqual(storage.putKeys, [ARCAEA_APK_LATEST_KEY]);
  assert.deepEqual(storage.deleteKeys, []);
  await rm(result.root, { recursive: true, force: true });
});

test("new version validates before upload and updates latest.json last", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  const result = await runFixture({ storage, version: "6.17.1" });
  assert.equal(result.result.status, "published");
  assert.equal(result.result.uploaded, true);
  const objectKey = arcaeaReleaseObjectKey("6.17.1");
  assert.deepEqual(storage.putLargeKeys, [objectKey]);
  assert.deepEqual(storage.putKeys, [ARCAEA_APK_LATEST_KEY]);
  const largeInput = storage.largeInputs[0]!;
  assert.equal(largeInput.sizeBytes, result.bytes.byteLength);
  assert.equal(largeInput.contentType, "application/vnd.android.package-archive");
  assert.equal(largeInput.cacheControl, "public, max-age=31536000, immutable");
  assert.equal(largeInput.contentDisposition, `attachment; filename="Arcaea_6.17.1.apk"`);
  assert.equal(largeInput.metadata.sha256, createHash("sha256").update(result.bytes).digest("hex"));
  const latestPutIndex = storage.events.lastIndexOf(`put:${ARCAEA_APK_LATEST_KEY}`);
  const binaryVerifyHeadIndex = storage.events.lastIndexOf(`head:${objectKey}`);
  assert.ok(binaryVerifyHeadIndex >= 0 && binaryVerifyHeadIndex < latestPutIndex);
  const latest = parseArcaeaApkManifest(JSON.parse(Buffer.from(storage.objects.get(ARCAEA_APK_LATEST_KEY)!.body).toString("utf8")));
  assert.equal(latest?.latest.version, "6.17.1");
  assert.equal(latest?.previous, null);
  assert.equal(latest?.latest.fileSize, result.bytes.byteLength);
  const head = await storage.headObject(objectKey);
  assert.equal(head.metadata?.sha256, largeInput.metadata.sha256);
  await rm(result.root, { recursive: true, force: true });
});

test("uploaded APK verification never GETs the APK body", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  const result = await runFixture({ storage, version: "6.17.1" });
  assert.equal(storage.getKeys.includes(arcaeaReleaseObjectKey("6.17.1")), false);
  await rm(result.root, { recursive: true, force: true });
});

test("verified existing remote APK is reused without official download or APK GET", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  const objectKey = arcaeaReleaseObjectKey("6.17.1");
  const bytes = apkFixture();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await putManifest(storage, "6.17.0", null);
  await storage.putLargeObject({
    objectKey,
    body: bytes,
    sizeBytes: bytes.byteLength,
    contentType: "application/vnd.android.package-archive",
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: `attachment; filename="Arcaea_6.17.1.apk"`,
    metadata: { sha256 },
  });
  storage.putLargeKeys.length = 0;
  storage.largeInputs.length = 0;
  storage.getKeys.length = 0;
  let downloadCount = 0;
  const result = await runFixture({
    storage,
    version: "6.17.1",
    download: async () => {
      downloadCount += 1;
      throw new Error("official download should not be called for a verified remote APK");
    },
  });
  assert.equal(result.result.reusedRemote, true);
  assert.equal(result.result.uploaded, false);
  assert.equal(downloadCount, 0);
  assert.deepEqual(storage.putLargeKeys, []);
  assert.equal(storage.getKeys.includes(objectKey), false);
  await rm(result.root, { recursive: true, force: true });
});

test("remote APK without SHA metadata is overwritten after a fresh official download without ROS GET", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  const objectKey = arcaeaReleaseObjectKey("6.17.1");
  const bytes = apkFixture();
  await putManifest(storage, "6.17.0", null);
  await storage.putObject({
    objectKey,
    body: bytes,
    sizeBytes: bytes.byteLength,
    contentType: "application/vnd.android.package-archive",
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: `attachment; filename="Arcaea_6.17.1.apk"`,
  });
  storage.putKeys.length = 0;
  storage.putLargeKeys.length = 0;
  storage.largeInputs.length = 0;
  storage.getKeys.length = 0;
  let downloadCount = 0;
  const result = await runFixture({
    storage,
    version: "6.17.1",
    download: async (found, directory) => {
      downloadCount += 1;
      const filePath = path.join(directory, canonicalArcaeaApkFilename(found.version));
      await writeFile(filePath, bytes);
      return filePath;
    },
  });
  assert.equal(result.result.reusedRemote, false);
  assert.equal(result.result.uploaded, true);
  assert.equal(downloadCount, 1);
  assert.deepEqual(storage.putLargeKeys, [objectKey]);
  assert.equal(storage.getKeys.includes(objectKey), false);
  assert.equal((await storage.headObject(objectKey)).metadata?.sha256, createHash("sha256").update(bytes).digest("hex"));
  await rm(result.root, { recursive: true, force: true });
});

test("APK validation failure leaves latest.json and ROS unchanged", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  await assert.rejects(() => runFixture({
    storage,
    version: "6.17.1",
    download: async (found, directory) => {
      const filePath = path.join(directory, canonicalArcaeaApkFilename(found.version));
      await writeFile(filePath, "not an apk");
      return filePath;
    },
  }), /ZIP archive|ZIP central directory/iu);
  assert.equal(storage.objects.size, 0);
});

test("A/B plus C publishes C/B and deletes A only after manifest verification", async () => {
  const storage = new RecordingStorage(PUBLIC_BASE_URL);
  await putManifest(storage, "6.17.0", "6.16.2");
  await storage.putObject({ objectKey: arcaeaReleaseObjectKey("6.17.0"), body: new Uint8Array([2]) });
  await storage.putObject({ objectKey: arcaeaReleaseObjectKey("6.16.2"), body: new Uint8Array([1]) });
  const result = await runFixture({ storage, version: "6.17.1" });
  const latest = parseArcaeaApkManifest(JSON.parse(Buffer.from(storage.objects.get(ARCAEA_APK_LATEST_KEY)!.body).toString("utf8")));
  assert.equal(result.result.status, "published");
  assert.equal(latest?.latest.version, "6.17.1");
  assert.equal(latest?.previous?.version, "6.17.0");
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.16.2")), false);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.17.0")), true);
  await rm(result.root, { recursive: true, force: true });
});

test("cleanup failure is a warning and does not roll back C/B", async () => {
  const storage = new DeleteFailureStorage(PUBLIC_BASE_URL);
  await putManifest(storage, "6.17.0", "6.16.2");
  await storage.putObject({ objectKey: arcaeaReleaseObjectKey("6.16.2"), body: new Uint8Array([1]) });
  const result = await runFixture({ storage, version: "6.17.1" });
  assert.equal(result.result.status, "published");
  assert.match(result.result.cleanupWarning ?? "", /cleanup warning/iu);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.17.1")), true);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.16.2")), true);
  await rm(result.root, { recursive: true, force: true });
});

test("a later publish retries deletion of orphaned releases", async () => {
  const storage = new DeleteFailureOnceStorage(PUBLIC_BASE_URL);
  await putManifest(storage, "6.17.0", "6.16.2");
  await storage.putObject({ objectKey: arcaeaReleaseObjectKey("6.17.0"), body: new Uint8Array([2]) });
  await storage.putObject({ objectKey: arcaeaReleaseObjectKey("6.16.2"), body: new Uint8Array([1]) });
  const first = await runFixture({ storage, version: "6.17.1" });
  assert.match(first.result.cleanupWarning ?? "", /cleanup warning/iu);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.16.2")), true);
  await rm(first.root, { recursive: true, force: true });
  const second = await runFixture({ storage, version: "6.17.2" });
  assert.equal(second.result.status, "published");
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.16.2")), false);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.17.0")), false);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.17.1")), true);
  assert.equal(storage.objects.has(arcaeaReleaseObjectKey("6.17.2")), true);
  await rm(second.root, { recursive: true, force: true });
});

test("manifest PUT failure leaves C for the next run to reuse", async () => {
  const storage = new ManifestFailureOnceStorage(PUBLIC_BASE_URL);
  let downloadCount = 0;
  await assert.rejects(() => runFixture({
    storage,
    version: "6.17.1",
    download: async (found, directory) => {
      downloadCount += 1;
      const filePath = path.join(directory, canonicalArcaeaApkFilename(found.version));
      await writeFile(filePath, apkFixture());
      return filePath;
    },
  }), /ROS put failed/iu);
  const second = await runFixture({
    storage,
    version: "6.17.1",
    download: async () => {
      downloadCount += 1;
      throw new Error("official download should not be called on reuse");
    },
  });
  assert.equal(downloadCount, 1);
  assert.equal(second.result.status, "published");
  assert.equal(second.result.reusedRemote, true);
  await rm(second.root, { recursive: true, force: true });
});
