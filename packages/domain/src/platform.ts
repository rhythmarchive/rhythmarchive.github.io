import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Game, ResourceType, SourceType, type Catalog, type Resource } from "./schema.js";
import { immutableObjectKey, objectIdFromSha256 } from "./identity.js";

const JsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() => z.union([JsonPrimitive, z.array(JsonValue), z.record(z.string(), JsonValue)]));
const AbsolutePath = z.string().min(1).refine((value) => /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/"), "must be an absolute local path");
const RemoteUrl = z.string().url().refine((value) => /^https?:\/\//iu.test(value), "must be an HTTP(S) URL");
const SourceLocation = z.union([AbsolutePath, RemoteUrl]);
const PortablePath = z.string().min(1).refine((value) => {
  if (value.includes("\0")) return false;
  if (/^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  return !value.split(/[\\/]+/u).includes("..");
}, "must be a portable relative path");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/iu, "must be a SHA-256 hex digest");

export const AdapterInputKind = z.enum(["apk", "directory", "assetbundle", "addressables", "remote", "manifest", "legacy-report"]);
export const AdapterCapability = z.enum(["probe", "extract", "normalize", "validate"]);
export const AdapterOperationEntrypoints = z.object({
  probe: z.string().min(1),
  extract: z.string().min(1),
  normalize: z.string().min(1),
  validate: z.string().min(1),
});
export type AdapterOperationEntrypoints = z.infer<typeof AdapterOperationEntrypoints>;
export type AdapterInputKind = z.infer<typeof AdapterInputKind>;
export type AdapterCapability = z.infer<typeof AdapterCapability>;
export type PlatformGameId = z.infer<typeof Game>;
export type PlatformResourceType = z.infer<typeof ResourceType>;
export type PlatformSourceType = z.infer<typeof SourceType>;

export const GameProfile = z.object({
  gameId: Game,
  displayName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  capabilities: z.array(AdapterCapability).min(1).default(["probe", "extract", "normalize", "validate"]),
  operationEntrypoints: AdapterOperationEntrypoints.default({
    probe: "adapter.probe",
    extract: "adapter-registry.extract",
    normalize: "adapter-registry.normalize",
    validate: "adapter-registry.validate",
  }),
  inputKinds: z.array(AdapterInputKind).min(1),
  defaultSourceType: SourceType,
  supportedAssetTypes: z.array(ResourceType).min(1),
  defaultAssetTypes: z.array(ResourceType).min(1),
  siteStatus: z.enum(["published", "staging", "onboarding"]),
  sourceMarkers: z.array(z.string().min(1)).default([]),
  extractorEntrypoints: z.array(z.string().min(1)).min(1),
  selectionPolicy: z.string().min(1),
});
export type GameProfile = z.infer<typeof GameProfile>;

export const GameRecord = z.object({
  gameId: Game,
  displayName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  status: z.enum(["published", "staging", "onboarding"]),
  latestPublishedVersion: z.string().min(1).optional(),
  supportedAssetTypes: z.array(ResourceType),
  assetCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), JsonValue).default({}),
});
export type GameRecord = z.infer<typeof GameRecord>;

export const PublishedFileRecord = z.object({
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
  objectKey: z.string().min(1),
  sha256: Sha256,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.string().min(1),
});

export const AssetRecord = z.object({
  gameId: Game,
  assetId: z.string().min(1),
  assetType: ResourceType,
  title: z.string().min(1).optional(),
  artist: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)),
  sourceIdentity: z.string().min(1),
  sourcePath: PortablePath.optional(),
  publishedFile: PublishedFileRecord.optional(),
  versionAdded: z.string().min(1).optional(),
  versionChanged: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValue).default({}),
});
export type AssetRecord = z.infer<typeof AssetRecord>;

export const SourceProbe = z.object({
  gameId: Game,
  sourcePath: SourceLocation,
  sourceKind: AdapterInputKind,
  exists: z.boolean(),
  readOnly: z.literal(true),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().min(1).optional(),
  fileCount: z.number().int().nonnegative().default(0),
  directoryCount: z.number().int().nonnegative().default(0),
  detectedMarkers: z.array(z.string().min(1)).default([]),
  diagnostics: z.array(z.string().min(1)).default([]),
  snapshot: z.string().regex(/^probe:[0-9a-f]{64}$/iu),
});
export type SourceProbe = z.infer<typeof SourceProbe>;

