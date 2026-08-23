import type { Resource } from "../../../../packages/domain/src/schema.js";

type PublicPrimitive = string | number | boolean;

export type PublicDisplayMetadata = {
  title: string;
  artist?: string;
  metadata: Record<string, PublicPrimitive>;
  parsedFilename: boolean;
};

/**
 * Keeps Arcaea's user-facing added-version label concise while leaving the
 * source/projection version available for sorting and historical data.
 */
export function formatArcaeaAddedVersion(value: string): string {
  const trimmed = value.trim();
  return /^\d+\.\d+/u.exec(trimmed)?.[0] ?? trimmed;
}

type PublicDisplayResource = Pick<Resource, "game" | "resourceType" | "title" | "aliases" | "metadata" | "provenance">;

/**
 * Keeps the public projection user-facing without changing Catalog identity.
 * The Arcaea jacket parser follows the legacy extractor's known filename
 * schema: title/artist, version, optional pack markers, IDX, BPM, SIDE.
 */
export function normalizePublicDisplay(resource: PublicDisplayResource, fallbackTitle = "未命名资源"): PublicDisplayMetadata {
  const rawTitle = firstNonEmpty([
    resource.title,
    ...resource.aliases.map((alias) => alias.value),
    ...resource.provenance.map((entry) => entry.sourceFilename),
    fallbackTitle,
  ]) ?? fallbackTitle;

  if (resource.game === "arcaea" && resource.resourceType === "jacket") {
    const parsed = parseArcaeaJacketFilename(rawTitle);
    if (parsed) {
      return {
        title: parsed.title,
        ...(parsed.artist ? { artist: parsed.artist } : {}),
        metadata: compactMetadata({
          ...primitiveMetadata(resource.metadata),
          ...(parsed.artist ? { artist: parsed.artist } : {}),
          ...(parsed.version ? { version: parsed.version } : {}),
          ...(parsed.bpm ? { bpm: parsed.bpm } : {}),
          ...(parsed.side ? { side: parsed.side } : {}),
        }),
        parsedFilename: true,
      };
    }
  }

  return {
    title: stripFileDecoration(rawTitle),
    ...(typeof resource.metadata.artist === "string" && resource.metadata.artist.trim() ? { artist: resource.metadata.artist.trim() } : {}),
    metadata: primitiveMetadata(resource.metadata),
    parsedFilename: false,
  };
}

export function parseArcaeaJacketFilename(value: string): { title: string; artist?: string; version?: string; bpm?: string; side?: string } | undefined {
  const parts = stripFileDecoration(value)
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);
  const idxIndex = parts.findIndex((part) => /^IDX\s+/iu.test(part));
  const bpmIndex = parts.findIndex((part) => /^BPM\s+/iu.test(part));
  const sideIndex = parts.findIndex((part) => /^SIDE\s+/iu.test(part));
  if (idxIndex <= 0 || bpmIndex < 0) return undefined;

  const prefixParts = parts.slice(0, idxIndex);
  const versionIndex = prefixParts.findIndex(isArcaeaVersion);
  if (versionIndex <= 0) return undefined;
  const version = prefixParts[versionIndex];
  if (!version) return undefined;

  const titleArtist = splitArcaeaTitleArtist(prefixParts.slice(0, versionIndex));
  if (!titleArtist.title) return undefined;

  const title = titleArtist.title.trim();
  const artist = titleArtist.artist?.trim();
  if (containsExtractionMarker(title) || containsImageExtension(title)) return undefined;

  return {
    title,
    ...(artist ? { artist } : {}),
    ...(version ? { version } : {}),
    ...((parts[bpmIndex]?.replace(/^BPM\s+/iu, "").trim()) ? { bpm: parts[bpmIndex]!.replace(/^BPM\s+/iu, "").trim() } : {}),
    ...((sideIndex >= 0 && parts[sideIndex]?.replace(/^SIDE\s+/iu, "").trim()) ? { side: parts[sideIndex]!.replace(/^SIDE\s+/iu, "").trim() } : {}),
  };
}

export function hasPublicTitleExtractionMarkers(value: string): boolean {
  return containsExtractionMarker(value) || containsImageExtension(value) || /(?:_opt|_optimization)$/iu.test(value);
}

function splitArcaeaTitleArtist(parts: string[]): { title?: string; artist?: string } {
  if (parts.length === 0) return {};
  if (parts.length === 1) return { title: parts[0] ?? "" };

  const firstMeaningfulPart = parts.findIndex((part) => /[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/u.test(part));
  if (firstMeaningfulPart > 0) {
    return {
      title: parts.slice(0, firstMeaningfulPart).join("_"),
      artist: parts.slice(firstMeaningfulPart).join("_"),
    };
  }

  return { title: parts[0] ?? "", artist: parts.slice(1).join("_") };
}

function isArcaeaVersion(value: string): boolean {
  const parts = value.split(".");
  return parts.length >= 2 && parts.every((part) => part.length > 0 && [...part].every((char) => char >= "0" && char <= "9"));
}

function stripFileDecoration(value: string): string {
  return value
    .trim()
    .replace(/\.(?:jpg|jpeg|png|webp|avif|gif)_opt$/iu, "")
    .replace(/_(?:opt|optimization)$/iu, "")
    .replace(/\.(?:jpg|jpeg|png|webp|avif|gif)$/iu, "")
    .trim();
}

function containsExtractionMarker(value: string): boolean {
  return /(?:^|_)IDX\s+|(?:^|_)BPM\s+|(?:^|_)SIDE\s+/iu.test(value);
}

function containsImageExtension(value: string): boolean {
  return /\.(?:jpg|jpeg|png|webp|avif|gif)(?:_opt)?$/iu.test(value);
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()))?.trim();
}

function primitiveMetadata(metadata: Record<string, unknown>): Record<string, PublicPrimitive> {
  return compactMetadata(Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
  ) as Record<string, PublicPrimitive>);
}

function compactMetadata(metadata: Record<string, PublicPrimitive>): Record<string, PublicPrimitive> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => typeof value !== "string" || value.trim().length > 0));
}
