import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { ARCAEA_APK_MAX_SIZE_BYTES, ARCAEA_GITHUB_MAX_SIZE_BYTES, downloadOfficialArcaeaApk, runArcaeaApkUpdate, validateArcaeaApk, type ArcaeaDiscovery } from "../../../packages/domain/src/arcaea-apk.js";
import { arcaeaR2ObjectKey } from "../../../packages/domain/src/apk-download.js";
import { MemoryStorageClient } from "../../../packages/domain/src/storage.js";
import { apkDownloadLinks, parsePublicArcaeaApkManifest } from "../src/lib/apk.js";

const base = "https://apk.example.com";
process.env.ARCAEA_R2_PUBLIC_BASE_URL = base;
const discovery: ArcaeaDiscovery = { version: "7.3.0c", officialFilename: "arcaea_7.3.0c.apk", sourceHost: "arcaea-static.lowiro-cdn.net", sourceUrl: "https://arcaea-static.lowiro-cdn.net/arcaea_7.3.0c.apk", discoveredAt: "2026-11-17T00:00:00Z" };
const bytes = zipSync({ "AndroidManifest.xml": new Uint8Array([1, 2, 3]) });
const sha256 = createHash("sha256").update(bytes).digest("hex");

test("APK validation/download accepts bounded ZIP files and rejects declared oversize", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ra-apk-"));
  try {
    const file = await downloadOfficialArcaeaApk(discovery, directory, (async () => new Response(bytes)) as typeof fetch);
    assert.equal((await validateArcaeaApk(file, { minimumSizeBytes: 1 })).sha256, sha256);
    await assert.rejects(downloadOfficialArcaeaApk(discovery, directory, (async () => new Response(bytes, { headers: { "content-length": String(ARCAEA_APK_MAX_SIZE_BYTES + 1) } })) as typeof fetch), /maximum size/);
    assert.equal(ARCAEA_GITHUB_MAX_SIZE_BYTES, 2147483648);
    assert.ok(ARCAEA_APK_MAX_SIZE_BYTES > ARCAEA_GITHUB_MAX_SIZE_BYTES);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const size of [2000000001, 2147483647, 2147483648, 2147483649]) {
  for (const r2Enabled of [false, true]) {
  for (const failure of r2Enabled ? ["none", "r2", "github", "public", "manifest"] as const : ["none", "github", "manifest"] as const) {
    test(`APK publish ${size} / R2=${r2Enabled} / ${failure}`, async () => {
      if (r2Enabled) process.env.ARCAEA_R2_PUBLIC_BASE_URL = base;
      else delete process.env.ARCAEA_R2_PUBLIC_BASE_URL;
      const directory = await mkdtemp(path.join(tmpdir(), "ra-apk-"));
      const storage = new MemoryStorageClient();
      const old = JSON.stringify({ schemaVersion: 2, game: "arcaea", generatedAt: "old", latest: { version: "7.2.0", versionCode: null, fileName: "Arcaea_7.2.0.apk", fileSize: 42, sha256, publishedAt: "old", downloads: { github: "https://github.com/rhythmarchive/rhythmarchive.github.io/releases/download/arcaea-apk-7.2.0/Arcaea_7.2.0.apk", official: null } }, previous: null });
      await storage.putObject({ objectKey: "apk/arcaea/latest.json", body: old });
      if (failure === "manifest") storage.failOnPutNumber = 2;
      const r2 = new MemoryStorageClient(base);
      if (failure === "r2") r2.failOnPutNumber = 1;
      // Size boundaries use virtual metadata, never allocate a multi-GiB fixture.
      r2.verifyObject = async key => ({ objectKey: key, exists: r2.objects.has(key), verified: r2.objects.has(key) });
      let releaseCalls = 0;
      let asset = false;
      const url = `https://github.com/rhythmarchive/rhythmarchive.github.io/releases/download/arcaea-apk-7.3.0c/Arcaea_7.3.0c.apk`;
      const release = { id: 1, tagName: "arcaea-apk-7.3.0c", name: "Arcaea APK 7.3.0c", assets: [] as { id: number; name: string; size: number; digest: string; browserDownloadUrl: string }[] };
      const options = { storage, ...(r2Enabled ? { r2Storage: r2 } : {}), stagingDirectory: directory, discover: async () => discovery, log: () => {},
        download: async (_: unknown, dir: string) => { const file = path.join(dir, "Arcaea_7.3.0c.apk"); await writeFile(file, bytes); return file; },
        validate: async (filePath: string) => ({ filePath, fileSize: size, sha256, zipEntryCount: 1, hasAndroidManifest: true as const }),
        fetchImpl: (async () => { assert.ok(r2Enabled, "disabled R2 must make no fetch requests"); return new Response(null, { status: failure === "public" ? 403 : 200, headers: { "content-length": String(size) } }); }) as typeof fetch,
        releaseClient: { getRelease: async () => { releaseCalls++; if (failure === "github") throw new Error("GitHub failed"); return { ...release, assets: asset ? [{ id: 2, name: "Arcaea_7.3.0c.apk", size, digest: `sha256:${sha256}`, browserDownloadUrl: url }] : [] }; }, createRelease: async () => release, uploadAsset: async () => { asset = true; return { id: 2, name: "Arcaea_7.3.0c.apk", size }; }, deleteAsset: async () => { throw new Error("must not delete"); }, deleteRelease: async () => { throw new Error("must not delete history"); } },
      };
      try {
        if (!r2Enabled && size >= ARCAEA_GITHUB_MAX_SIZE_BYTES) {
          assert.equal((await runArcaeaApkUpdate(options)).status, "blocked-mirror-size");
          assert.equal(releaseCalls, 0);
          assert.equal(r2.objects.size, 0);
          assert.equal(Buffer.from(storage.objects.get("apk/arcaea/latest.json")!.body).toString(), old);
        } else if (failure !== "none" && !(failure === "github" && size >= ARCAEA_GITHUB_MAX_SIZE_BYTES)) {
          await assert.rejects(runArcaeaApkUpdate(options));
          assert.equal(Buffer.from(storage.objects.get("apk/arcaea/latest.json")!.body).toString(), old);
        } else {
          const result = await runArcaeaApkUpdate(options);
          assert.equal(result.status, "published");
          const parsed = parsePublicArcaeaApkManifest(result.manifest, { publicBaseUrl: base });
          assert.ok(parsed);
          const links = apkDownloadLinks(parsed.latest);
          assert.equal(links.length, r2Enabled && size < ARCAEA_GITHUB_MAX_SIZE_BYTES ? 2 : 1);
          assert.equal(links[0]!.href, r2Enabled ? `${base}/${arcaeaR2ObjectKey(discovery.version, sha256)}` : url);
          if (size >= ARCAEA_GITHUB_MAX_SIZE_BYTES) assert.equal(releaseCalls, 0);
          if (r2Enabled) assert.equal(parsePublicArcaeaApkManifest(result.manifest, { publicBaseUrl: "https://evil.example" }), null);
          else {
            assert.equal(result.manifest?.schemaVersion, 2);
            assert.equal(result.manifest?.latest.downloads.r2, undefined);
            assert.equal(r2.objects.size, 0);
            assert.ok(parsePublicArcaeaApkManifest(result.manifest));
          }
          assert.equal((await runArcaeaApkUpdate(options)).status, "no-update");
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}

}

test("GitHub-only rejects a 2 GiB Content-Length before consuming the body", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ra-apk-"));
  const storage = new MemoryStorageClient();
  let cancelled = false;
  try {
    const result = await runArcaeaApkUpdate({storage, stagingDirectory: directory, discover: async () => discovery, log: () => {},
      fetchImpl: (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "2147483648" } })) as typeof fetch,
    });
    assert.equal(result.status, "blocked-mirror-size");
    assert.equal(cancelled, true);
    assert.equal(storage.objects.size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
