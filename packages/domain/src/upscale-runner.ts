import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  convertSelectedUpscale,
  loadWorkspaceState,
  markUpscaleFailure,
  prepareUpscaleInputs,
  reconcileUpscaleOutputs,
  selectUpscaleAttempt,
  skipUpscaleForCandidate,
  type UpscaleInputPreparationResult,
} from "./workspace.js";
import { effectiveCandidateResourceType, isUpscaleEligible } from "./review.js";
import { realEsrganFingerprint, resolveRealEsrganConfig, runRealEsrgan, verifyRealEsrganOutput, type RealEsrganConfig, type RealEsrganRunResult } from "./real-esrgan.js";

const AUTO_UPSCALE_FILE = "metadata/real-esrgan.json";

type AutoUpscaleRecord = {
  candidateId: string;
  inputSha256: string;
  fingerprint: string;
  inputRelativePath: string;
  outputRelativePath: string;
  status: "completed" | "failed";
  exitCode: number | null;
  command: string;
  stderr?: string;
  updatedAt: string;
};

export type UpscaleBatchResult = {
  rootPath: string;
  completedCandidateIds: string[];
  reusedCandidateIds: string[];
  failed: Array<{ candidateId: string; message: string }>;
  skippedCandidateIds: string[];
  configFingerprint: string;
};

async function readRecords(rootPath: string): Promise<AutoUpscaleRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(rootPath, AUTO_UPSCALE_FILE), "utf8")) as { entries?: AutoUpscaleRecord[] };
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}

