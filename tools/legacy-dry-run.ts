import { scanFirstMigrationPlan } from "../packages/domain/src/index.js";

function countCodes(items: Array<{ code: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.code] = (counts[item.code] ?? 0) + 1;
    return counts;
  }, {});
}

function parseArgs(argv: string[]): { values: Record<string, string>; positional: string[] } {
  const parsed: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      if (arg) positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = value;
      index += 1;
    }
  }
  return { values: parsed, positional };
}

const parsedArgs = parseArgs(process.argv.slice(2));
const args = parsedArgs.values;
const sourceRoot = args["source-root"] || parsedArgs.positional[0] || process.env.LEGACY_ASSET_ROOT || undefined;
const arcaeaApkDirectory = args["arcaea-apk-dir"] || process.env.ARCAEA_APK_DIR || undefined;
const legacyExtractorRoot = args["legacy-project-root"] || process.env.LEGACY_PROJECT_ROOT || undefined;
const runtimeRoot = args["runtime-root"] || process.env.WORKSPACE_RUNTIME_PATH || undefined;
const plan = await scanFirstMigrationPlan({
  ...(sourceRoot ? { sourceRoot } : {}),
  ...(arcaeaApkDirectory ? { arcaeaApkDirectory } : {}),
  ...(legacyExtractorRoot ? { legacyExtractorRoot } : {}),
  ...(runtimeRoot ? { runtimeRoot } : {}),
});
console.log(JSON.stringify({
  sourceRoot: plan.sourceRoot,
  sourceSummary: plan.sourceSummary,
  scannedAt: plan.scannedAt,
  readOnly: plan.readOnly,
  stats: plan.stats,
  blockingIssues: { count: plan.blockingIssues.length, byCode: countCodes(plan.blockingIssues), samples: plan.blockingIssues.slice(0, 20) },
  warnings: { count: plan.warnings.length, byCode: countCodes(plan.warnings), samples: plan.warnings.slice(0, 20) },
  notes: plan.notes,
}, null, 2));
