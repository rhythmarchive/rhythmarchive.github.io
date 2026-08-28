import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createDeterministicUuidV7 } from "../packages/domain/src/identity.js";
import { loadCatalogFile, writeCatalogAndReleaseAtomic } from "../packages/domain/src/catalog.js";
import { Catalog, ReleaseManifest, Resource, type ReleaseManifest as ReleaseManifestType, type Resource as ResourceType } from "../packages/domain/src/schema.js";
import { validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_CHARACTERS_PATH = "temp/rhythmctl/arcaea/7.0.0c/legacy-incremental/_metadata/characters.json";
const TARGETS = new Map([
  ["Arcaea/current-apk/char/1080/97.png", "character-portrait"],
  ["Arcaea/current-apk/char/97_icon.png", "character-avatar"],
  ["Arcaea/current-apk/char/97_mp.png", "linkplay-preview"],
] as const);

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredOption(name: string, fallback?: string): string {
  const index = process.argv.indexOf("--" + name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value || value.startsWith("--")) throw new Error("--" + name + " is required");
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes("--" + name);
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function sourcePath(value: string): string {
  const absolute = path.resolve(value);
  const tempRoot = path.resolve("temp") + path.sep;
  if (!absolute.toLocaleLowerCase("en-US").startsWith(tempRoot.toLocaleLowerCase("en-US"))) {
    throw new Error("characters.json must stay inside repository temp/: " + value);
  }
  return absolute;
}

function stringValue(record: JsonObject, key: string): string | undefined {
  return typeof record[key] === "string" && record[key].trim() ? record[key].trim() : undefined;
}

function numberValue(record: JsonObject, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
}

function booleanValue(record: JsonObject, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] as boolean : undefined;
}

function stringArray(record: JsonObject, key: string): string[] | undefined {
  if (!Array.isArray(record[key])) return undefined;
  return record[key].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
}

function characterRecord(value: unknown): JsonObject {
  const record = object(value);
  if (numberValue(record, "character_id") !== 97) throw new Error("characters.json does not contain character_id 97");
  return record;
}

function names(record: JsonObject): { chinese?: string; japanese?: string; english?: string; korean?: string; aliases: string[] } {
  const aliases = stringArray(record, "search_strings") ?? [];
  const hanOnly = aliases.filter((value) => /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value) && !/[\u3040-\u30ff\uac00-\ud7af]/u.test(value));
  const japanese = aliases.find((value) => /[\u3040-\u30ff]/u.test(value));
  const korean = aliases.find((value) => /[\uac00-\ud7af]/u.test(value));
  const english = stringValue(record, "name");
  return {
    ...(hanOnly[0] ? { chinese: hanOnly[0] } : {}),
    ...(japanese ? { japanese } : {}),
    ...(english ? { english } : {}),
    ...(korean ? { korean } : {}),
    aliases,
  };
}

function fullCharacterMetadata(record: JsonObject): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    characterId: numberValue(record, "character_id"),
    characterInternalName: stringValue(record, "name"),
    characterBaseId: numberValue(record, "base_character_id"),
    characterBase: booleanValue(record, "base_character"),
    characterAvailable: booleanValue(record, "is_available"),
    characterPreviewable: booleanValue(record, "is_previewable"),
    characterIsTairitsu: booleanValue(record, "is_tairitsu"),
    characterBaseFrag: numberValue(record, "base_frag"),
    characterBaseProg: numberValue(record, "base_prog"),
    characterBaseOver: numberValue(record, "base_over"),
    characterMaxFrag: numberValue(record, "max_frag"),
    characterMaxProg: numberValue(record, "max_prog"),
    characterMaxOver: numberValue(record, "max_over"),
    characterType: numberValue(record, "char_type"),
    characterSkillUnlockLevel: numberValue(record, "skill_unlock_level"),
    characterSkillId: stringValue(record, "skill_id"),
    characterSkillIdUncap: stringValue(record, "skill_id_uncap"),
    characterSkillRequiresUncap: booleanValue(record, "skill_requires_uncap"),
    characterUncapCores: Array.isArray(record.uncap_cores) ? record.uncap_cores : undefined,
    characterUncapFragGrowth: numberValue(record, "uncap_frag_growth"),
    characterUncapProgGrowth: numberValue(record, "uncap_prog_growth"),
    characterUncapOverGrowth: numberValue(record, "uncap_over_growth"),
    characterUncapVersionFrom: stringValue(record, "uncap_version_from"),
    characterUncapVisibleReq: numberValue(record, "uncap_visible_req"),
    characterVersionFrom: stringValue(record, "version_from"),
    characterVoice: stringValue(record, "voice"),
    characterSearchStrings: stringArray(record, "search_strings"),
    characterPackId: stringValue(record, "pack_id"),
  }).filter(([, value]) => value !== undefined));
}

function publicCharacterMetadata(record: JsonObject): Record<string, unknown> {
  const localized = names(record);
  return {
    ...(localized.chinese ? { characterName: localized.chinese, characterChineseName: localized.chinese } : {}),
    ...(localized.japanese ? { characterJapaneseName: localized.japanese } : {}),
    ...(localized.english ? { characterEnglishName: localized.english } : {}),
    ...(localized.korean ? { characterKoreanName: localized.korean } : {}),
    ...(stringValue(record, "version_from") ? { characterVersionFrom: stringValue(record, "version_from")! } : {}),
  };
}