async function writeRecords(rootPath: string, entries: AutoUpscaleRecord[]): Promise<void> {
  const fs = await import("node:fs/promises");
  const filePath = path.join(rootPath, AUTO_UPSCALE_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.partial-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: "1.0", generatedAt: new Date().toISOString(), entries }, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function outputRelativePath(inputRelativePath: string): string {
  const filename = path.posix.basename(inputRelativePath);
  return `upscale-output/${filename}_optimization.png`;
}

function inputPath(rootPath: string, relativePath: string): string {
  return path.resolve(rootPath, relativePath);
}

async function runOne(options: { rootPath: string; entry: UpscaleInputPreparationResult["entries"][number]; config: RealEsrganConfig; records: AutoUpscaleRecord[]; force: boolean }): Promise<{ record: AutoUpscaleRecord; result?: RealEsrganRunResult; reused: boolean }> {
  const inputRelativePath = `upscale-input/${options.entry.inputFilename}`;
  const outputRelativePathValue = outputRelativePath(inputRelativePath);
  const existing = options.records.find((record) => record.candidateId === options.entry.candidateId && record.inputSha256 === options.entry.sourceHash && record.fingerprint === realEsrganFingerprint(options.config) && record.outputRelativePath === outputRelativePathValue);
  if (!options.force && existing) {
    const verification = await verifyRealEsrganOutput(inputPath(options.rootPath, existing.inputRelativePath), inputPath(options.rootPath, existing.outputRelativePath), options.config.scale);
    if (verification.ok) return { record: existing, reused: true };
  }
  const result = await runRealEsrgan({ config: options.config, inputPath: inputPath(options.rootPath, inputRelativePath), outputPath: inputPath(options.rootPath, outputRelativePathValue) });
  const record: AutoUpscaleRecord = {
    candidateId: options.entry.candidateId,
    inputSha256: options.entry.sourceHash,
    fingerprint: result.fingerprint,
    inputRelativePath,
    outputRelativePath: outputRelativePathValue,
    status: result.status,
    exitCode: result.exitCode,
    command: [result.command.command, ...result.command.args].join(" "),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    updatedAt: new Date().toISOString(),
  };
  return { record, result, reused: false };
}

export async function runUpscaleBatch(options: { rootPath: string; candidateIds?: string[]; config?: RealEsrganConfig; force?: boolean } ): Promise<UpscaleBatchResult> {
  const handle = await loadWorkspaceState(options.rootPath);
  const config = options.config ?? await resolveRealEsrganConfig();
  const selected = new Set(options.candidateIds ?? handle.candidates.map((candidate) => candidate.id));
  const eligible = handle.candidates.filter((candidate) => selected.has(candidate.id) && candidate.processing.requiresUpscale && isUpscaleEligible(handle.batch.game, effectiveCandidateResourceType(candidate)) && candidate.review.confirmed && candidate.review.disposition === "active");
  const skippedCandidateIds = handle.candidates.filter((candidate) => selected.has(candidate.id) && !eligible.some((item) => item.id === candidate.id)).map((candidate) => candidate.id);
  const preparation = await prepareUpscaleInputs(options.rootPath, { candidateIds: eligible.map((candidate) => candidate.id) });
  const records = await readRecords(options.rootPath);
  const nextRecords = [...records];
  const completedCandidateIds: string[] = [];
  const reusedCandidateIds: string[] = [];
  const failed: Array<{ candidateId: string; message: string }> = [];
  for (const entry of preparation.entries) {
    try {
      const run = await runOne({ rootPath: options.rootPath, entry, config, records: nextRecords, force: options.force === true });
      const existingIndex = nextRecords.findIndex((record) => record.candidateId === entry.candidateId);
      if (existingIndex >= 0) nextRecords[existingIndex] = run.record;
      else nextRecords.push(run.record);
      if (run.record.status !== "completed") {
        const message = run.result
          ? `Real-ESRGAN failed (exit code ${run.result.exitCode ?? "unknown"}): ${run.result.verification.message}`
          : "Real-ESRGAN failed";
        await markUpscaleFailure(options.rootPath, entry.candidateId, message);
        failed.push({ candidateId: entry.candidateId, message });
        continue;
      }
      await reconcileUpscaleOutputs(options.rootPath);
      const afterScan = await loadWorkspaceState(options.rootPath);
      const candidate = afterScan.candidates.find((item) => item.id === entry.candidateId);
      const outputFilename = path.posix.basename(run.record.outputRelativePath);
      const outputFile = candidate?.files.find((file) => file.role === "upscale-output" && file.filename.toLowerCase() === outputFilename.toLowerCase());
      if (!candidate || !outputFile) throw new Error("超分输出已生成，但无法可靠绑定到候选资源");
      const refreshed = await loadWorkspaceState(options.rootPath);
      const selectedCandidate = refreshed.candidates.find((item) => item.id === entry.candidateId);
      if (!selectedCandidate?.processing.selectedOutputFileId) await selectUpscaleAttempt(options.rootPath, entry.candidateId, outputFile.id);
      if (!run.reused || !selectedCandidate?.processing.processedFileId || !selectedCandidate.processing.conversion) {
        const converted = await convertSelectedUpscale(options.rootPath, entry.candidateId);
        if (converted.conversion.status !== "converted" && converted.conversion.status !== "skipped") throw new Error(converted.conversion.message || "超分结果转换失败");
      }
      completedCandidateIds.push(entry.candidateId);
      if (run.reused) reusedCandidateIds.push(entry.candidateId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markUpscaleFailure(options.rootPath, entry.candidateId, message);
      failed.push({ candidateId: entry.candidateId, message });
    }
    await writeRecords(options.rootPath, nextRecords);
  }
  await writeRecords(options.rootPath, nextRecords);
  return { rootPath: options.rootPath, completedCandidateIds, reusedCandidateIds, failed, skippedCandidateIds, configFingerprint: `${config.executable}|${config.modelDir}|${config.modelName}|scale=${config.scale}|tile=${config.tile}|gpu=${config.gpu}|jobs=${config.jobs}` };
}

export async function retryUpscaleCandidate(rootPath: string, candidateId: string, config?: RealEsrganConfig): Promise<UpscaleBatchResult> {
  return runUpscaleBatch({ rootPath, candidateIds: [candidateId], ...(config ? { config } : {}), force: true });
}
