import {
  checkLegacyMigrationConsistency,
  loadRosStorageConfig,
  S3StorageClient,
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

try {
  const storage = new S3StorageClient(loadRosStorageConfig());
  const checkOptions: Parameters<typeof checkLegacyMigrationConsistency>[0] = { storage };
  if (args["catalog-path"]) checkOptions.catalogPath = args["catalog-path"];
  if (args["report-path"]) checkOptions.reportPath = args["report-path"];
  const runtimeRoot = args["runtime-root"] || process.env.WORKSPACE_RUNTIME_PATH;
  if (runtimeRoot) checkOptions.runtimeRoot = runtimeRoot;
  const result = await checkLegacyMigrationConsistency(checkOptions);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Legacy consistency check failed.");
  process.exitCode = 1;
}
