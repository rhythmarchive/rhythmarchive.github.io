import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, loadCatalogFile } from "../packages/domain/src/catalog.js";
import { Game } from "../packages/domain/src/schema.js";
import { validateCatalog } from "../packages/domain/src/validation.js";
import { ExtractorResult, type ExtractorApk } from "../packages/domain/src/extractors.js";
import { getGameAdapter, listGameProfiles, type PlatformGameId } from "../packages/domain/src/platform.js";
import { buildReleaseDelta, manifestFromCatalog, manifestFromExtractorResult, readReleaseDelta, readUnifiedManifest, writeReleaseDelta, writeUnifiedManifest, UnifiedAssetManifest } from "../packages/domain/src/release.js";
import { manifestFromExternalManifest } from "../packages/domain/src/external-manifest.js";
import { approveReviewPackage, buildReviewPackage, checkReviewApproval, readReviewPackage, validateReviewPackageForDelta, writeReviewPackage } from "../packages/domain/src/review-package.js";
import { buildStorageDiff, writeStorageDiff } from "../packages/domain/src/storage-diff.js";
import { buildContentAdditionManifest, ContentAdditionInput } from "../packages/domain/src/content.js";
import { createOnboardingPlan, draftProfileFromCandidate, probeOnboardingSource, writeOnboardingArtifacts, OnboardingCandidate } from "../packages/domain/src/onboarding.js";
import { createWorkflowState, loadWorkflowState, saveWorkflowState, updateWorkflowState, workflowRoot, workflowResumeInfo, WorkflowSelectionPolicy, type WorkflowArtifact, type WorkflowKind, type WorkflowPhase, type WorkflowState } from "../packages/domain/src/workflow-state.js";
import { adapterContractFor, listRegisteredAdapters, runRegisteredExtraction } from "./adapter-registry.js";
import { runLocalReleasePreflight } from "./release-preflight.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tempRoot = path.resolve(repoRoot, "temp");

type ParsedArgs = { positionals: string[]; values: Record<string, string>; flags: Set<string> };

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      values[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      values[raw] = next;
      index += 1;
    } else {
      flags.add(raw);
    }
  }
  return { positionals, values, flags };
}

function required(args: ParsedArgs, key: string): string {
  const value = args.values[key];
  if (!value?.trim()) throw new Error("missing required option --" + key);
  return value;
}

function gameArg(args: ParsedArgs): PlatformGameId {
  return Game.parse(required(args, "game"));
}

function sourceArg(args: ParsedArgs): string {
  const value = required(args, "source");
  return /^https?:\/\//u.test(value) ? value : path.resolve(value);
}

function isInitialRelease(args: ParsedArgs): boolean {
  return args.flags.has("initial") || args.flags.has("onboarding");
}

function requirePreviousForUpdate(args: ParsedArgs, operation: string): void {
  if (!args.values.previous && !isInitialRelease(args)) throw new Error(operation + " requires --previous for an existing-game update; use --initial for a first release");
}

