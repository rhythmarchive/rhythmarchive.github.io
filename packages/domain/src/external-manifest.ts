import { z } from "zod";
import { createDeterministicUuidV7 } from "./identity.js";
import { Game, ResourceType } from "./schema.js";
import { releaseIdentityKey, UnifiedAssetManifest, UnifiedAssetManifestEntry, type UnifiedAssetManifest as UnifiedAssetManifestType, type UnifiedManifestFile } from "./release.js";

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(cleanJson).filter((item) => item !== undefined);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cleanJson(item)]).filter(([, item]) => item !== undefined));
  return String(value);
}

function resourceType(family: string | undefined): z.infer<typeof ResourceType> {
  const mapping: Record<string, z.infer<typeof ResourceType>> = {
    illustration: "jacket", altIllustration: "special-art", seriesPoster: "track-series", seriesBanner: "track-series",
    "avatar.npc": "character-avatar", rizcard: "rizcard", layout: "rizcard-layout", banner: "other",
    jacket: "jacket", "pack-cover": "pack-cover", "character-portrait": "character-portrait", "character-avatar": "character-avatar",
    "special-art": "special-art", "story-cg": "story-cg", startup: "startup", background: "background",
  };
  return mapping[family ?? ""] ?? "other";
}

function portable(value: string | undefined): string | undefined {
  if (!value || /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith("\\")) return undefined;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("\0") || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function externalFile(record: Record<string, unknown>): UnifiedManifestFile | undefined {
  const sha256 = text(record, "decoded_sha256") ?? text(record, "sha256");
  if (!sha256 || !/^[0-9a-f]{64}$/iu.test(sha256)) return undefined;
  return {
    sha256, objectId: `sha256:${sha256}`, objectKey: `objects/${sha256}/png`, mime: "image/png",
    ...(numberValue(record, "size_bytes") !== undefined ? { sizeBytes: numberValue(record, "size_bytes") } : {}),
    ...(numberValue(record, "width") !== undefined ? { width: numberValue(record, "width") } : {}),
    ...(numberValue(record, "height") !== undefined ? { height: numberValue(record, "height") } : {}),
  };
}

function objectRecords(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const values = value as Record<string, unknown>;
  const source = Array.isArray(values.assets) ? values.assets : Array.isArray(values.songs) ? values.songs : [];
  return source.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

export function manifestFromExternalManifest(value: unknown, options: { gameId: z.infer<typeof Game>; version: string; sourceSnapshot?: string; generatedAt?: string }): UnifiedAssetManifestType {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("external adapter output must be a JSON object");
  const root = value as Record<string, unknown>;
  const records = objectRecords(value);
  const entries = records.map((record) => {
    if (options.gameId === "infalsus") {
      const artwork = record.artwork && typeof record.artwork === "object" && !Array.isArray(record.artwork) ? record.artwork as Record<string, unknown> : {};
      const canonical = artwork.canonical && typeof artwork.canonical === "object" && !Array.isArray(artwork.canonical) ? artwork.canonical as Record<string, unknown> : {};
      const sourceIdentity = text(record, "identity") ?? text(artwork, "identity") ?? `infalsus:song:${text(record, "song_id") ?? "unknown"}`;
      const identityKey = releaseIdentityKey({ gameId: options.gameId, assetType: "jacket", sourceIdentity, variantKey: "default" });
      return UnifiedAssetManifestEntry.parse({
        assetId: createDeterministicUuidV7(`asset:${identityKey}`), identityKey, gameId: options.gameId, assetType: "jacket", variantKey: "default",
        ...(text(record, "title") ? { title: text(record, "title") } : {}), ...(text(record, "artist") ? { artist: text(record, "artist") } : {}),
        aliases: [text(record, "base_name"), text(record, "song_id")].filter((item): item is string => Boolean(item)), sourceIdentity,
        metadata: cleanJson({ songId: record.song_id, jacketIllustrator: record.jacket_illustrator, pixelSha256: canonical.pixel_sha256, addressables: artwork.addressables }) as Record<string, unknown>,
      });
    }
    const family = text(record, "asset_family");
    const assetType = resourceType(family);
    const sourceIdentity = text(record, "source_identity") ?? text(record, "logical_key") ?? [options.gameId, text(record, "semantic_id") ?? "unknown"].join(":");
    const variantKey = text(record, "resolved_variant") ?? text(record, "preferred_variant") ?? text(record, "variant") ?? "default";
    const identityKey = releaseIdentityKey({ gameId: options.gameId, assetType, sourceIdentity, variantKey });
    const parseStatus = text(record, "parse_status");
    const reviewStatus = text(record, "review_status");
    const exportPath = portable(text(record, "export_path"));
    return UnifiedAssetManifestEntry.parse({
      assetId: createDeterministicUuidV7(`asset:${identityKey}`), identityKey, gameId: options.gameId, assetType, variantKey,
      ...(text(record, "title") ?? text(record, "semantic_id") ? { title: text(record, "title") ?? text(record, "semantic_id") } : {}), ...(text(record, "artist") ? { artist: text(record, "artist") } : {}), aliases: [text(record, "logical_key"), ...(Array.isArray(record.aliases) ? record.aliases.filter((item): item is string => typeof item === "string") : [])].filter((item): item is string => Boolean(item)), sourceIdentity,
      ...(exportPath ? { sourcePath: exportPath } : {}), ...(externalFile(record) ? { file: externalFile(record) } : {}),
      metadata: cleanJson(record) as Record<string, unknown>, needsReview: (reviewStatus !== undefined && reviewStatus !== "APPROVED") || (parseStatus !== undefined && parseStatus !== "SUCCESS"),
      anomalies: parseStatus && parseStatus !== "SUCCESS" ? [`adapter parse status: ${parseStatus}`] : [],
    });
  });
  if (entries.length === 0) throw new Error("external adapter output contains no assets or songs");
  return UnifiedAssetManifest.parse({
    kind: "rhythm-unified-asset-manifest", schemaVersion: "1", gameId: options.gameId, version: options.version,
    generatedAt: options.generatedAt ?? text(root, "generated_at") ?? new Date().toISOString(),
    sourceSnapshot: options.sourceSnapshot ?? text(root, "source_snapshot") ?? `external:${options.gameId}:${options.version}`,
    entries: entries.sort((left, right) => left.identityKey.localeCompare(right.identityKey)),
    notes: ["Normalized from a game-specific adapter manifest; source-specific fields remain in entry metadata."],
  });
}
