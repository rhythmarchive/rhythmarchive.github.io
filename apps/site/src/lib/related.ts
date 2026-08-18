import type { PublicResource } from "./types";

type MetadataKey =
  | "pack"
  | "packName"
  | "packDisplayName"
  | "storyPathTitle"
  | "storyAct"
  | "storyType"
  | "songId"
  | "relatedSongId"
  | "relatedSongTitle"
  | "characterName"
  | "characterEnglishName"
  | "characterVariant"
  | "side"
  | "version"
  | "bpm";

type MetadataGroup = {
  keys: readonly MetadataKey[];
  weight: number;
};

const METADATA_GROUPS: readonly MetadataGroup[] = [
  { keys: ["pack", "packName", "packDisplayName"], weight: 220 },
  { keys: ["storyPathTitle", "storyAct", "storyType"], weight: 180 },
  { keys: ["songId", "relatedSongId", "relatedSongTitle"], weight: 160 },
  { keys: ["characterName", "characterEnglishName", "characterVariant"], weight: 100 },
  { keys: ["side", "version", "bpm"], weight: 40 },
];

const SHARED_METADATA_KEYS = METADATA_GROUPS.flatMap((group) => group.keys);

export function rankRelatedResources(current: PublicResource, candidates: PublicResource[], limit = 6): PublicResource[] {
  return candidates
    .filter((candidate) => candidate.resourceId !== current.resourceId && candidate.game === current.game)
    .map((candidate) => ({ candidate, score: relatedScore(current, candidate) }))
    .sort((left, right) => right.score - left.score || left.candidate.displayTitle.localeCompare(right.candidate.displayTitle, "zh-CN") || left.candidate.resourceId.localeCompare(right.candidate.resourceId))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function relatedScore(current: PublicResource, candidate: PublicResource): number {
  if (current.game !== candidate.game || current.resourceId === candidate.resourceId) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (normalizedArtist(current) && normalizedArtist(current) === normalizedArtist(candidate)) score += 1_000;

  let matchedMetadataValues = 0;
  for (const group of METADATA_GROUPS) {
    const matches = sharedValues(current, candidate, group.keys);
    if (matches > 0) score += group.weight;
    matchedMetadataValues += matches;
  }

  if (current.resourceType === candidate.resourceType) score += 50;
  score += matchedMetadataValues * 5;
  return score;
}

function normalizedArtist(resource: PublicResource): string | undefined {
  const value = resource.artist ?? resource.metadata.artist;
  return normalizedValue(value);
}

function sharedValues(left: PublicResource, right: PublicResource, keys: readonly MetadataKey[]): number {
  const leftValues = new Set(keys.map((key) => normalizedValue(left.metadata[key])).filter((value): value is string => Boolean(value)));
  const rightValues = new Set(keys.map((key) => normalizedValue(right.metadata[key])).filter((value): value is string => Boolean(value)));
  return [...leftValues].filter((value) => rightValues.has(value)).length;
}

function normalizedValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

export const relatedMetadataKeys = SHARED_METADATA_KEYS;
