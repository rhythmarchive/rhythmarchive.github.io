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

for (const scenario of ["disabled", "private", "failed-range", "publish"] as const) {
  test(`R2 APK ${scenario}: only a verified public download advances ROS metadata`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ra-apk-"));
    const storage = new MemoryStorageClient(), r2 = new MemoryStorageClient(base);
    const options = { storage, ...(scenario !== "disabled" ? { r2Storage: r2 } : {}),
      mode: scenario === "private" ? "stage-private" as const : "publish" as const,
      stagingDirectory: directory, minimumSizeBytes: 1, discover: async () => discovery,
      download: async (_: unknown, dir: string) => { const file = path.join(dir, "Arcaea_7.3.0c.apk"); await writeFile(file, bytes); return file; },
      fetchImpl: (async (_url, init) => {
        assert.notEqual(scenario, "private");
        const headers = { etag: '"fixture"', 'content-length': String(bytes.length) };
        if (init?.method === "HEAD" || scenario === "failed-range") return new Response(null, { headers });
        const h = new Headers(init?.headers); assert.equal(h.get("if-range"), headers.etag);
        const range = h.get("range")!.slice(6); const i = Number(range.split("-")[0]);
        return new Response(bytes.slice(i,i+1), { status: 206, headers: {...headers, 'content-range': `bytes ${range}/${bytes.length}`, 'content-length': '1'} });
      }) as typeof fetch };
    try {
      if (scenario === "disabled" || scenario === "failed-range") await assert.rejects(runArcaeaApkUpdate(options), /configuration is incomplete|resume verification failed/);
      else {
        const result = await runArcaeaApkUpdate(options);
        assert.equal(result.status, scenario === "private" ? "staged" : "published");
        if (scenario === "publish") {
          const parsed = parsePublicArcaeaApkManifest(result.manifest,{publicBaseUrl:base}); assert.ok(parsed);
          assert.deepEqual(apkDownloadLinks(parsed.latest).map(x=>x.href),[`${base}/${arcaeaR2ObjectKey(discovery.version,sha256)}`]);
          assert.equal((await runArcaeaApkUpdate(options)).status,"no-update");
        }
      }
      assert.equal(storage.objects.size, scenario === "publish" ? 1 : 0);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
}
