import path from "node:path";
import { runArcaeaApkUpdate, S3StorageClient } from "../packages/domain/src/index.js";

function usage(): never {
  console.log([
    "Usage: npm run arcaea:apk:check -- [--check-only | --mode check-only|publish] [--staging-dir <dir>]",
    "",
    "The official source is fixed to https://webapi.lowiro.com/webapi/serve/static/bin/arcaea/apk.",
    "--check-only discovers the official version and CDN host without reading or writing ROS.",
  ].join("\n"));
  process.exit(0);
}

function parseArgs(argv: string[]): { mode: "check-only" | "publish"; stagingDirectory?: string } {
  let mode: "check-only" | "publish" = process.env.ARCAEA_APK_MODE === "check-only" ? "check-only" : "publish";
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
      if (value !== "check-only" && value !== "publish") throw new Error("--mode must be check-only or publish.");
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
  const result = await runArcaeaApkUpdate({
    mode: parsed.mode,
    ...(parsed.stagingDirectory ? { stagingDirectory: parsed.stagingDirectory } : {}),
    ...(parsed.mode === "publish" ? { storage: new S3StorageClient() } : {}),
  });
  if (result.status === "checked") {
    console.log(`[arcaea-apk] check-only complete: version ${result.discovered.version}; CDN host ${result.discovered.sourceHost}.`);
  } else if (result.status === "blocked-version-regression") {
    console.log("[arcaea-apk] stopped without publishing because the official version is older than the public version.");
    process.exitCode = 2;
  } else if (result.status === "blocked-mirror-size") {
    console.log("[arcaea-apk] stopped without GitHub mirror publish because the APK is at least 2 GiB.");
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