export const AdapterExtractionPlan = z.object({
  gameId: Game,
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  sourcePath: SourceLocation,
  sourceKind: AdapterInputKind,
  supported: z.boolean(),
  outputBoundary: z.literal("temp"),
  entrypoints: z.array(z.string().min(1)),
  requires: z.array(z.string().min(1)).default([]),
  diagnostics: z.array(z.string().min(1)).default([]),
});
export type AdapterExtractionPlan = z.infer<typeof AdapterExtractionPlan>;

export type GameAdapter = {
  profile: GameProfile;
  capabilities: AdapterCapability[];
  operationEntrypoints: AdapterOperationEntrypoints;
  probe(sourcePath: string): Promise<SourceProbe>;
  planExtraction(probe: SourceProbe): AdapterExtractionPlan;
};

const profiles: GameProfile[] = [
  GameProfile.parse({
    gameId: "arcaea",
    displayName: "Arcaea",
    aliases: ["arcaea"],
    adapterId: "arcaea-apk",
    adapterVersion: "2.0",
    inputKinds: ["apk", "manifest", "legacy-report"],
    defaultSourceType: "arcaea_apk",
    supportedAssetTypes: ["jacket", "pack-cover", "character-portrait", "character-avatar", "story-cg", "story-texture", "background", "linkplay-preview", "sticker", "world-mode", "startup", "other"],
    defaultAssetTypes: ["jacket", "pack-cover", "character-portrait", "character-avatar", "story-cg", "background"],
    siteStatus: "published",
    sourceMarkers: ["assets/songs/songlist", "assets/songs/packlist", "assets/char/characters.json", "assets/app-data/story2/ordering"],
    extractorEntrypoints: ["packages/domain/src/extractors.ts:adaptArcaeaLegacyReport", "tools/arcaea-apk-update.ts"],
    selectionPolicy: "jacket plus explicitly selected non-jacket categories; preserve _optimization.png for human review",
  }),
  GameProfile.parse({
    gameId: "phigros",
    displayName: "Phigros",
    aliases: ["phigros"],
    adapterId: "phigros-apk",
    adapterVersion: "2.0",
    inputKinds: ["apk", "manifest", "legacy-report"],
    defaultSourceType: "phigros_apk",
    supportedAssetTypes: ["jacket", "character-avatar", "pack-cover", "phigros-april-fools", "other"],
    defaultAssetTypes: ["jacket", "pack-cover", "character-avatar", "phigros-april-fools"],
    siteStatus: "published",
    sourceMarkers: ["catalog.json", "addressables", "assets/tracks/", "illustration.jpg"],
    extractorEntrypoints: ["packages/domain/src/extractors.ts:adaptPhigrosLegacyReport", "tools/phase6-phigros-diff.py"],
    selectionPolicy: "current track artwork and explicitly reviewed special/category resources; content changes are compared by image bytes",
  }),
  GameProfile.parse({
    gameId: "rizline",
    displayName: "Rizline",
    aliases: ["rizline"],
    adapterId: "rizline-remote",
    adapterVersion: "1.0",
    inputKinds: ["apk", "directory", "assetbundle", "remote", "manifest"],
    defaultSourceType: "rizline_remote",
    supportedAssetTypes: ["jacket", "special-art", "track-series", "rizcard-layout", "rizcard", "character-avatar", "other"],
    defaultAssetTypes: ["jacket", "special-art", "track-series", "rizcard-layout", "character-avatar"],
    siteStatus: "published",
    sourceMarkers: ["globalgamemanagers", "assetbundle", "RuntimeCacheResolver", "Default.asset"],
    extractorEntrypoints: ["python -m tools.rizline inspect", "python -m tools.rizline extract", "tools/rizline/manifest.py"],
    selectionPolicy: "remote-canonical asset families selected by profile; runtime composites stay explicitly classified",
  }),
  GameProfile.parse({
    gameId: "infalsus",
    displayName: "In Falsus",
    aliases: ["in falsus", "infalsus"],
    adapterId: "infalsus-addressables",
    adapterVersion: "1.0",
    inputKinds: ["directory", "addressables", "manifest"],
    defaultSourceType: "infalsus_demo",
    supportedAssetTypes: ["jacket", "other"],
    defaultAssetTypes: ["jacket"],
    siteStatus: "published",
    sourceMarkers: ["if-app_data/streamingassets/aa/catalog.bin", "songdata", "dynamicstringmapping"],
    extractorEntrypoints: ["python -m tools.infalsus inspect", "python -m tools.infalsus prepare-publish", "tools/infalsus/extractor.py"],
    selectionPolicy: "available songs only; canonical jacket is publishable and small artwork is a validation/preview source",
  }),
  GameProfile.parse({
    gameId: "rotaeno",
    displayName: "Rotaeno",
    aliases: ["rotaeno", "旋转音律"],
    adapterId: "rotaeno-apk",
    adapterVersion: "1.0",
    inputKinds: ["apk", "manifest"],
    defaultSourceType: "rotaeno_apk",
    supportedAssetTypes: ["jacket", "pack-cover", "character-portrait", "story-cg", "startup", "other"],
    defaultAssetTypes: ["jacket", "pack-cover", "character-portrait", "story-cg", "startup"],
    siteStatus: "published",
    sourceMarkers: ["assets/aa/catalog.json", "assets/aa/settings.json", "assets/XDConfig.json", "assets/bin/Data/data.unity3d"],
    extractorEntrypoints: ["python -m tools.rotaeno inspect", "python -m tools.rotaeno extract-images", "python -m tools.rotaeno extract-charts", "tools/rotaeno/images.py", "tools/rotaeno/charts.py"],
    selectionPolicy: "publish only the reviewed non-event image selection; keep event artwork, journey, badges, encrypted chart bodies, audio, and non-image candidates in temp; chart difficulty metadata may enter the shared Catalog through content-addition",
  }),
  GameProfile.parse({
    gameId: "paradigm-reboot",
    displayName: "范式：起源",
    aliases: ["paradigm: reboot", "paradigm reboot", "范式起源"],
    adapterId: "paradigm-apk",
    adapterVersion: "1.0",
    inputKinds: ["apk", "manifest"],
    defaultSourceType: "paradigm_apk",
    supportedAssetTypes: ["pack-cover", "background", "character-avatar", "jacket", "other"],
    defaultAssetTypes: ["pack-cover", "character-avatar", "background"],
    siteStatus: "staging",
    sourceMarkers: ["assets/bin/Data/data.unity3d", "assets/aa/catalog.json", "unityplayer"],
    extractorEntrypoints: ["python -m tools.paradigm extract", "tools/paradigm/extractor.py"],
    selectionPolicy: "publish only the reviewed static Unity image families; dynamic song artwork, audio, charts, encrypted hotassets, and UI fragments remain outside the public Catalog",
  }),
];

