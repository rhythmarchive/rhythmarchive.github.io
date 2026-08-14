import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { IMMUTABLE_OBJECT_CACHE_CONTROL, runRosCanary, S3StorageClient } from "../packages/domain/src/index.js";

let runDirectory: string | undefined;

try {
  const storage = new S3StorageClient();
  if (storage.status !== "READY") {
    console.log(JSON.stringify({ status: "NOT_CONFIGURED", message: "ROS 凭据未配置。" }, null, 2));
  } else {
    const canaryRoot = path.resolve(".runtime", "ros-canary");
    await mkdir(canaryRoot, { recursive: true });
    runDirectory = await mkdtemp(path.join(canaryRoot, "run-"));
    const samplePath = path.join(runDirectory, "sample.webp");
    const color = randomBytes(3);
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: color[0]!, g: color[1]!, b: color[2]! },
      },
    }).webp({ quality: 80 }).toFile(samplePath);
    const body = new Uint8Array(await readFile(samplePath));
    const objectKey = `_canary/${createHash("sha256").update(body).digest("hex")}.webp`;
    const origin = "https://example.com";
    const result = await runRosCanary({
      storage,
      samples: [{ objectKey, sizeBytes: body.byteLength, mime: "image/webp", body, label: "synthetic-64x64", publicRead: true }],
      maxSamples: 1,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      cleanupAfter: true,
      corsOrigin: origin,
      publicFetch: async (url) => {
        const response = await fetch(url, { headers: { Origin: origin } });
        await response.arrayBuffer();
        return { ok: response.ok, status: response.status, headers: response.headers };
      },
      rangeFetch: async (url) => {
        const response = await fetch(url, { headers: { Origin: origin, Range: "bytes=0-31" } });
        await response.arrayBuffer();
        return { ok: response.ok, status: response.status, headers: response.headers };
      },
    });
    const status = result.status === "READY" ? "PASS" : result.status === "PASS_WITH_WARNINGS" ? "PASS_WITH_WARNINGS" : result.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "FAIL";
    const output = {
      status,
      put: result.put > 0,
      head: result.head > 0,
      contentLength: result.contentLength,
      cacheControl: result.cacheControl,
      cacheControlActual: result.cacheControlValue ?? null,
      publicRead: result.publicRead > 0,
      range: result.range === "AVAILABLE" ? "OK" : result.range,
      rangeStatus: result.rangeStatus ?? null,
      contentRange: result.rangeContentRange ?? null,
      cors: result.cors === "AVAILABLE" ? "OK" : result.cors === "CORS_NOT_AVAILABLE" ? "CORS_NOT_CONFIGURED" : result.cors,
      duplicateCheck: result.duplicateCheck === "OK" || result.duplicateCheck === "EXISTING" ? "OK" : result.duplicateCheck,
      cleanup: result.cleanup,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      ...(result.cleanupObjectKey ? { cleanupObjectKey: result.cleanupObjectKey } : {}),
      ...(result.code ? { code: result.code } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
    if (status === "FAIL") process.exitCode = 1;
  }
} catch {
  console.error("ROS canary failed.");
  process.exitCode = 1;
} finally {
  if (runDirectory) await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
}