function displayTitle(record: JsonObject): string {
  const localized = names(record);
  return localized.chinese ?? localized.japanese ?? localized.korean ?? localized.english ?? "角色 97";
}

function updateResource(resource: ResourceType, sourceRelativePath: string, record: JsonObject, updatedAt: string): ResourceType {
  const characterName = stringValue(record, "name") ?? "character_97";
  const version = stringValue(record, "version_from") ?? "unknown";
  const packId = stringValue(record, "pack_id") ?? "unknown";
  const metadataEvidence = `Arcaea characters.json matched character_id 97 (${characterName}), version_from ${version}, pack_id ${packId}.`;
  const provenance = resource.provenance.map((entry) => {
    if (normalizedPath(entry.sourceRelativePath) !== sourceRelativePath) return entry;
    const evidence = entry.evidence.filter((item) => !(item.kind === "filename-parser" && /not matched in Arcaea metadata/iu.test(item.detail)));
    return {
      ...entry,
      evidence: evidence.some((item) => item.kind === "metadata" && item.detail.includes("characters.json"))
        ? evidence
        : [...evidence, { kind: "metadata" as const, detail: metadataEvidence, confidence: "high" as const }],
    };
  });
  return Resource.parse({
    ...resource,
    title: displayTitle(record),
    metadata: {
      ...resource.metadata,
      ...publicCharacterMetadata(record),
      ...fullCharacterMetadata(record),
      confidence: "high",
    },
    provenance,
    lifecycle: { ...resource.lifecycle, updatedAt },
  });
}

function buildRelease(resourceIds: string[], sourceHash: string, now: string): ReleaseManifestType {
  const releaseId = createDeterministicUuidV7(`arcaea:release:character-metadata:7.0.0c:97:${sourceHash}`);
  return ReleaseManifest.parse({
    schemaVersion: "1.0",
    releaseSchemaVersion: "1.0",
    id: releaseId,
    updateBatchId: createDeterministicUuidV7(`arcaea:update-batch:character-metadata:7.0.0c:97:${sourceHash}`),
    game: "arcaea",
    baseVersion: "7.0.0c",
    targetVersion: "7.0.0c",
    createdAt: now,
    status: "published",
    changes: resourceIds.map((resourceId) => ({
      changeType: "metadata-changed" as const,
      resourceId,
      detail: "Applied Arcaea 7.0.0c characters.json metadata for character_id 97; object identities and renditions preserved.",
    })),
    affectedResourceIds: resourceIds,
    publishedRenditions: [],
    removedFromCurrentSource: [],
    notes: [
      "Local-only Arcaea 7.0.0c character metadata correction.",
      "The source is the read-only APK-extracted assets/char/characters.json record for character_id 97.",
      "Three existing resources were updated: character portrait, avatar icon, and LinkPlay preview.",
      "No canonical files, Object IDs, remote keys, Renditions, deletions, ROS writes, or Catalog entries were removed.",
    ],
  });
}

async function main(): Promise<void> {
  const charactersFile = sourcePath(requiredOption("characters", DEFAULT_CHARACTERS_PATH));
  const catalogPath = path.resolve(requiredOption("catalog", "catalog/index.json"));
  const sourceBytes = await readFile(charactersFile);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const parsed = JSON.parse(sourceBytes.toString("utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("characters.json root must be an array");
  const character = characterRecord(parsed.find((item) => numberValue(object(item), "character_id") === 97));
  const catalog = await loadCatalogFile(catalogPath);
  const resourcesByTarget = new Map<string, ResourceType>();
  for (const [sourceRelativePath, resourceType] of TARGETS) {
    const matches = catalog.resources.filter((resource) => resource.game === "arcaea" && resource.resourceType === resourceType && resource.provenance.some((entry) => normalizedPath(entry.sourceRelativePath) === sourceRelativePath));
    if (matches.length !== 1) throw new Error(`expected exactly one ${resourceType} resource for ${sourceRelativePath}, found ${matches.length}`);
    resourcesByTarget.set(sourceRelativePath, matches[0]!);
  }
  const now = new Date().toISOString();
  const updatedResources = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  for (const [sourceRelativePath, resource] of resourcesByTarget) updatedResources.set(resource.id, updateResource(resource, sourceRelativePath, character, now));
  const release = buildRelease([...resourcesByTarget.values()].map((resource) => resource.id), sourceHash, now);
  const updatedCatalog = Catalog.parse({
    ...catalog,
    generatedAt: now,
    resources: [...updatedResources.values()],
    releaseManifestIds: [...new Set([...catalog.releaseManifestIds, release.id])],
  });
  const consistency = validateReleaseManifestConsistency(release, updatedCatalog);
  if (!consistency.success) throw new Error("ReleaseManifest consistency failed: " + consistency.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  const report = {
    status: hasFlag("apply") ? "APPLIED_LOCAL_ONLY" : "READY_LOCAL_ONLY",
    remoteWrite: "DISABLED",
    source: { path: charactersFile, sha256: sourceHash, characterId: 97, name: stringValue(character, "name"), versionFrom: stringValue(character, "version_from"), packId: stringValue(character, "pack_id") },
    resourceCount: resourcesByTarget.size,
    resourceIds: [...resourcesByTarget.values()].map((resource) => resource.id),
    releaseId: release.id,
    catalogPath,
  };
  if (hasFlag("apply")) await writeCatalogAndReleaseAtomic(updatedCatalog, release, { catalogPath });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