export const GAME_PROFILES: Readonly<Record<PlatformGameId, GameProfile>> = Object.freeze(Object.fromEntries(profiles.map((profile) => [profile.gameId, profile])) as Record<PlatformGameId, GameProfile>);

function sourceKindForPath(sourcePath: string, file: boolean): AdapterInputKind {
  if (/^https?:\/\//u.test(sourcePath)) return "remote";
  if (!file) return "directory";
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".apk" || extension === ".aab") return "apk";
  if (extension === ".json" || extension === ".csv") return "manifest";
  if (extension === ".bundle" || extension === ".assetbundle") return "assetbundle";
  return "manifest";
}

async function inventory(rootPath: string, maxEntries = 10_000): Promise<{ fileCount: number; directoryCount: number; markers: string[] }> {
  const markers = new Set<string>();
  let fileCount = 0;
  let directoryCount = 0;
  async function visit(current: string): Promise<void> {
    if (fileCount + directoryCount >= maxEntries) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (fileCount + directoryCount >= maxEntries) return;
      const relative = path.relative(rootPath, path.join(current, entry.name)).replaceAll("\\", "/").toLocaleLowerCase("en-US");
      if (entry.isDirectory()) {
        directoryCount += 1;
        markers.add(relative);
        await visit(path.join(current, entry.name));
      } else if (entry.isFile()) {
        fileCount += 1;
        markers.add(relative);
      }
    }
  }
  await visit(rootPath);
  return { fileCount, directoryCount, markers: [...markers] };
}

