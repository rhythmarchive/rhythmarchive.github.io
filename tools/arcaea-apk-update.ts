import path from "node:path";
import { runArcaeaApkUpdate } from "../packages/domain/src/arcaea-apk.js";
import { S3StorageClient } from "../packages/domain/src/storage.js";

function usage(): never {
  console.log([
    "Usage: npm --prefix tools/arcaea-apk-updater run check -- [--check-only | --mode check-only|stage-private|publish] [--staging-dir <dir>]",
    "",
    "The official source is fixed to https://webapi.lowiro.com/webapi/serve/static/bin/arcaea/apk.",
    "--check-only discovers the official version and CDN host without reading or writing ROS.",
  ].join("\n"));
  process.exit(0);
}

function parseArgs(argv: string[]): { mode: "check-only" | "stage-private" | "publish"; stagingDirectory?: string } {
  let mode: "check-only" | "stage-private" | "publish" = process.env.ARCAEA_APK_MODE === "check-only" ? "check-only" : "publish";
  let stagingDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--check-only") {
      mode = "check-only";
      continue;
    }
    if (arg === "--mode") {
      const value = argv[++index];
      if (value !== "check-only" && value !== "stage-private" && value !== "publish") throw new Error("--mode must be check-only or publish.");
      mode = value;
      continue;
    }
    if (arg === "--staging-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--staging-dir requires a directory.");
      stagingDirectory = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return stagingDirectory ? { mode, stagingDirectory } : { mode };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const r2Enabled = process.env.ARCAEA_R2_ENABLED === "true";
  if (parsed.mode === "publish" && !r2Enabled) throw new Error("Public R2 publishing is disabled.");
  if (parsed.mode !== "check-only") {
    for (const key of ["ARCAEA_R2_ENDPOINT", "ARCAEA_R2_BUCKET", "ARCAEA_R2_PUBLIC_BASE_URL", "ARCAEA_R2_ACCESS_KEY_ID", "ARCAEA_R2_SECRET_ACCESS_KEY"]) {
      if (!process.env[key]?.trim()) throw new Error(`Missing configuration: ${key}`);
    }
    const publicBase = new URL(process.env.ARCAEA_R2_PUBLIC_BASE_URL!);
    const endpoint = new URL(process.env.ARCAEA_R2_ENDPOINT!);
    if (process.env.ARCAEA_R2_BUCKET !== "rhythm-archive" || publicBase.href !== "https://dl.rhythmarchive.top/" || publicBase.protocol !== "https:" || publicBase.username || publicBase.password || publicBase.search || publicBase.hash || publicBase.port || endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error("Invalid R2 endpoint/public URL configuration.");
  }
  const result = await runArcaeaApkUpdate({
    mode: parsed.mode,
    ...(parsed.stagingDirectory ? { stagingDirectory: parsed.stagingDirectory } : {}),
    ...(parsed.mode !== "check-only" ? { storage: new S3StorageClient(), r2Storage: new S3StorageClient({
      endpoint: process.env.ARCAEA_R2_ENDPOINT ?? "",
      bucket: process.env.ARCAEA_R2_BUCKET ?? "",
      publicBaseUrl: process.env.ARCAEA_R2_PUBLIC_BASE_URL ?? "",
      uploadCeilingBytes: 8_000_000_000,
      region: "auto", forcePathStyle: true,
      accessKey: process.env.ARCAEA_R2_ACCESS_KEY_ID ?? "",
      secretKey: process.env.ARCAEA_R2_SECRET_ACCESS_KEY ?? "",
    }) } : {}),
  });
  if (result.status === "checked") {
    console.log(`[arcaea-apk] check-only complete: version ${result.discovered.version}; CDN host ${result.discovered.sourceHost}.`);
  } else if (result.status === "blocked-version-regression") {
    console.log("[arcaea-apk] stopped without publishing because the official version is older than the public version.");
    process.exitCode = 2;
  } else if (result.status === "no-update") {
    console.log("[arcaea-apk] no update; 0 APK download, 0 ROS write, 0 delete.");
  } else if (result.cleanupWarning) {
    console.log(`[arcaea-apk] publish succeeded with warning: ${result.cleanupWarning}.`);
  }
}

main().catch((error) => {
  console.error(`[arcaea-apk] ${error instanceof Error ? error.message : "update failed"}`);
  process.exitCode = 1;
});
