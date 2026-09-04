import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import {
  ARCAEA_APK_API_URL,
  ARCAEA_APK_LATEST_KEY,
  ARCAEA_APK_MAX_SIZE_BYTES,
  MemoryStorageClient,
  arcaeaGithubAssetUrl,
  arcaeaGithubReleaseTag,
  canonicalArcaeaVersion,
  canonicalArcaeaApkFilename,
  compareArcaeaVersion,
  parseArcaeaApkManifest,
  runArcaeaApkUpdate,
  type ArcaeaApkManifest,
  type ArcaeaApkValidation,
  type ArcaeaDiscovery,
  type GitHubRelease,
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
  type StorageClient,
} from "../src/index.js";

const OFFICIAL_URL = "https://arcaea-static.lowiro-cdn.net/download?filename=arcaea_6.17.1.apk";

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

function manifestEntry(version: string, options: { official?: string | null; fileSize?: number; sha256?: string } = {}) {
  return {
    version,
    versionCode: null,
    fileName: canonicalArcaeaApkFilename(version),
    fileSize: options.fileSize ?? 10,
    sha256: options.sha256 ?? "a".repeat(64),
    publishedAt: "2026-08-16T00:00:00.000Z",
    downloads: {
      github: arcaeaGithubAssetUrl(version),
      official: options.official === undefined ? `https://arcaea-static.lowiro-cdn.net/download?filename=arcaea_${version}.apk` : options.official,
    },
  };
}

function manifestValue(latest: string, previous: string | null = null): ArcaeaApkManifest {
  return {
    schemaVersion: 2,
    game: "arcaea",
    generatedAt: "2026-08-16T00:00:00.000Z",
    latest: manifestEntry(latest),
    previous: previous ? manifestEntry(previous) : null,
  };
}

async function putManifest(storage: MemoryStorageClient, latest: string, previous: string | null = null): Promise<void> {
  await storage.putObject({ objectKey: ARCAEA_APK_LATEST_KEY, body: JSON.stringify(manifestValue(latest, previous)), contentType: "application/json; charset=utf-8" });
}

class RecordingStorage extends MemoryStorageClient {
  readonly putKeys: string[] = [];
  readonly getKeys: string[] = [];
  readonly headKeys: string[] = [];
  readonly listPrefixes: string[] = [];
  readonly deleteKeys: string[] = [];
  readonly events: string[] = [];

  override async putObject(input: Parameters<StorageClient["putObject"]>[0]): Promise<void> {
    this.putKeys.push(input.objectKey);
    this.events.push(`put:${input.objectKey}`);
    await super.putObject(input);
  }

  override async putLargeObject(input: Parameters<StorageClient["putLargeObject"]>[0]): Promise<void> {
    throw new Error(`Arcaea updater must not call putLargeObject(${input.objectKey}).`);
  }

  override async getObject(objectKey: string) {
    this.getKeys.push(objectKey);
    this.events.push(`get:${objectKey}`);
    return super.getObject(objectKey);
  }

  override async headObject(objectKey: string): Promise<never> {
    this.headKeys.push(objectKey);
    throw new Error(`Arcaea updater must not call headObject(${objectKey}).`);
  }

  override async listObjects(prefix: string): Promise<string[]> {
    this.listPrefixes.push(prefix);
    throw new Error(`Arcaea updater must not call listObjects(${prefix}).`);
  }

  override async deleteObject(objectKey: string): Promise<void> {
    this.deleteKeys.push(objectKey);
    throw new Error(`Arcaea updater must not call deleteObject(${objectKey}).`);
  }
}

class FakeGitHubReleaseClient implements GitHubReleaseClient {
  readonly releases = new Map<string, GitHubRelease>();
  readonly events: string[] = [];
  createCount = 0;
  uploadCount = 0;
  deleteAssetCount = 0;
  deleteReleaseCount = 0;
  onDeleteRelease?: (tagName: string) => void;
  private nextId = 1;