function hasMarker(markers: string[], marker: string): boolean {
  const normalized = marker.toLocaleLowerCase("en-US");
  return markers.some((value) => value === normalized || value.includes(normalized));
}

function probeSnapshot(input: Omit<SourceProbe, "snapshot">): string {
  const digest = createHash("sha256").update(JSON.stringify({
    gameId: input.gameId,
    sourcePath: input.sourcePath,
    sourceKind: input.sourceKind,
    exists: input.exists,
    sizeBytes: input.sizeBytes,
    modifiedAt: input.modifiedAt,
    fileCount: input.fileCount,
    directoryCount: input.directoryCount,
    detectedMarkers: input.detectedMarkers,
  }), "utf8").digest("hex");
  return `probe:${digest}`;
}

async function probeProfile(profile: GameProfile, inputPath: string): Promise<SourceProbe> {
  const isRemote = /^https?:\/\//u.test(inputPath);
  const sourcePath = isRemote ? inputPath : path.resolve(inputPath);
  if (isRemote) {
    const remote = { gameId: profile.gameId, sourcePath, sourceKind: "remote" as const, exists: true, readOnly: true as const, fileCount: 0, directoryCount: 0, detectedMarkers: [], diagnostics: ["remote source was not fetched; use a local manifest or adapter cache for extraction"] };
    return SourceProbe.parse({ ...remote, snapshot: probeSnapshot(remote) });
  }
  let sourceStats: Awaited<ReturnType<typeof stat>> | undefined;
  try { sourceStats = await stat(sourcePath); } catch { /* returned as a structured probe diagnostic */ }
  if (!sourceStats) {
    const missing = { gameId: profile.gameId, sourcePath, sourceKind: sourceKindForPath(sourcePath, true), exists: false, readOnly: true as const, fileCount: 0, directoryCount: 0, detectedMarkers: [], diagnostics: ["source path does not exist"] };
    return SourceProbe.parse({ ...missing, snapshot: probeSnapshot(missing) });
  }
  const isDirectory = sourceStats.isDirectory();
  const sourceKind = sourceKindForPath(sourcePath, !isDirectory);
  const scanned = isDirectory ? await inventory(sourcePath) : { fileCount: 1, directoryCount: 0, markers: [path.basename(sourcePath).toLocaleLowerCase("en-US")] };
  const detectedMarkers = profile.sourceMarkers.filter((marker) => hasMarker(scanned.markers, marker));
  const diagnostics = detectedMarkers.length === 0 ? [`no ${profile.displayName} adapter marker was detected`] : [];
  const payload = {
    gameId: profile.gameId,
    sourcePath,
    sourceKind,
    exists: true,
    readOnly: true as const,
    sizeBytes: isDirectory ? undefined : Number(sourceStats.size),
    modifiedAt: sourceStats.mtime.toISOString(),
    fileCount: scanned.fileCount,
    directoryCount: scanned.directoryCount,
    detectedMarkers,
    diagnostics,
  };
  return SourceProbe.parse({ ...payload, ...(payload.sizeBytes !== undefined ? { sizeBytes: payload.sizeBytes } : {}), snapshot: probeSnapshot(payload) });
}

function extractionPlan(profile: GameProfile, probe: SourceProbe): AdapterExtractionPlan {
  const supported = probe.exists && (probe.sourceKind === "manifest" || profile.inputKinds.includes(probe.sourceKind));
  const requires = probe.sourceKind === "manifest" ? [] : ["run the game adapter extractor in a temp workspace", "produce a Candidate or unified manifest before release diff"];
  return AdapterExtractionPlan.parse({
    gameId: profile.gameId,
    adapterId: profile.adapterId,
    adapterVersion: profile.adapterVersion,
    sourcePath: probe.sourcePath,
    sourceKind: probe.sourceKind,
    supported,
    outputBoundary: "temp",
    entrypoints: profile.extractorEntrypoints,
    requires,
    diagnostics: [...probe.diagnostics, ...(supported ? [] : ["source kind is not supported by this adapter profile"])],
  });
}

