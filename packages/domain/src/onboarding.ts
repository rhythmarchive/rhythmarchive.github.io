import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "./catalog.js";
import { createDeterministicUuidV7 } from "./identity.js";

const AbsolutePath = z.string().min(1).refine((value) => /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/"), "must be an absolute path");
const SourceLocation = z.union([AbsolutePath, z.string().url().refine((value) => /^https?:\/\//iu.test(value), "must be an HTTP(S) URL")]);

export const GameCandidateSlug = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/u, "must be a lowercase candidate slug");
export type GameCandidateSlug = z.infer<typeof GameCandidateSlug>;

export const OnboardingSourceKind = z.enum(["apk", "aab", "directory", "assetbundle", "addressables", "remote", "manifest", "unknown"]);
export type OnboardingSourceKind = z.infer<typeof OnboardingSourceKind>;

export const DetectedEngine = z.enum(["unity", "unreal", "godot", "custom", "unknown"]);
export const DetectedRuntime = z.enum(["mono", "il2cpp", "native", "unknown"]);
export const ExtractorFeasibility = z.enum(["promising", "partial", "unknown", "blocked"]);

export const OnboardingCandidate = z.object({
  kind: z.literal("rhythm-onboarding-candidate"),
  schemaVersion: z.literal("1"),
  candidateId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
  slug: GameCandidateSlug,
  sourcePath: SourceLocation,
  sourceKind: OnboardingSourceKind,
  exists: z.boolean(),
  readOnly: z.literal(true),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().min(1).optional(),
  fileCount: z.number().int().nonnegative().default(0),
  directoryCount: z.number().int().nonnegative().default(0),
  detectedEngine: DetectedEngine,
  detectedRuntime: DetectedRuntime,
  detectedMarkers: z.array(z.string().min(1)).default([]),
  possibleAssetTypes: z.array(z.string().min(1)).default([]),
  extractorFeasibility: ExtractorFeasibility,
  diagnostics: z.array(z.string().min(1)).default([]),
  sourceSnapshot: z.string().regex(/^onboard:[0-9a-f]{64}$/iu),
});
export type OnboardingCandidate = z.infer<typeof OnboardingCandidate>;

export const DraftGameProfile = z.object({
  kind: z.literal("rhythm-draft-game-profile"),
  schemaVersion: z.literal("1"),
  candidateId: OnboardingCandidate.shape.candidateId,
  slug: GameCandidateSlug,
  displayName: z.string().min(1),
  lifecycle: z.enum(["analysis-only", "onboarding"]),
  sourceKinds: z.array(OnboardingSourceKind).min(1),
  engine: DetectedEngine,
  runtime: DetectedRuntime,
  sourceMarkers: z.array(z.string().min(1)).default([]),
  extractorEntrypoints: z.array(z.string().min(1)).default([]),
  selectionPolicy: z.object({
    selectedAssetTypes: z.array(z.string().min(1)).default([]),
    excludedAssetTypes: z.array(z.string().min(1)).default([]),
    rationale: z.string().min(1),
  }),
  lastProbeSnapshot: OnboardingCandidate.shape.sourceSnapshot,
});
export type DraftGameProfile = z.infer<typeof DraftGameProfile>;

export const OnboardingPlan = z.object({
  kind: z.literal("rhythm-onboarding-plan"),
  schemaVersion: z.literal("1"),
  candidate: OnboardingCandidate,
  profile: DraftGameProfile,
  nextSteps: z.array(z.string().min(1)).min(1),
});
export type OnboardingPlan = z.infer<typeof OnboardingPlan>;

const MAX_INVENTORY_ENTRIES = 10_000;
const MAX_FILE_MARKER_BYTES = 8 * 1024 * 1024;

export function normalizeGameCandidateSlug(value: string): GameCandidateSlug {
  const slug = value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return GameCandidateSlug.parse(slug);
}

function sourceKindForPath(sourcePath: string, isFile: boolean): OnboardingSourceKind {
  if (/^https?:\/\//iu.test(sourcePath)) return "remote";
  if (!isFile) return "directory";
  const extension = path.extname(sourcePath).toLocaleLowerCase("en-US");
  if (extension === ".apk") return "apk";
  if (extension === ".aab") return "aab";
  if (extension === ".bundle" || extension === ".assetbundle") return "assetbundle";
  if (extension === ".json" || extension === ".csv" || extension === ".bin") return "manifest";
  return "unknown";
}

type Inventory = { fileCount: number; directoryCount: number; markers: string[] };

async function inventory(rootPath: string): Promise<Inventory> {
  const markers = new Set<string>();
  let fileCount = 0;
  let directoryCount = 0;
  async function visit(current: string): Promise<void> {
    if (fileCount + directoryCount >= MAX_INVENTORY_ENTRIES) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (fileCount + directoryCount >= MAX_INVENTORY_ENTRIES) return;
      const relative = path.relative(rootPath, path.join(current, entry.name)).replaceAll("\\", "/").toLocaleLowerCase("en-US");
      markers.add(relative);
      if (entry.isDirectory()) {
        directoryCount += 1;
        await visit(path.join(current, entry.name));
      } else if (entry.isFile()) {
        fileCount += 1;
      }
    }
  }
  await visit(rootPath);
  return { fileCount, directoryCount, markers: [...markers].sort() };
}

async function fileMarkers(filePath: string, sizeBytes: number): Promise<string[]> {
  const handle = await open(filePath, "r");
  try {
    const length = Math.min(sizeBytes, MAX_FILE_MARKER_BYTES);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    const text = buffer.subarray(0, result.bytesRead).toString("latin1").toLocaleLowerCase("en-US");
    const known = [
      "globalgamemanagers", "global-metadata.dat", "assets/bin/data", "libil2cpp", "unityplayer", "addressables", "catalog.json", "catalog.bin", "resources.assets", "sharedassets",
      "pakchunk", "ue4game", "globalshadercache", "project.godot", "godot", "songdata", "dynamicstringmapping", "assetbundle",
    ];
    return known.filter((marker) => text.includes(marker));
  } finally {
    await handle.close();
  }
}

function containsMarker(markers: string[], value: string): boolean {
  return markers.some((marker) => marker.includes(value));
}

function engineFromMarkers(markers: string[]): z.infer<typeof DetectedEngine> {
  if (containsMarker(markers, "globalgamemanagers") || containsMarker(markers, "unityplayer") || containsMarker(markers, "assetbundle") || containsMarker(markers, "addressables")) return "unity";
  if (containsMarker(markers, "pakchunk") || containsMarker(markers, "ue4game") || containsMarker(markers, "globalshadercache")) return "unreal";
  if (containsMarker(markers, "project.godot") || containsMarker(markers, "godot")) return "godot";
  return "unknown";
}

function runtimeFromMarkers(markers: string[]): z.infer<typeof DetectedRuntime> {
  if (containsMarker(markers, "libil2cpp") || containsMarker(markers, "global-metadata.dat")) return "il2cpp";
  if (containsMarker(markers, "mono") || containsMarker(markers, "managed")) return "mono";
  if (containsMarker(markers, "pakchunk") || containsMarker(markers, "globalshadercache")) return "native";
  return "unknown";
}

function possibleAssetTypes(markers: string[]): string[] {
  const types = new Set<string>();
  const joined = markers.join(" ");
  if (/(?:jacket|illustration|song|music|artwork|cover)/iu.test(joined)) types.add("jacket");
  if (/(?:character|pilot|avatar|portrait)/iu.test(joined)) types.add("character-avatar");
  if (/(?:background|bg|stage)/iu.test(joined)) types.add("background");
  if (/(?:story|cg|event)/iu.test(joined)) types.add("story-cg");
  if (/(?:audio|sound|music)/iu.test(joined)) types.add("audio");
  return [...types];
}

function feasibility(engine: z.infer<typeof DetectedEngine>, markers: string[], exists: boolean): z.infer<typeof ExtractorFeasibility> {
  if (!exists) return "blocked";
  if (engine === "unknown") return markers.length > 0 ? "partial" : "unknown";
  if (markers.length >= 2) return "promising";
  return "partial";
}

function snapshot(input: Omit<OnboardingCandidate, "sourceSnapshot">): string {
  const digest = createHash("sha256").update(JSON.stringify({
    slug: input.slug,
    sourcePath: input.sourcePath,
    sourceKind: input.sourceKind,
    exists: input.exists,
    sizeBytes: input.sizeBytes,
    modifiedAt: input.modifiedAt,
    fileCount: input.fileCount,
    directoryCount: input.directoryCount,
    detectedMarkers: input.detectedMarkers,
  }), "utf8").digest("hex");
  return `onboard:${digest}`;
}

export async function probeOnboardingSource(slugInput: string, inputPath: string): Promise<OnboardingCandidate> {
  const slug = normalizeGameCandidateSlug(slugInput);
  const sourcePath = /^https?:\/\//iu.test(inputPath) ? inputPath : path.resolve(inputPath);
  if (/^https?:\/\//iu.test(sourcePath)) {
    const base = {
      kind: "rhythm-onboarding-candidate" as const,
      schemaVersion: "1" as const,
      candidateId: createDeterministicUuidV7(`candidate:${slug}`),
      slug,
      sourcePath,
      sourceKind: "remote" as const,
      exists: true,
      readOnly: true as const,
      fileCount: 0,
      directoryCount: 0,
      detectedEngine: "unknown" as const,
      detectedRuntime: "unknown" as const,
      detectedMarkers: [],
      possibleAssetTypes: [],
      extractorFeasibility: "unknown" as const,
      diagnostics: ["remote source was not fetched; provide a local snapshot or manifest for analysis"],
    };
    return OnboardingCandidate.parse({ ...base, sourceSnapshot: snapshot(base) });
  }

  const basePath = path.resolve(sourcePath);
  let sourceStats: Awaited<ReturnType<typeof stat>> | undefined;
  try { sourceStats = await stat(basePath); } catch { /* structured below */ }
  if (!sourceStats) {
    const base = {
      kind: "rhythm-onboarding-candidate" as const,
      schemaVersion: "1" as const,
      candidateId: createDeterministicUuidV7(`candidate:${slug}`),
      slug,
      sourcePath: basePath,
      sourceKind: sourceKindForPath(basePath, true),
      exists: false,
      readOnly: true as const,
      fileCount: 0,
      directoryCount: 0,
      detectedEngine: "unknown" as const,
      detectedRuntime: "unknown" as const,
      detectedMarkers: [],
      possibleAssetTypes: [],
      extractorFeasibility: "blocked" as const,
      diagnostics: ["source path does not exist"],
    };
    return OnboardingCandidate.parse({ ...base, sourceSnapshot: snapshot(base) });
  }

  const isDirectory = sourceStats.isDirectory();
  const sourceKind = sourceKindForPath(basePath, !isDirectory);
  const inventoryResult = isDirectory
    ? await inventory(basePath)
    : { fileCount: 1, directoryCount: 0, markers: [path.basename(basePath).toLocaleLowerCase("en-US"), ...(await fileMarkers(basePath, Number(sourceStats.size)))] };
  const detectedMarkers = inventoryResult.markers;
  const detectedEngine = engineFromMarkers(detectedMarkers);
  const detectedRuntime = runtimeFromMarkers(detectedMarkers);
  const diagnostics = [
    ...(inventoryResult.fileCount + inventoryResult.directoryCount >= MAX_INVENTORY_ENTRIES ? [`inventory capped at ${MAX_INVENTORY_ENTRIES} entries`] : []),
    ...(detectedEngine === "unknown" ? ["engine could not be identified from the read-only marker scan"] : []),
    ...(detectedRuntime === "unknown" && detectedEngine === "unity" ? ["Unity scripting backend could not be distinguished from available markers"] : []),
  ];
  const base = {
    kind: "rhythm-onboarding-candidate" as const,
    schemaVersion: "1" as const,
    candidateId: createDeterministicUuidV7(`candidate:${slug}`),
    slug,
    sourcePath: basePath,
    sourceKind,
    exists: true,
    readOnly: true as const,
    ...(isDirectory ? {} : { sizeBytes: Number(sourceStats.size) }),
    modifiedAt: sourceStats.mtime.toISOString(),
    fileCount: inventoryResult.fileCount,
    directoryCount: inventoryResult.directoryCount,
    detectedEngine,
    detectedRuntime,
    detectedMarkers,
    possibleAssetTypes: possibleAssetTypes(detectedMarkers),
    extractorFeasibility: feasibility(detectedEngine, detectedMarkers, true),
    diagnostics,
  };
  return OnboardingCandidate.parse({ ...base, sourceSnapshot: snapshot(base) });
}

export function draftProfileFromCandidate(candidateInput: OnboardingCandidate, options: { displayName?: string; lifecycle?: "analysis-only" | "onboarding"; selectedAssetTypes?: string[]; excludedAssetTypes?: string[]; rationale?: string; extractorEntrypoints?: string[] } = {}): DraftGameProfile {
  const candidate = OnboardingCandidate.parse(candidateInput);
  return DraftGameProfile.parse({
    kind: "rhythm-draft-game-profile",
    schemaVersion: "1",
    candidateId: candidate.candidateId,
    slug: candidate.slug,
    displayName: options.displayName?.trim() || candidate.slug,
    lifecycle: options.lifecycle ?? "analysis-only",
    sourceKinds: [candidate.sourceKind],
    engine: candidate.detectedEngine,
    runtime: candidate.detectedRuntime,
    sourceMarkers: candidate.detectedMarkers.slice(0, 80),
    extractorEntrypoints: options.extractorEntrypoints ?? [],
    selectionPolicy: {
      selectedAssetTypes: options.selectedAssetTypes ?? [],
      excludedAssetTypes: options.excludedAssetTypes ?? [],
      rationale: options.rationale?.trim() || "No publication scope has been approved; reconnaissance output remains analysis-only.",
    },
    lastProbeSnapshot: candidate.sourceSnapshot,
  });
}

export function createOnboardingPlan(candidateInput: OnboardingCandidate, options: Parameters<typeof draftProfileFromCandidate>[1] = {}): OnboardingPlan {
  const candidate = OnboardingCandidate.parse(candidateInput);
  const profile = draftProfileFromCandidate(candidate, options);
  return OnboardingPlan.parse({
    kind: "rhythm-onboarding-plan",
    schemaVersion: "1",
    candidate,
    profile,
    nextSteps: [
      "review the source inventory and diagnostics",
      "choose an explicit publication selection policy",
      "implement or register a game adapter before extraction",
      "normalize candidates and pass the shared review gate before Catalog changes",
    ],
  });
}

export async function writeOnboardingArtifacts(rootPath: string, candidate: OnboardingCandidate, plan: OnboardingPlan): Promise<{ probePath: string; profilePath: string; reportPath: string }> {
  const root = path.resolve(rootPath);
  const probePath = path.join(root, "probe.json");
  const profilePath = path.join(root, "draft-profile.json");
  const reportPath = path.join(root, "analysis-report.json");
  await atomicWriteJson(probePath, OnboardingCandidate.parse(candidate));
  await atomicWriteJson(profilePath, DraftGameProfile.parse(plan.profile));
  await atomicWriteJson(reportPath, OnboardingPlan.parse(plan));
  return { probePath, profilePath, reportPath };
}
