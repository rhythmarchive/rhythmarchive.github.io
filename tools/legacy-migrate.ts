import {
  executeLegacyMigration,
  fullLegacyMigrationAllowed,
  loadRosStorageConfig,
  scanFirstMigrationPlan,
  S3StorageClient,
  validateLegacyMigrationPlan,
} from "../packages/domain/src/index.js";

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    values[key] = value && !value.startsWith("--") ? value : "true";
    if (value && !value.startsWith("--")) index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));

if (!fullLegacyMigrationAllowed()) {
  console.error("Legacy migration disabled. Set ALLOW_FULL_LEGACY_MIGRATION=1 to continue.");
  process.exitCode = 1;
} else {
  try {
    const storage = new S3StorageClient(loadRosStorageConfig());
    if (storage.status !== "READY") throw new Error("ROS credentials are not configured.");
    const runtimeRoot = args["runtime-root"] || process.env.WORKSPACE_RUNTIME_PATH || ".runtime";
    const scanOptions: Parameters<typeof scanFirstMigrationPlan>[0] = { runtimeRoot };
    const sourceRoot = args["source-root"] || process.env.LEGACY_ASSET_ROOT;
    const arcaeaApkDirectory = args["arcaea-apk-dir"] || process.env.ARCAEA_APK_DIR;
    const legacyExtractorRoot = args["legacy-project-root"] || process.env.LEGACY_PROJECT_ROOT;
    if (sourceRoot) scanOptions.sourceRoot = sourceRoot;
    if (arcaeaApkDirectory) scanOptions.arcaeaApkDirectory = arcaeaApkDirectory;
    if (legacyExtractorRoot) scanOptions.legacyExtractorRoot = legacyExtractorRoot;
    const plan = await scanFirstMigrationPlan(scanOptions);
    const validation = validateLegacyMigrationPlan(plan);
    if (!validation.valid) throw new Error(`MigrationPlan validation failed: ${validation.issues.join("; ")}`);
    if (plan.stats.blockingIssueCount > 0) throw new Error(`MigrationPlan has ${plan.stats.blockingIssueCount} blocking issue(s).`);
    let lastProgress = "";
    const result = await executeLegacyMigration({
      plan,
      storage,
      runtimeRoot,
      ...(args["catalog-path"] ? { catalogPath: args["catalog-path"] } : {}),
      ...(args["releases-dir"] ? { releasesDirectory: args["releases-dir"] } : {}),
      ...(args["report-path"] ? { reportPath: args["report-path"] } : {}),
      onProgress: (progress) => {
        const milestone = progress.stage === "prepare" || progress.stage === "catalog" || progress.stage === "complete" || progress.completed % 100 === 0;
        if (milestone && progress.message !== lastProgress) {
          lastProgress = progress.message;
          console.error(progress.message);
        }
      },
    });
    console.log(JSON.stringify({
      status: result.status,
      uploadedObjectCount: result.uploadedObjectCount,
      skippedObjectCount: result.skippedObjectCount,
      failedUploadCount: result.failedUploadCount,
      uploadedBytes: result.uploadedBytes,
      resourceCount: result.catalog.resources.length,
      objectCount: result.catalog.objects.length,
      catalogPath: result.catalogPath,
      releaseManifestPaths: result.releaseManifestPaths,
      reportPath: result.reportPath,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Legacy migration failed.");
    process.exitCode = 1;
  }
}
