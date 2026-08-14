import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createVersionWorkspace, loadWorkspaceState } from "../../domain/src/index.js";
import { createAdminServer } from "../src/server.js";
import { workspaceIdFor } from "../src/workspace-view.js";
import { normalizeAdminConfig } from "../src/config.js";

async function image(filePath: string, color = "#5965a8"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toFile(filePath);
}

async function jsonRequest(baseUrl: string, pathname: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...options });
  return { status: response.status, body: await response.json() };
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-admin-test-"));
  const sourcePath = path.join(root, "source", "Testify.png");
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
      sourceSnapshot: "admin-test-old-new",
      extractorVersion: "admin-test",
      candidates: [{
        sourcePath,
        sourceRelativePath: "songs/testify/1080_base.png",
        sourceFilename: "Testify.png",
        sourceGameVersion: "6.17.0",
        detection: "added",
        evidence: [{ kind: "apk-relative-path", detail: "songs/testify/1080_base.png", confidence: "high" }],
        mappingEvidence: [{ kind: "metadata", detail: "fixture song metadata", confidence: "high" }],
        suggestedFilename: "Testify.png",
        resourceType: "jacket",
        title: "Testify",
        variantKey: "default",
        variantKind: "default",
        metadata: { artist: "void" },
        externalIdentities: [],
        confidence: "high",
        reviewRequirements: { reviewRequired: true, manualNamingRequired: false, metadataReviewRequired: false, identityReviewRequired: false, upscaleRecommended: true, upscaleRequired: false, reasons: [] },
        requiresUpscale: true,
      }],
    },
  });
  const config = normalizeAdminConfig({ workspaceRuntimePath: path.join(root, "runtime") });
  const server = createAdminServer({ config, configPath: path.join(root, "admin-config.json") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { root, workspaceRoot, workspace, config, server, baseUrl: `http://127.0.0.1:${address.port}`, workspaceId: workspaceIdFor("arcaea", "6.17.0") };
}

test("Admin APIs confirm, override, rescan, upscale, publish dry-run and restore workspace state", async () => {
  const fixture = await makeFixture();
  try {
    const bootstrap = await jsonRequest(fixture.baseUrl, "/api/bootstrap");
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.workspaces[0].targetVersion, "6.17.0");
    const candidateId = fixture.workspace.candidates[0]!.id;

    const confirmed = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/confirm`, { method: "POST", body: JSON.stringify({ candidateId }) });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.candidates[0].confirmed, true);
    assert.equal(confirmed.body.candidates[0].filename, "Testify.png");

    const overridden = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/candidates/${candidateId}/override`, { method: "POST", body: JSON.stringify({ artist: "void (Mournfinale)" }) });
    assert.equal(overridden.status, 200);
    assert.equal(overridden.body.candidates[0].artist, "void (Mournfinale)");
    assert.equal(overridden.body.candidates[0].details.sourceType, "arcaea_apk");
    const reconfirmed = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/confirm`, { method: "POST", body: JSON.stringify({ candidateId }) });
    assert.equal(reconfirmed.status, 200);

    const stateBeforeRename = await loadWorkspaceState(fixture.workspaceRoot);
    const workFile = stateBeforeRename.candidates[0]!.files.find((file) => file.role === "work-original")!;
    const oldWorkPath = path.join(fixture.workspaceRoot, ...workFile.relativePath.split("/"));
    const newWorkPath = path.join(path.dirname(oldWorkPath), "Testify-renamed.png");
    await rename(oldWorkPath, newWorkPath);
    const rescanned = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/rescan`, { method: "POST", body: "{}" });
    assert.equal(rescanned.status, 200);
    assert.equal(rescanned.body.messages.some((message: string) => message.includes("重命名")), true);

    const prepared = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/upscale/prepare`, { method: "POST", body: "{}" });
    assert.equal(prepared.status, 200);
    assert.ok(await stat(path.join(fixture.workspaceRoot, "upscale-input", "Testify-renamed.png")));
    await image(path.join(fixture.workspaceRoot, "upscale-output", "Testify-renamed_optimization.png"), "#b18b52");
    const outputScan = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/upscale/rescan`, { method: "POST", body: "{}" });
    assert.equal(outputScan.status, 200);
    const match = outputScan.body.view.candidates[0].upscale.matches[0];
    assert.equal(match.state, "matched");

    const selected = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/upscale/select`, { method: "POST", body: JSON.stringify({ candidateId, outputFileId: match.fileId }) });
    assert.equal(selected.status, 200);
    const converted = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/upscale/convert`, { method: "POST", body: JSON.stringify({ candidateId, alphaPolicy: "block" }) });
    assert.equal(converted.status, 200);
    assert.equal(converted.body.result.conversion.status, "converted");
    assert.equal(await stat(path.join(fixture.workspaceRoot, "processed", "Testify-renamed.jpg")).then((value) => value.isFile()), true);
    assert.equal(await stat(path.join(fixture.workspaceRoot, "upscale-output", "Testify-renamed_optimization.png")).then((value) => value.isFile()), true);

    const finalized = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/candidates/${candidateId}/finalize`, { method: "POST", body: JSON.stringify({ createNewTarget: true }) });
    assert.equal(finalized.status, 200);
    assert.equal(finalized.body.candidates[0].status, "READY");
    const publish = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/publish/dry-run`, { method: "POST", body: "{}" });
    assert.equal(publish.status, 200);
    assert.equal(publish.body.plan.dryRun, true);
    assert.equal(publish.body.summary.uploadObjects, 1);

    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
    const restarted = createAdminServer({ config: fixture.config, configPath: path.join(fixture.root, "admin-config.json") });
    await new Promise<void>((resolve) => restarted.listen(0, "127.0.0.1", () => resolve()));
    const restartAddress = restarted.address();
    assert.ok(restartAddress && typeof restartAddress !== "string");
    const restored = await jsonRequest(`http://127.0.0.1:${restartAddress.port}`, "/api/workspaces");
    assert.equal(restored.status, 200);
    assert.equal(restored.body.workspaces[0].readyCount, 1);
    await new Promise<void>((resolve, reject) => restarted.close((error) => error ? reject(error) : resolve()));
  } finally {
    if (fixture.server.listening) await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Admin rejects non-local hosts and traversal-shaped workspace IDs", async () => {
  const fixture = await makeFixture();
  try {
    const hostile = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const target = new URL(`${fixture.baseUrl}/api/health`);
      const request = httpRequest({ hostname: target.hostname, port: Number(target.port), path: target.pathname, method: "GET", headers: { host: "example.com" } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(hostile.status, 403);
    const hostileOrigin = await jsonRequest(fixture.baseUrl, "/api/health", { headers: { origin: "http://example.com" } });
    assert.equal(hostileOrigin.status, 403);
    const traversal = Buffer.from("../outside", "utf8").toString("base64url");
    const rejected = await jsonRequest(fixture.baseUrl, `/api/workspaces/${traversal}`);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_WORKSPACE");
    const invalidFolder = await jsonRequest(fixture.baseUrl, `/api/workspaces/${fixture.workspaceId}/open-folder`, { method: "POST", body: JSON.stringify({ folder: "C:\\outside" }) });
    assert.equal(invalidFolder.status, 400);
  } finally {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Admin reports the missing APK pair in user-facing language", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rhythm-admin-apk-test-"));
  const apkDir = path.join(root, "apks");
  await mkdir(apkDir, { recursive: true });
  await writeFile(path.join(apkDir, "arcaea_6.17.0.apk"), "fixture");
  const config = normalizeAdminConfig({ arcaeaApkDir: apkDir, workspaceRuntimePath: path.join(root, "runtime") });
  const server = createAdminServer({ config, configPath: path.join(root, "admin-config.json") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await jsonRequest(`http://127.0.0.1:${address.port}`, "/api/workspaces/create", { method: "POST", body: JSON.stringify({ game: "arcaea", baseFilename: "arcaea_6.16.0.apk", targetFilename: "arcaea_6.17.0.apk" }) });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.message, "需要旧版和新版两个 APK 才能提取更新。");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