function tempPath(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  const relative = path.relative(tempRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(label + " must be inside repository temp/: " + resolved);
  return resolved;
}

function outputPath(args: ParsedArgs, fallback: string, label = "CLI output"): string {
  return tempPath(args.values.output ?? fallback, label);
}

function selectionPolicyPath(gameId: string): string {
  return path.join(tempRoot, "rhythmctl", "profiles", gameId, "selection-policy.json");
}

async function loadSelectionPolicy(gameId: string): Promise<WorkflowSelectionPolicy | undefined> {
  const filePath = selectionPolicyPath(gameId);
  try {
    return WorkflowSelectionPolicy.parse(await readJson(filePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function applySelectionPolicy(manifest: UnifiedAssetManifest, policy?: WorkflowSelectionPolicy): UnifiedAssetManifest {
  if (!policy || (policy.selectedAssetTypes.length === 0 && policy.excludedAssetTypes.length === 0)) return manifest;
  const selected = new Set(policy.selectedAssetTypes);
  const excluded = new Set(policy.excludedAssetTypes);
  return UnifiedAssetManifest.parse({
    ...manifest,
    entries: manifest.entries.filter((entry) => (selected.size === 0 || selected.has(entry.assetType)) && !excluded.has(entry.assetType)),
  });
}
async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8")) as unknown;
}

async function fileApk(filePath: string, role: ExtractorApk["role"], version: string): Promise<ExtractorApk> {
  const absolutePath = path.resolve(filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(role + " APK is not a file: " + absolutePath);
  return { role, version, filename: path.basename(absolutePath), absolutePath, sizeBytes: Number(info.size), verification: "unverified" };
}

async function writeOutput(filePath: string, payload: unknown): Promise<void> {
  await atomicWriteJson(tempPath(filePath, "CLI output"), payload);
}

function print(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function artifact(name: string, filePath: string, kind: WorkflowArtifact["kind"]): WorkflowArtifact {
  return { name, path: tempPath(filePath, "workflow artifact"), kind, createdAt: new Date().toISOString() };
}

function mergeArtifact(state: WorkflowState, nextArtifact: WorkflowArtifact): WorkflowArtifact[] {
  return [...state.artifacts.filter((item) => item.name !== nextArtifact.name), nextArtifact];
}

async function updateState(statePath: string, patch: Partial<Omit<WorkflowState, "kind" | "schemaVersion" | "runId" | "createdAt" | "updatedAt">>, nextArtifact?: WorkflowArtifact): Promise<WorkflowState> {
  const state = await loadWorkflowState(statePath);
  return updateWorkflowState(statePath, {
    ...patch,
    ...(nextArtifact ? { artifacts: mergeArtifact(state, nextArtifact) } : {}),
  });
}

async function loadOrCreateState(statePath: string, input: { gameId: string; version: string; sourcePath: string; sourceSnapshot?: string; candidateSlug?: string; workflowKind?: WorkflowKind; phase?: WorkflowPhase; selectionPolicy?: WorkflowSelectionPolicy }): Promise<WorkflowState> {
  const safeStatePath = tempPath(statePath, "workflow state");
  try {
    let state = await loadWorkflowState(safeStatePath);
    if (state.gameId !== input.gameId || state.version !== input.version) throw new Error("existing workflow state belongs to another game/candidate or version");
    if (input.sourceSnapshot && state.sourceSnapshot && state.sourceSnapshot !== input.sourceSnapshot) throw new Error("existing workflow state belongs to another source snapshot");
    if (input.workflowKind && state.workflowKind !== input.workflowKind) {
      if (!(state.workflowKind === "game-reconnaissance" && input.workflowKind === "game-onboarding")) throw new Error("existing workflow state belongs to another workflow kind");
      state = await updateWorkflowState(safeStatePath, { workflowKind: input.workflowKind });
    }
    return state;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    const state = createWorkflowState(input);
    await saveWorkflowState(state, safeStatePath);
    return state;
  }
}

async function requirePhase(statePath: string, ...allowed: WorkflowPhase[]): Promise<WorkflowState> {
  const state = await loadWorkflowState(statePath);
  if (!allowed.includes(state.phase)) throw new Error("workflow phase " + state.phase + " is not ready for this step; expected " + allowed.join(" or "));
  return state;
}

async function commandGames(): Promise<void> {
  print({ status: "OK", games: listGameProfiles(), adapters: listRegisteredAdapters() });
}

async function commandOnboardingProbe(args: ParsedArgs): Promise<void> {
  const slug = required(args, "slug");
  const source = sourceArg(args);
  const candidate = await probeOnboardingSource(slug, source);
  const root = outputPath(args, path.join("temp", "rhythmctl", "onboarding", candidate.slug, args.values.version ?? "reconnaissance"), "onboarding output");
  await mkdir(root, { recursive: true });
  const plan = createOnboardingPlan(candidate, {
    ...(args.values["display-name"] ? { displayName: args.values["display-name"] } : {}),
    ...(args.values.lifecycle === "onboarding" ? { lifecycle: "onboarding" as const } : {}),
  });
  const paths = await writeOnboardingArtifacts(root, candidate, plan);
  const statePath = path.join(root, "state.json");
  let state = await loadOrCreateState(statePath, {
    gameId: candidate.slug,
    candidateSlug: candidate.slug,
    workflowKind: "game-reconnaissance",
    version: args.values.version ?? "reconnaissance",
    sourcePath: candidate.sourcePath,
    sourceSnapshot: candidate.sourceSnapshot,
  });
  state = await updateState(statePath, {
    sourceSnapshot: candidate.sourceSnapshot,
    completedSteps: ["probe"],
    phase: candidate.exists ? "reconnaissance-complete" : "blocked",
    blockers: candidate.exists ? [] : candidate.diagnostics,
  }, artifact("probe", paths.probePath, "probe"));
  state = await updateState(statePath, {
    artifacts: mergeArtifact(state, artifact("draft-profile", paths.profilePath, "profile")),
  });
  state = await updateState(statePath, {
    artifacts: mergeArtifact(state, artifact("analysis-report", paths.reportPath, "analysis-report")),
  });
  print({ status: candidate.exists ? "OK" : "BLOCKED", candidate, profile: plan.profile, output: paths, statePath, state, next: workflowResumeInfo(state) });
  if (!candidate.exists) process.exitCode = 2;
}

async function commandOnboardingPlan(args: ParsedArgs): Promise<void> {
  const candidatePath = path.resolve(required(args, "probe"));
  const candidate = OnboardingCandidate.parse(await readJson(candidatePath));
  const plan = createOnboardingPlan(candidate, {
    ...(args.values["display-name"] ? { displayName: args.values["display-name"] } : {}),
    ...(args.values.lifecycle === "onboarding" ? { lifecycle: "onboarding" as const } : {}),
    ...(args.values.select ? { selectedAssetTypes: args.values.select.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
    ...(args.values.exclude ? { excludedAssetTypes: args.values.exclude.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
    ...(args.values.rationale ? { rationale: args.values.rationale } : {}),
  });
  const version = args.values.version ?? "reconnaissance";
  const root = workflowRoot(candidate.slug, version, path.join(tempRoot, "rhythmctl", "onboarding"));
  await mkdir(root, { recursive: true });
  const output = args.values.output ? outputPath(args, args.values.output) : path.join(root, "onboarding-plan.json");
  await writeOutput(output, plan);
  const persistedPolicyPath = selectionPolicyPath(candidate.slug);
  await writeOutput(persistedPolicyPath, plan.profile.selectionPolicy);
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  const workflowKind: WorkflowKind = plan.profile.lifecycle === "onboarding" ? "game-onboarding" : "game-reconnaissance";
  let state = await loadOrCreateState(statePath, { gameId: candidate.slug, candidateSlug: candidate.slug, version, sourcePath: candidate.sourcePath, sourceSnapshot: candidate.sourceSnapshot, workflowKind, phase: "reconnaissance-complete", selectionPolicy: plan.profile.selectionPolicy });
  state = await updateState(statePath, { workflowKind, selectionPolicy: plan.profile.selectionPolicy }, artifact("onboarding-plan", output, "plan"));
  state = await updateState(statePath, {}, artifact("selection-policy", persistedPolicyPath, "plan"));
  print({ status: "OK", output, persistedPolicyPath, statePath, state, plan });
}

async function commandProbe(args: ParsedArgs): Promise<void> {
  if (args.values.slug && !args.values.game) return commandOnboardingProbe(args);
  const game = gameArg(args);
  const source = sourceArg(args);
  const adapter = getGameAdapter(game);
  const probe = await adapter.probe(source);
  const plan = adapter.planExtraction(probe);
  const version = args.values.version ?? "probe-" + Date.now();
  const root = outputPath(args, workflowRoot(game, version), "workflow output");
  await mkdir(root, { recursive: true });
  const target = path.join(root, "probe.json");
  const statePath = path.join(root, "state.json");
  await writeOutput(target, { profile: adapter.profile, probe, plan });
  const workflowKind: WorkflowKind = isInitialRelease(args) ? "game-onboarding" : "game-update";
  let state = await loadOrCreateState(statePath, { gameId: game, version, sourcePath: source, sourceSnapshot: probe.snapshot, workflowKind });
  state = await updateState(statePath, {
    sourceSnapshot: probe.snapshot,
    completedSteps: ["probe"],
    phase: plan.supported ? "probe" : "blocked",
    blockers: plan.supported ? [] : plan.diagnostics,
  }, artifact("probe", target, "probe"));
  print({ status: plan.supported ? "OK" : "BLOCKED", game, source, output: target, probe, plan, statePath, state, next: workflowResumeInfo(state) });
  if (!plan.supported) process.exitCode = 2;
}

async function commandIngest(args: ParsedArgs): Promise<void> {
  const game = gameArg(args);
  const version = required(args, "version");
  const source = sourceArg(args);
  const configuredRoot = args.values.root ? tempPath(args.values.root, "workflow root") : path.resolve("temp", "rhythmctl");
  const root = workflowRoot(game, version, configuredRoot);
  await mkdir(root, { recursive: true });
  const statePath = path.join(root, "state.json");
  const workflowKind: WorkflowKind = isInitialRelease(args) ? "game-onboarding" : "game-update";
  let state = await loadOrCreateState(statePath, { gameId: game, version, sourcePath: source, workflowKind });
  const adapter = getGameAdapter(game);
  const probe = await adapter.probe(source);
  const plan = adapter.planExtraction(probe);
  const probePath = path.join(root, "probe.json");
  const planPath = path.join(root, "extraction-plan.json");
  await writeOutput(probePath, probe);
  await writeOutput(planPath, plan);
  state = await updateState(statePath, {
    sourceSnapshot: probe.snapshot,
    phase: plan.supported ? "ingest" : "blocked",
    blockers: plan.supported ? [] : plan.diagnostics,
  }, artifact("probe", probePath, "probe"));
  state = await updateState(statePath, {
    artifacts: mergeArtifact(state, artifact("extraction-plan", planPath, "plan")),
  });
  print({ status: plan.supported ? "OK" : "BLOCKED", game, version, root, statePath, state, probePath, planPath, next: workflowResumeInfo(state) });
  if (!plan.supported) process.exitCode = 2;
}

async function commandExtract(args: ParsedArgs): Promise<void> {
  const game = gameArg(args);
  const version = args.values.version ?? args.values["target-version"] ?? required(args, "version");
  requirePreviousForUpdate(args, "extract");
  const workflowKind: WorkflowKind = isInitialRelease(args) ? "game-onboarding" : "game-update";
  const root = outputPath(args, workflowRoot(game, version, path.resolve("temp", "rhythmctl")), "workflow output");
  await mkdir(root, { recursive: true });
  const statePath = path.join(root, "state.json");
  const source = args.values.source
    ? sourceArg(args)
    : args.values["target-apk"]
      ? path.resolve(args.values["target-apk"])
      : args.values.apk
        ? path.resolve(args.values.apk)
        : args.values["game-root"]
          ? path.resolve(args.values["game-root"])
          : path.resolve(args.values.report ?? root);
  const inheritedSelectionPolicy = await loadSelectionPolicy(game);
  let state = await loadOrCreateState(statePath, { gameId: game, version, sourcePath: source, workflowKind, ...(inheritedSelectionPolicy ? { selectionPolicy: inheritedSelectionPolicy } : {}) });
  if (inheritedSelectionPolicy && !state.selectionPolicy) state = await updateState(statePath, { selectionPolicy: inheritedSelectionPolicy }, artifact("selection-policy", selectionPolicyPath(game), "plan"));
  await requirePhase(statePath, "ingest", "extract");
  const options = {
    game,
    version,
    repoRoot,
    outputDir: root,
    ...(args.values.report ? { reportPath: args.values.report } : {}),
    ...(args.values["base-version"] ? { baseVersion: args.values["base-version"] } : {}),
    ...(args.values["target-version"] ? { targetVersion: args.values["target-version"] } : {}),
    ...(args.values["base-apk"] ? { baseApk: await fileApk(args.values["base-apk"], "base", args.values["base-version"] ?? "base") } : {}),
    ...(args.values["target-apk"] ? { targetApk: await fileApk(args.values["target-apk"], "target", args.values["target-version"] ?? version) } : {}),
    ...(args.values.snapshot ? { sourceSnapshot: args.values.snapshot } : {}),
    ...(args.values.workspace ? { workspacePath: tempPath(args.values.workspace, "workspace output") } : {}),
    ...(args.values.apk ? { apk: args.values.apk } : {}),
    ...(args.values.cache ? { cacheRoot: tempPath(args.values.cache, "cache output") } : {}),
    ...(args.values["game-root"] ? { gameRoot: args.values["game-root"] } : {}),
    ...(args.values.previous ? { previousManifest: args.values.previous } : {}),
  };
  let result;
  try {
    result = await runRegisteredExtraction(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = await updateWorkflowState(statePath, { phase: "blocked", blockers: [message], errors: [...state.errors, message] });
    print({ status: "BLOCKED", game, version, statePath, state, message });
    process.exitCode = 2;
    return;
  }
  if (result.status === "OK" && result.manifestPath && state.selectionPolicy) {
    const extracted = await readUnifiedManifest(result.manifestPath);
    await writeUnifiedManifest(applySelectionPolicy(extracted, state.selectionPolicy), result.manifestPath);
  }
  const next = result.manifestPath ? artifact("candidate-manifest", result.manifestPath, "manifest") : undefined;
  state = await updateState(statePath, {
    phase: result.status === "OK" ? "extract" : "blocked",
    ...(result.manifestPath ? { manifestPath: result.manifestPath } : {}),
    blockers: result.status === "OK" ? [] : result.diagnostics,
  }, next);
  print({ ...result, statePath, state, next: workflowResumeInfo(state) });
  if (result.status !== "OK") process.exitCode = 2;
}

async function commandNormalize(args: ParsedArgs): Promise<void> {
  const inputPath = path.resolve(required(args, "input"));
  const value = await readJson(inputPath);
  const extractor = ExtractorResult.safeParse(value);
  let manifest: UnifiedAssetManifest;
  if (extractor.success) {
    manifest = await manifestFromExtractorResult(extractor.data, args.values.version ? { version: args.values.version } : {});
  } else if (UnifiedAssetManifest.safeParse(value).success) {
    manifest = UnifiedAssetManifest.parse(value);
  } else {
    const catalogResult = validateCatalog(value);
    if (catalogResult.success) {
      manifest = manifestFromCatalog(catalogResult.data, gameArg(args), required(args, "version"));
    } else {
      manifest = manifestFromExternalManifest(value, { gameId: gameArg(args), version: required(args, "version") });
    }
  }
  const root = workflowRoot(manifest.gameId, manifest.version);
  await mkdir(root, { recursive: true });
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  await ensureStateForArtifact(statePath, manifest.gameId, manifest.version, "extract", manifest.sourceSnapshot);
  await requirePhase(statePath, "extract");
  const output = args.values.output ? outputPath(args, args.values.output) : path.join(root, "candidate-manifest.json");
  await writeUnifiedManifest(manifest, output);
  const state = await updateState(statePath, { phase: "normalize", manifestPath: output }, artifact("candidate-manifest", output, "manifest"));
  print({ status: "OK", input: inputPath, output, game: manifest.gameId, version: manifest.version, entries: manifest.entries.length, statePath, state, next: workflowResumeInfo(state) });
}

async function commandContentAdd(args: ParsedArgs): Promise<void> {
  const inputPath = path.resolve(required(args, "input"));
  const input = ContentAdditionInput.parse(await readJson(inputPath));
  const previous = args.values.previous ? await readUnifiedManifest(args.values.previous) : undefined;
  const manifest = buildContentAdditionManifest(input, previous);
  const root = workflowRoot(input.gameId, input.version);
  await mkdir(root, { recursive: true });
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  let state = await loadOrCreateState(statePath, { gameId: input.gameId, version: input.version, sourcePath: inputPath, sourceSnapshot: manifest.sourceSnapshot, workflowKind: "content-addition" });
  const inputCopy = path.join(root, "content-addition.json");
  const manifestPath = args.values.output ? outputPath(args, args.values.output) : path.join(root, "candidate-manifest.json");
  await writeOutput(inputCopy, input);
  await writeUnifiedManifest(manifest, manifestPath);
  state = await updateState(statePath, { workflowKind: "content-addition", phase: "normalize", manifestPath }, artifact("content-input", inputCopy, "plan"));
  state = await updateState(statePath, { manifestPath }, artifact("candidate-manifest", manifestPath, "manifest"));
  print({ status: "OK", root, input: inputPath, manifestPath, statePath, state, next: workflowResumeInfo(state) });
}

async function commandDiff(args: ParsedArgs): Promise<void> {
  const currentPath = path.resolve(required(args, "current"));
  const current = await readUnifiedManifest(currentPath);
  const workflowKind: WorkflowKind = isInitialRelease(args) ? "game-onboarding" : "game-update";
  const previous = args.values.previous ? await readUnifiedManifest(args.values.previous) : undefined;
  const delta = buildReleaseDelta(previous, current);
  const root = workflowRoot(current.gameId, current.version);
  await mkdir(root, { recursive: true });
  const currentManifestPath = path.join(root, "candidate-manifest.json");
  const output = args.values.output ? outputPath(args, args.values.output) : path.join(root, "release-delta.json");
  await writeUnifiedManifest(current, currentManifestPath);
  await writeReleaseDelta(delta, output);
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  let state = await ensureStateForArtifact(statePath, current.gameId, current.version, "normalize", current.sourceSnapshot);
  await requirePhase(statePath, "normalize", "diff");
  if (!args.values.previous && !isInitialRelease(args) && state.workflowKind !== "content-addition") requirePreviousForUpdate(args, "diff");
  state = await updateState(statePath, { manifestPath: currentManifestPath }, artifact("candidate-manifest", currentManifestPath, "manifest"));
  state = await updateState(statePath, { phase: "diff", deltaPath: output }, artifact("release-delta", output, "delta"));
  print({ status: "OK", output, summary: delta.summary, statePath, state, next: workflowResumeInfo(state) });
}

async function commandReview(args: ParsedArgs): Promise<void> {
  const deltaPath = path.resolve(required(args, "delta"));
  const delta = await readReleaseDelta(deltaPath);
  const review = buildReviewPackage(delta);
  const root = workflowRoot(delta.gameId, delta.currentVersion);
  await mkdir(root, { recursive: true });
  const deltaCopy = path.join(root, "release-delta.json");
  const output = args.values.output ? outputPath(args, args.values.output) : path.join(root, "review-package.json");
  await writeReleaseDelta(delta, deltaCopy);
  await writeReviewPackage(review, output);
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  let state = await ensureStateForArtifact(statePath, delta.gameId, delta.currentVersion, "diff");
  await requirePhase(statePath, "diff", "review");
  state = await updateState(statePath, { deltaPath: deltaCopy }, artifact("release-delta", deltaCopy, "delta"));
  state = await updateState(statePath, { phase: "review", reviewPath: output, reviewStatus: review.status === "pending" ? "pending" : "not-required" }, artifact("review-package", output, "review"));
  print({ status: review.status === "pending" ? "PENDING_REVIEW" : "OK", output, summary: review.summary, anomalies: review.anomalies, statePath, state, next: workflowResumeInfo(state) });
}

async function ensureStateForArtifact(statePath: string, gameId: string, version: string, phase: WorkflowPhase = "probe", sourceSnapshot?: string): Promise<WorkflowState> {
  const safeStatePath = tempPath(statePath, "workflow state");
  try {
    const state = await loadWorkflowState(safeStatePath);
    if (state.gameId !== gameId || state.version !== version) throw new Error("existing workflow state belongs to another game or version");
    if (sourceSnapshot && state.sourceSnapshot && state.sourceSnapshot !== sourceSnapshot) throw new Error("existing workflow state belongs to another source snapshot");
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(phase + " requires an existing workflow state at " + safeStatePath + "; run prior workflow steps first");
    throw error;
  }
}

async function commandApprove(args: ParsedArgs): Promise<void> {
  const reviewPath = path.resolve(required(args, "review"));
  const review = await readReviewPackage(reviewPath);
  const approved = approveReviewPackage(review, required(args, "reviewer"));
  const root = workflowRoot(approved.gameId, approved.version);
  await mkdir(root, { recursive: true });
  const reviewCopy = path.join(root, "review-package.json");
  const output = args.values.output ? outputPath(args, args.values.output) : path.join(root, "approved-review.json");
  await writeReviewPackage(review, reviewCopy);
  await writeReviewPackage(approved, output);
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  let state = await ensureStateForArtifact(statePath, approved.gameId, approved.version, "review");
  await requirePhase(statePath, "review");
  state = await updateState(statePath, { reviewPath: reviewCopy }, artifact("review-package", reviewCopy, "review"));
  state = await updateState(statePath, { phase: "approved", reviewPath: output, reviewStatus: "approved" }, artifact("approved-review", output, "review"));
  print({ status: "OK", output, statePath, state, reviewer: approved.reviewer, approvedAt: approved.approvedAt, approvedChangeCount: approved.approvedChangeKeys.length, next: workflowResumeInfo(state) });
}

async function commandCheckApproval(args: ParsedArgs): Promise<void> {
  const reviewPath = path.resolve(required(args, "review"));
  const result = await checkReviewApproval(reviewPath);
  print({ status: result.approved ? "APPROVED" : "PENDING_REVIEW", review: result.review });
  if (!result.approved) process.exitCode = 2;
}

async function commandStorageDiff(args: ParsedArgs): Promise<void> {
  const localPath = path.resolve(required(args, "local"));
  const local = await readUnifiedManifest(localPath);
  const published = args.values.published ? await readUnifiedManifest(args.values.published) : undefined;
  const diff = buildStorageDiff(local, published);
  const root = workflowRoot(local.gameId, local.version);
  await mkdir(root, { recursive: true });
  const localCopy = path.join(root, "candidate-manifest.json");
  const output = args.values.output ? outputPath(args, args.values.output) : path.join(root, "storage-diff.json");
  await writeUnifiedManifest(local, localCopy);
  await writeStorageDiff(diff, output);
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  let state = await ensureStateForArtifact(statePath, local.gameId, local.version, "diff");
  state = await updateState(statePath, { manifestPath: localCopy }, artifact("candidate-manifest", localCopy, "manifest"));
  state = await updateState(statePath, {}, artifact("storage-diff", output, "storage-diff"));
  print({ status: "OK", output, summary: diff.summary, statePath, state });
}

async function commandReleasePrepare(args: ParsedArgs): Promise<void> {
  const currentPath = path.resolve(required(args, "current"));
  const current = await readUnifiedManifest(currentPath);
  const initial = isInitialRelease(args);
  const workflowKind: WorkflowKind = initial ? "game-onboarding" : "game-update";
  const previous = args.values.previous ? await readUnifiedManifest(args.values.previous) : undefined;
  const published = args.values.published ? await readUnifiedManifest(args.values.published) : undefined;
  const delta = buildReleaseDelta(previous, current);
  const root = outputPath(args, path.join(workflowRoot(current.gameId, current.version), "release-prepare"), "release output");
  await mkdir(root, { recursive: true });
  const currentCopy = path.join(root, "candidate-manifest.json");
  const deltaPath = path.join(root, "release-delta.json");
  const reviewPath = path.join(root, "review-package.json");
  const storagePath = path.join(root, "storage-diff.json");
  const preflightPath = path.join(root, "preflight.json");
  const planPath = path.join(root, "release-plan.json");
  await writeUnifiedManifest(current, currentCopy);
  await writeReleaseDelta(delta, deltaPath);
  const review = args.values.review ? await readReviewPackage(args.values.review) : buildReviewPackage(delta);
  await writeReviewPackage(review, reviewPath);
  const reviewValidation = validateReviewPackageForDelta(review, delta);
  if (!reviewValidation.valid) throw new Error("review package does not match release delta: " + reviewValidation.reasons.join("; "));
  const approved = review.status === "approved" || review.status === "not-required";
  const statePath = args.values.state ? tempPath(args.values.state, "workflow state") : path.join(root, "state.json");
  let nextState = await ensureStateForArtifact(statePath, current.gameId, current.version, "normalize", current.sourceSnapshot);
  await requirePhase(statePath, "normalize", "diff", "review", "approved");
  nextState = await updateState(statePath, { manifestPath: currentCopy }, artifact("candidate-manifest", currentCopy, "manifest"));
  if (!args.values.previous && !initial && nextState.workflowKind !== "content-addition") requirePreviousForUpdate(args, "release prepare");
  if (!initial && !args.values.published) throw new Error("release prepare requires --published for an existing-game storage diff; use --initial for a first release");
  if (nextState.phase === "normalize") nextState = await updateState(statePath, { phase: "diff", deltaPath }, artifact("release-delta", deltaPath, "delta"));
  else nextState = await updateState(statePath, { deltaPath }, artifact("release-delta", deltaPath, "delta"));
  if (nextState.phase === "diff") nextState = await updateState(statePath, { phase: "review", reviewPath, reviewStatus: approved ? "approved" : "pending" }, artifact("review-package", reviewPath, "review"));
  else if (nextState.phase === "review") nextState = await updateState(statePath, { reviewPath, reviewStatus: approved ? "approved" : "pending" }, artifact("review-package", reviewPath, "review"));
  if (!approved) {
    print({ status: "PENDING_REVIEW", deltaPath, reviewPath, summary: delta.summary, remoteWrite: "DISABLED", statePath, state: nextState, next: workflowResumeInfo(nextState) });
    process.exitCode = 2;
    return;
  }
  if (nextState.phase === "review") nextState = await updateState(statePath, { phase: "approved", reviewPath, reviewStatus: "approved" }, artifact("approved-review", reviewPath, "review"));
  if (nextState.phase !== "approved") throw new Error("release prepare requires an approved workflow state");
  const storage = buildStorageDiff(current, published);
  await writeStorageDiff(storage, storagePath);
  nextState = await updateState(statePath, {}, artifact("storage-diff", storagePath, "storage-diff"));
  let preflight;
  try {
    preflight = await runLocalReleasePreflight(repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nextState = await updateWorkflowState(statePath, { phase: "blocked", blockers: ["local release preflight failed: " + message], errors: [...nextState.errors, message] });
    print({ status: "BLOCKED", statePath, state: nextState, message });

    process.exitCode = 2;
    return;
  }
  await writeOutput(preflightPath, preflight);
  await writeOutput(planPath, { kind: "rhythm-local-release-plan", schemaVersion: "1", gameId: current.gameId, version: current.version, currentManifest: currentCopy, previousManifest: args.values.previous ?? null, publishedManifest: args.values.published ?? null, delta: deltaPath, review: reviewPath, storageDiff: storagePath, preflight: preflightPath, remoteWrite: "DISABLED" });
  nextState = await updateState(statePath, { phase: "release-prepared", publishStatus: "prepared", releasePlanPath: planPath }, artifact("preflight", preflightPath, "verification"));
  nextState = await updateState(statePath, { releasePlanPath: planPath }, artifact("release-plan", planPath, "release-plan"));
  print({ status: "READY_LOCAL_ONLY", deltaPath, reviewPath, storagePath, preflightPath, planPath, summary: delta.summary, remoteWrite: "DISABLED", statePath, state: nextState, next: workflowResumeInfo(nextState) });
}
async function commandStatus(args: ParsedArgs): Promise<void> {
  const statePath = args.values.state
    ? tempPath(args.values.state, "workflow state")
    : args.values.game && args.values.version
      ? path.join(workflowRoot(Game.parse(args.values.game), args.values.version), "state.json")
      : args.values.slug && args.values.version
        ? path.join(workflowRoot(args.values.slug, args.values.version), "state.json")
        : undefined;
  if (!statePath) throw new Error("status requires --state or --game/--version or --slug/--version");
  const state = await loadWorkflowState(statePath);
  print({ status: "OK", statePath, state, resume: workflowResumeInfo(state) });
}

async function commandResume(args: ParsedArgs): Promise<void> {
  const statePath = tempPath(required(args, "state"), "workflow state");
  let state = await loadWorkflowState(statePath);
  if (state.phase === "blocked" && args.flags.has("resolve")) {
    if (!state.resumePhase) throw new Error("blocked workflow has no saved resume phase");
    state = await updateWorkflowState(statePath, { phase: state.resumePhase, blockers: [] });
    print({ status: "RESUMED", statePath, state, resume: workflowResumeInfo(state), instruction: "rerun the owning workflow step; existing artifacts are preserved" });
    return;
  }
  const resume = workflowResumeInfo(state);
  print({ status: state.phase === "complete" ? "COMPLETE" : state.phase === "blocked" ? "BLOCKED" : "RESUMABLE", statePath, state, resume, instruction: state.phase === "blocked" ? "resolve the listed blocker, then rerun with --resolve" : state.phase === "complete" ? "workflow is complete; no further step is required" : "rerun the command named by resume.nextStep; existing artifacts and state are preserved" });
  if (state.phase === "blocked") process.exitCode = 2;
}

async function commandVerify(args: ParsedArgs): Promise<void> {
  const catalogPath = path.resolve(args.values.catalog ?? path.join(repoRoot, "catalog", "index.json"));
  const catalog = await loadCatalogFile(catalogPath);
  const checks: Record<string, string> = { catalog: "PASS" };
  if (args.values.manifest) { await readUnifiedManifest(args.values.manifest); checks.manifest = "PASS"; }
  const delta = args.values.delta ? await readReleaseDelta(args.values.delta) : undefined;
  if (delta) checks.delta = "PASS";
  const review = args.values.review ? await readReviewPackage(args.values.review) : undefined;
  if (review) {
    checks.review = review.status;
    if (delta) {
      const validation = validateReviewPackageForDelta(review, delta);
      if (!validation.valid) throw new Error("review package does not match delta: " + validation.reasons.join("; "));
      checks.reviewDelta = "PASS";
    }
  }
  if (args.values.state) {
    const statePath = tempPath(args.values.state, "workflow state");
    let state = await loadWorkflowState(statePath);
    await requirePhase(statePath, "release-prepared");
    const verificationPath = path.join(path.dirname(statePath), "verification.json");
    checks.workflow = "PASS";
    await writeOutput(verificationPath, { catalogPath, resources: catalog.resources.length, checks });
    state = await updateState(statePath, { phase: "verified", publishStatus: "complete" }, artifact("verification", verificationPath, "verification"));
    state = await updateState(statePath, { phase: "complete" });
    print({ status: "PASS", catalogPath, resources: catalog.resources.length, checks, statePath, verificationPath, state });
    return;
  }
  print({ status: "PASS", catalogPath, resources: catalog.resources.length, checks });
}

async function commandBuild(args: ParsedArgs): Promise<void> {
  if (args.flags.has("catalog-only")) {
    const catalog = await loadCatalogFile(path.join(repoRoot, "catalog", "index.json"));
    print({ status: "PASS", mode: "catalog-only", resources: catalog.resources.length });
    return;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = await execFileAsync(npm, ["run", "site:build"], { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 });
  print({ status: "PASS", command: "npm run site:build", stdoutTail: result.stdout.slice(-2000), stderrTail: result.stderr.slice(-2000) });
}

async function main(): Promise<void> {
  const [command, ...tokens] = process.argv.slice(2);
  const args = parseArgs(tokens);
  if (!command || command === "help" || args.flags.has("help")) {
    print({ usage: "rhythmctl <games|probe|onboard probe|onboard plan|ingest|extract|normalize|content add|diff|review|approve|check-approval|status|resume|build|verify|release prepare|storage diff>", tempRoot: path.resolve("temp", "rhythmctl") });
    return;
  }
  if (command === "games") return commandGames();
  if (command === "probe") return commandProbe(args);
  if (command === "onboard" && args.positionals[0] === "probe") return commandOnboardingProbe(args);
  if (command === "onboard" && args.positionals[0] === "plan") return commandOnboardingPlan(args);
  if (command === "ingest") return commandIngest(args);
  if (command === "extract") return commandExtract(args);
  if (command === "normalize") return commandNormalize(args);
  if (command === "content" && args.positionals[0] === "add") return commandContentAdd(args);
  if (command === "diff") return commandDiff(args);
  if (command === "review") return commandReview(args);
  if (command === "approve") return commandApprove(args);
  if (command === "check-approval") return commandCheckApproval(args);
  if (command === "status") return commandStatus(args);
  if (command === "resume") return commandResume(args);
  if (command === "build") return commandBuild(args);
  if (command === "verify") return commandVerify(args);
  if (command === "storage" && args.positionals[0] === "diff") return commandStorageDiff(args);
  if (command === "release" && args.positionals[0] === "prepare") return commandReleasePrepare(args);
  throw new Error("unknown command: " + [command, ...args.positionals].join(" "));
}

main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
});