  async getRelease(tagName: string): Promise<GitHubRelease | null> {
    this.events.push(`get:${tagName}`);
    return this.releases.get(tagName) ?? null;
  }

  async createRelease(input: { tagName: string; title: string }): Promise<GitHubRelease> {
    this.events.push(`create:${input.tagName}`);
    this.createCount += 1;
    const release: GitHubRelease = { id: this.nextId++, tagName: input.tagName, name: input.title, assets: [] };
    this.releases.set(input.tagName, release);
    return release;
  }

  async uploadAsset(input: { tagName: string; filePath: string; fileName: string }): Promise<GitHubReleaseAsset> {
    this.events.push(`upload:${input.tagName}:${input.fileName}`);
    this.uploadCount += 1;
    const release = this.releases.get(input.tagName);
    if (!release) throw new Error("missing release");
    const bytes = await readFile(input.filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset: GitHubReleaseAsset = {
      id: this.nextId++,
      name: input.fileName,
      size: bytes.byteLength,
      digest: `sha256:${sha256}`,
      browserDownloadUrl: arcaeaGithubAssetUrl(input.tagName.slice("arcaea-apk-".length)),
    };
    release.assets.push(asset);
    return asset;
  }

  async deleteAsset(input: { releaseId: number; assetId: number }): Promise<void> {
    this.events.push(`delete-asset:${input.assetId}`);
    this.deleteAssetCount += 1;
    for (const release of this.releases.values()) {
      if (release.id !== input.releaseId) continue;
      release.assets = release.assets.filter((asset) => asset.id !== input.assetId);
      return;
    }
    throw new Error("missing release");
  }

  async deleteRelease(input: { releaseId: number; tagName: string }): Promise<void> {
    this.events.push(`delete-release:${input.tagName}`);
    this.deleteReleaseCount += 1;
    this.onDeleteRelease?.(input.tagName);
    const release = this.releases.get(input.tagName);
    if (!release || release.id !== input.releaseId) throw new Error("missing release");
    this.releases.delete(input.tagName);
  }

  seedRelease(version: string, asset?: GitHubReleaseAsset): void {
    const tagName = arcaeaGithubReleaseTag(version);
    this.releases.set(tagName, { id: this.nextId++, tagName, name: `Arcaea APK ${version}`, assets: asset ? [asset] : [] });
  }

  seedNormalRelease(tagName: string): void {
    this.releases.set(tagName, { id: this.nextId++, tagName, name: "Normal project release", assets: [] });
  }
}

async function runFixture(options: {
  version: string;
  storage?: StorageClient;
  releaseClient?: GitHubReleaseClient;
  download?: (found: ArcaeaDiscovery, directory: string) => Promise<string>;
  validate?: (filePath: string, options?: { expectedVersion?: string; minimumSizeBytes?: number; maximumSizeBytes?: number }) => Promise<ArcaeaApkValidation>;
  log?: (message: string) => void;
}): Promise<{ result: Awaited<ReturnType<typeof runArcaeaApkUpdate>>; root: string; downloadCount: number; bytes: Uint8Array }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcaea-release-test-"));
  const storage = options.storage ?? new RecordingStorage();
  const releaseClient = options.releaseClient ?? new FakeGitHubReleaseClient();
  const bytes = apkFixture();
  let downloadCount = 0;
  try {
    const result = await runArcaeaApkUpdate({
      storage,
      releaseClient,
      discover: async () => discovery(options.version),
      download: options.download ?? (async (found, directory) => {
        downloadCount += 1;
        const filePath = path.join(directory, canonicalArcaeaApkFilename(found.version));
        await writeFile(filePath, bytes);
        return filePath;
      }),
      ...(options.validate ? { validate: options.validate } : {}),
      stagingDirectory: root,
      minimumSizeBytes: 1,
      now: () => new Date("2026-08-17T01:15:00.000Z"),
      log: options.log ?? (() => undefined),
    });
    return { result, root, downloadCount, bytes };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function readLatest(storage: MemoryStorageClient): ArcaeaApkManifest {
  const object = storage.objects.get(ARCAEA_APK_LATEST_KEY);
  assert.ok(object);
  const parsed = parseArcaeaApkManifest(JSON.parse(Buffer.from(object.body).toString("utf8")));
  assert.ok(parsed);
  return parsed;
}

test("compareArcaeaVersion is narrow and rejects unknown formats", () => {
  assert.ok(compareArcaeaVersion("6.17.0", "6.16.2") > 0);
  assert.ok(compareArcaeaVersion("6.16.0c", "6.16.0") > 0);
  assert.throws(() => compareArcaeaVersion("latest", "6.16.0"), /Invalid Arcaea version/iu);
  assert.equal(canonicalArcaeaVersion("9007199254740993.0.0"), undefined);
});

test("check-only discovers the official APK through the Lowiro API", async () => {
  const requests: Array<{ url: string; init: unknown }> = [];
  const result = await runArcaeaApkUpdate({
    mode: "check-only",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ success: true, value: { url: OFFICIAL_URL, version: "6.17.1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.status, "checked");
  assert.equal(result.discovered.version, "6.17.1");
  assert.equal(result.discovered.officialFilename, "arcaea_6.17.1.apk");
  assert.equal(result.discovered.sourceUrl, OFFICIAL_URL);
  assert.equal(requests[0]?.url, ARCAEA_APK_API_URL);
  const requestInit = requests[0]?.init as { headers?: unknown; redirect?: unknown; signal?: unknown } | undefined;
  assert.deepEqual({ headers: requestInit?.headers, redirect: requestInit?.redirect }, { headers: { Accept: "application/json" }, redirect: "error" });
  assert.ok(requestInit?.signal instanceof AbortSignal);
});

test("official APK API discovery rejects a mismatched filename version", async () => {
  await assert.rejects(() => runArcaeaApkUpdate({
    mode: "check-only",
    fetchImpl: async () => new Response(JSON.stringify({ success: true, value: { url: OFFICIAL_URL, version: "6.17.2" } }), { status: 200 }),
  }), /does not match APK filename version/iu);
});

test("official APK API discovery rejects unsuccessful, invalid, and unsafe responses", async () => {
  const cases: Array<{ body: string; message: RegExp }> = [
    { body: JSON.stringify({ success: false, value: null }), message: /unsuccessful response/iu },
    { body: JSON.stringify({ success: true, value: {} }), message: /missing url or version/iu },
    { body: JSON.stringify({ success: true, value: { url: "https://evil.example/arcaea_6.17.1.apk", version: "6.17.1" } }), message: /outside the allowed official CDN/iu },
    { body: JSON.stringify({ success: true, value: { url: "https://arcaea-static.lowiro-cdn.net/download?filename=arcaea_9007199254740993.0.0.apk", version: "9007199254740993.0.0" } }), message: /invalid APK filename or version/iu },
  ];
  for (const item of cases) {
    await assert.rejects(() => runArcaeaApkUpdate({
      mode: "check-only",
      fetchImpl: async () => new Response(item.body, { status: 200 }),
    }), item.message);
  }
  await assert.rejects(() => runArcaeaApkUpdate({
    mode: "check-only",
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  }), /invalid JSON/iu);
});

test("manifest v2 accepts exact GitHub and official download origins", () => {
  const parsed = parseArcaeaApkManifest({ ...manifestValue("6.17.1", "6.17.0"), latest: manifestEntry("6.17.1"), previous: manifestEntry("6.17.0", { official: null }) });
  assert.equal(parsed?.schemaVersion, 2);
  assert.equal(parsed?.latest.downloads.github, arcaeaGithubAssetUrl("6.17.1"));
  assert.equal(parsed?.previous?.downloads.official, null);
  const missingPreviousOfficial = { ...manifestValue("6.17.1", "6.17.0"), previous: { ...manifestEntry("6.17.0"), downloads: { github: arcaeaGithubAssetUrl("6.17.0") } } };
  assert.equal(parseArcaeaApkManifest(missingPreviousOfficial)?.previous?.downloads.official, null);
  assert.equal(parseArcaeaApkManifest({ ...manifestValue("6.17.1"), latest: { ...manifestEntry("6.17.1"), downloads: { github: "https://github.com/evil/repo/releases/download/arcaea-apk-6.17.1/Arcaea_6.17.1.apk", official: OFFICIAL_URL } } }), null);
  assert.equal(parseArcaeaApkManifest({ ...manifestValue("6.17.1"), latest: { ...manifestEntry("6.17.1"), downloads: { github: "https://github.com/rhythmarchive/rhythmarchive.github.io/releases/download/wrong-tag/Arcaea_6.17.1.apk", official: OFFICIAL_URL } } }), null);
  assert.equal(parseArcaeaApkManifest({ ...manifestValue("6.17.1"), latest: { ...manifestEntry("6.17.1"), downloads: { github: arcaeaGithubAssetUrl("6.17.1"), official: "http://arcaea-static.lowiro-cdn.net/arcaea.apk" } } }), null);
  assert.equal(parseArcaeaApkManifest({ ...manifestValue("6.17.1"), latest: { ...manifestEntry("6.17.1"), url: `${arcaeaGithubAssetUrl("6.17.1")}` } }), null);
});

test("new APK creates and uploads a GitHub Release before the ROS manifest", async () => {
  const storage = new RecordingStorage();
  const releaseClient = new FakeGitHubReleaseClient();
  const result = await runFixture({ version: "6.17.1", storage, releaseClient });
  assert.equal(result.result.status, "published");
  assert.equal(result.result.uploaded, true);
  assert.equal(result.result.reusedReleaseAsset, false);
  assert.equal(releaseClient.createCount, 1);
  assert.equal(releaseClient.uploadCount, 1);
  assert.deepEqual(storage.putKeys, [ARCAEA_APK_LATEST_KEY]);
  assert.deepEqual(storage.headKeys, []);
  assert.deepEqual(storage.listPrefixes, []);
  assert.deepEqual(storage.deleteKeys, []);
  assert.deepEqual(storage.getKeys, [ARCAEA_APK_LATEST_KEY, ARCAEA_APK_LATEST_KEY]);
  const latest = readLatest(storage);
  assert.equal(latest.latest.downloads.github, arcaeaGithubAssetUrl("6.17.1"));
  assert.equal(latest.latest.downloads.official, discovery("6.17.1").sourceUrl);
  await rm(result.root, { recursive: true, force: true });
});

test("matching existing GitHub asset is reused without reupload", async () => {
  const storage = new RecordingStorage();
  await putManifest(storage, "6.17.0");
  const releaseClient = new FakeGitHubReleaseClient();
  const bytes = apkFixture();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  releaseClient.seedRelease("6.17.1", { id: 100, name: canonicalArcaeaApkFilename("6.17.1"), size: bytes.byteLength, digest: `sha256:${sha256}`, browserDownloadUrl: arcaeaGithubAssetUrl("6.17.1") });
  const result = await runFixture({ version: "6.17.1", storage, releaseClient });
  assert.equal(result.result.status, "published");
  assert.equal(result.result.uploaded, false);
  assert.equal(result.result.reusedReleaseAsset, true);
  assert.equal(releaseClient.createCount, 0);
  assert.equal(releaseClient.uploadCount, 0);
  assert.equal(releaseClient.deleteAssetCount, 0);
  await rm(result.root, { recursive: true, force: true });
});

test("wrong existing asset is deleted and replaced with the canonical asset", async () => {
  const storage = new RecordingStorage();
  await putManifest(storage, "6.17.0");
  const releaseClient = new FakeGitHubReleaseClient();
  releaseClient.seedRelease("6.17.1", { id: 100, name: canonicalArcaeaApkFilename("6.17.1"), size: 1, digest: "sha256:" + "b".repeat(64), browserDownloadUrl: arcaeaGithubAssetUrl("6.17.1") });
  const result = await runFixture({ version: "6.17.1", storage, releaseClient });
  assert.equal(result.result.uploaded, true);
  assert.equal(releaseClient.deleteAssetCount, 1);
  assert.equal(releaseClient.uploadCount, 1);
  await rm(result.root, { recursive: true, force: true });
});

test("latest and previous publish before deleting the third-oldest managed Release", async () => {
  const storage = new RecordingStorage();
  await putManifest(storage, "6.17.0", "6.16.2");
  const releaseClient = new FakeGitHubReleaseClient();
  releaseClient.seedRelease("6.16.2");
  releaseClient.seedRelease("6.17.0");
  releaseClient.seedNormalRelease("normal-release");
  releaseClient.onDeleteRelease = () => assert.equal(readLatest(storage).latest.version, "6.17.1");
  const result = await runFixture({ version: "6.17.1", storage, releaseClient });
  assert.equal(result.result.status, "published");
  assert.equal(releaseClient.deleteReleaseCount, 1);
  assert.equal(releaseClient.releases.has(arcaeaGithubReleaseTag("6.16.2")), false);
  assert.equal(releaseClient.releases.has("normal-release"), true);
  const latest = readLatest(storage);
  assert.equal(latest.latest.version, "6.17.1");
  assert.equal(latest.previous?.version, "6.17.0");
  assert.deepEqual(latest.previous?.downloads, manifestValue("6.17.0", "6.16.2").latest.downloads);
  await rm(result.root, { recursive: true, force: true });
});

test("APK at the GitHub two-GiB boundary blocks mirror publish without changing latest.json", async () => {
  const storage = new RecordingStorage();
  const releaseClient = new FakeGitHubReleaseClient();
  const logs: string[] = [];
  const result = await runFixture({
    version: "6.17.1",
    storage,
    releaseClient,
    log: (message) => logs.push(message),
    validate: async (filePath) => ({ filePath, fileSize: ARCAEA_APK_MAX_SIZE_BYTES, sha256: "c".repeat(64), zipEntryCount: 2, hasAndroidManifest: true }),
  });
  assert.equal(result.result.status, "blocked-mirror-size");
  assert.equal(releaseClient.createCount, 0);
  assert.equal(releaseClient.uploadCount, 0);
  assert.deepEqual(storage.putKeys, []);
  assert.ok(logs.includes("[arcaea-apk] Arcaea APK exceeds GitHub Release asset size limit."));
  await rm(result.root, { recursive: true, force: true });
});

test("same public version does not download or touch GitHub Releases", async () => {
  const storage = new RecordingStorage();
  await putManifest(storage, "6.17.1", "6.17.0");
  const releaseClient = new FakeGitHubReleaseClient();
  const result = await runFixture({ version: "6.17.1", storage, releaseClient });
  assert.equal(result.result.status, "no-update");
  assert.equal(result.downloadCount, 0);
  assert.equal(releaseClient.events.length, 0);
  assert.deepEqual(storage.putKeys, [ARCAEA_APK_LATEST_KEY]);
  await rm(result.root, { recursive: true, force: true });
});

test("local APK validation failure leaves latest.json unchanged", async () => {
  const storage = new RecordingStorage();
  const releaseClient = new FakeGitHubReleaseClient();
  await assert.rejects(() => runFixture({
    version: "6.17.1",
    storage,
    releaseClient,
    download: async (found, directory) => {
      const filePath = path.join(directory, canonicalArcaeaApkFilename(found.version));
      await writeFile(filePath, "not an apk");
      return filePath;
    },
  }), /ZIP archive|ZIP central directory/iu);
  assert.deepEqual(storage.putKeys, []);
  assert.equal(releaseClient.createCount, 0);
});