export function listGameProfiles(): GameProfile[] {
  return profiles.map((profile) => GameProfile.parse(profile));
}

export function getGameProfile(gameId: PlatformGameId): GameProfile {
  const profile = GAME_PROFILES[gameId];
  if (!profile) throw new Error(`unknown game profile: ${gameId}`);
  return profile;
}

export function getGameAdapter(gameId: PlatformGameId): GameAdapter {
  const profile = getGameProfile(gameId);
  return { profile, capabilities: profile.capabilities, operationEntrypoints: profile.operationEntrypoints, probe: (sourcePath) => probeProfile(profile, sourcePath), planExtraction: (probe) => extractionPlan(profile, probe) };
}

function externalIdentity(resource: Resource): string {
  const identity = resource.externalIdentities
    .slice()
    .sort((left, right) => left.namespace.localeCompare(right.namespace) || left.key.localeCompare(right.key) || left.value.localeCompare(right.value))[0];
  return identity ? `${identity.namespace}:${identity.key}=${identity.value}` : resource.id;
}

function stringMetadata(resource: Resource, key: string): string | undefined {
  const value = resource.metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function gameRecordsFromCatalog(catalog: Catalog): GameRecord[] {
  return profiles.map((profile) => {
    const resources = catalog.resources.filter((resource) => resource.game === profile.gameId);
    const published = resources.filter((resource) => resource.lifecycle.status === "published");
    return GameRecord.parse({
      gameId: profile.gameId,
      displayName: profile.displayName,
      aliases: profile.aliases,
      status: profile.siteStatus,
      supportedAssetTypes: profile.supportedAssetTypes,
      assetCount: published.length,
      metadata: { adapterId: profile.adapterId, adapterVersion: profile.adapterVersion, catalogGeneratedAt: catalog.generatedAt },
    });
  });
}

export function assetRecordsFromCatalog(catalog: Catalog): AssetRecord[] {
  const variantsByResource = new Map<string, Catalog["variants"]>();
  for (const variant of catalog.variants) variantsByResource.set(variant.resourceId, [...(variantsByResource.get(variant.resourceId) ?? []), variant]);
  const renditionsByVariant = new Map<string, Catalog["renditions"]>();
  for (const rendition of catalog.renditions) renditionsByVariant.set(rendition.variantId, [...(renditionsByVariant.get(rendition.variantId) ?? []), rendition]);
  return catalog.resources.flatMap((resource) => {
    const variants = variantsByResource.get(resource.id) ?? [];
    return variants.map((variant) => {
      const renditions = renditionsByVariant.get(variant.id) ?? [];
      const original = renditions.find((rendition) => rendition.renditionType === "original" && rendition.publishable);
      const object = original ? catalog.objects.find((candidate) => candidate.id === original.objectId) : undefined;
      const provenance = resource.provenance[0];
      return AssetRecord.parse({
        gameId: resource.game,
        assetId: `${resource.id}:${variant.variantKey}`,
        assetType: resource.resourceType,
        ...(resource.title ? { title: resource.title } : {}),
        ...(stringMetadata(resource, "artist") ? { artist: stringMetadata(resource, "artist") } : {}),
        aliases: resource.aliases.map((alias) => alias.value),
        sourceIdentity: externalIdentity(resource),
        ...(provenance?.sourceRelativePath ? { sourcePath: provenance.sourceRelativePath } : {}),
        ...(original && object ? { publishedFile: { objectId: object.id, objectKey: object.objectKey, sha256: object.sha256, sizeBytes: object.sizeBytes, width: object.width, height: object.height, mime: object.mime } } : {}),
        ...(provenance?.gameVersion ? { versionAdded: provenance.gameVersion, versionChanged: provenance.gameVersion } : {}),
        metadata: { ...resource.metadata, variantKey: variant.variantKey, semanticStatus: variant.semanticStatus },
      });
    });
  });
}

export function objectKeyForFile(sha256: string, extension: string): { objectId: string; objectKey: string } {
  return { objectId: objectIdFromSha256(sha256), objectKey: immutableObjectKey(sha256, extension) };
}
