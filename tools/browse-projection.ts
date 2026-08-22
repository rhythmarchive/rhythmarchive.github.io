import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ArcaeaBrowseProjection,
  ArcaeaCuration,
  ArcaeaSourceMetadata,
  PhigrosBrowseProjection,
  PhigrosSourceMetadata,
  buildBrowseProjections,
  catalogSha256FromValue,
  loadCatalogFile,
  writeBrowseProjectionAtomic,
  type ArcaeaSourceMetadataType,
  type Catalog as CatalogType,
  type PhigrosSourceMetadataType,
} from "../packages/domain/src/index.js";

type CsvRow = Record<string, string | undefined>;

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.endsWith("\r") ? cell.slice(0, -1) : cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.endsWith("\r") ? cell.slice(0, -1) : cell);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.filter((cells) => cells.some((value) => value.length > 0)).map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])));
}

async function csv(filePath: string): Promise<CsvRow[]> {
  return parseCsv(await readFile(filePath, "utf8"));
}

async function json<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

function numberOrNull(value: string | undefined): number | null {
  const normalized = nonEmpty(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: string | undefined): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function relativeSourcePath(value: string | undefined): string | undefined {
  const normalized = nonEmpty(value)?.replaceAll("\\", "/");
  if (!normalized || /^[a-zA-Z]:[\\/]/u.test(normalized) || normalized.startsWith("/") || normalized.startsWith("\\")) return undefined;
  return normalized;
}

function phigrosTrackIdentity(value: string | undefined, fallback: string): string {
  const normalized = nonEmpty(value)?.replaceAll("\\", "/");
  const candidate = normalized?.replace(/^phigros:trackpath=/u, "");
  return relativeSourcePath(candidate) ?? fallback;
}

function apkVersion(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const record = value as { manifest?: { attributes?: { versionName?: unknown } } };
  return typeof record.manifest?.attributes?.versionName === "string" ? record.manifest.attributes.versionName : "unknown";
}

function parseLocalizedValues(value: string | undefined): string[] {
  const normalized = nonEmpty(value);
  if (!normalized) return [];
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.values(parsed as Record<string, unknown>).flatMap((item) => typeof item === "string" ? [item] : []);
  } catch {
    return [];
  }
}

function flattenStringMap(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) => Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : typeof item === "string" ? [item] : []);
}

function parsePackName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/(?:^|;)en=(.*?)(?:;|$)/u);
  return nonEmpty(match?.[1]) ?? nonEmpty(value) ?? null;
}

type ArcaeaPreviewArtwork = { role?: string; difficulty?: string; resourceId?: string; matchStatus?: string };
type ArcaeaPreviewSong = {
  songId: string;
  title: string;
  titleLocalized?: Record<string, unknown>;
  searchTitle?: Record<string, unknown>;
  artist: string;
  searchArtist?: Record<string, unknown>;
  pack?: { packId?: string; localizedNames?: string };
  version?: string | number;
  date?: number;
  sideRaw?: number;
  bpm?: string;
  idx?: number;
  charts?: Array<{ difficultyClass: string; displayLevel: string }>;
  artworks?: ArcaeaPreviewArtwork[];
  relatedSongRecords?: Array<{ songId: string; relation: string; evidence: string }>;
  specialRelation?: string;
};

function arcaeaRole(value: string | undefined): "default" | "difficulty" | "night/special" | undefined {
  if (value === "default") return "default";
  if (value === "difficulty-specific" || value === "difficulty") return "difficulty";
  if (value === "night/special" || value === "night") return "night/special";
  return undefined;
}

function arcaeaDifficulty(value: string | undefined): "PST" | "PRS" | "FTR" | "BYD" | "ETR" | undefined {
  return value === "PST" || value === "PRS" || value === "FTR" || value === "BYD" || value === "ETR" ? value : undefined;
}

function uniqueCatalogJacketIdsBySha256(catalog: CatalogType): Map<string, string> {
  const idsByHash = new Map<string, Set<string>>();
  for (const resource of catalog.resources) {
    if (resource.game !== "arcaea" || resource.resourceType !== "jacket") continue;
    for (const provenance of resource.provenance) {
      const hash = provenance.sourceSha256.toLowerCase();
      idsByHash.set(hash, new Set([...(idsByHash.get(hash) ?? []), resource.id]));
    }
  }
  return new Map([...idsByHash.entries()].flatMap(([hash, ids]) => ids.size === 1 ? [[hash, [...ids][0]!] as const] : []));
}

async function bootstrapArcaea(auditDirectory: string, catalog: CatalogType): Promise<ArcaeaSourceMetadataType> {
  const preview = await json<{ songs: ArcaeaPreviewSong[] }>(path.join(auditDirectory, "arcaea-song-browse-projection.preview.json"));
  const currentArtworkRows = await csv(path.join(auditDirectory, "arcaea-apk-current-artworks.csv"));
  const reconciliationRows = await csv(path.join(auditDirectory, "arcaea-jacket-reconciliation.csv"));
  const manifest = await json<unknown>(path.join(auditDirectory, "arcaea-manifest.json"));
  const summary = await json<{ inputs?: { apkSha256?: string }; apk?: { versionName?: string } }>(path.join(auditDirectory, "arcaea-reconciliation-summary.json"));
  const sourceSha256 = nonEmpty(currentArtworkRows[0]?.apkSha256) ?? nonEmpty(summary.inputs?.apkSha256);
  if (!sourceSha256) throw new Error("Arcaea bootstrap data has no APK SHA-256.");
  const version = apkVersion(manifest) !== "unknown" ? apkVersion(manifest) : summary.apk?.versionName ?? "unknown";
  const catalogJacketIdsBySha256 = uniqueCatalogJacketIdsBySha256(catalog);
  const songIds = new Set(preview.songs.map((song) => song.songId));
  const primarySlots = new Map<string, CsvRow>();
  for (const row of currentArtworkRows) {
    const songId = nonEmpty(row.songId);
    if (!songId || !nonEmpty(row.resolutionRole)?.toLowerCase().includes("primary")) continue;
    const role = arcaeaRole(nonEmpty(row.artworkRoleCandidate));
    if (!role) continue;
    const difficultyClass = arcaeaDifficulty(nonEmpty(row.difficultyClassCandidate));
    const key = `${songId}:${role}:${difficultyClass ?? ""}`;
    const previous = primarySlots.get(key);
    if (!previous || (row.apkPath ?? "").localeCompare(previous.apkPath ?? "", "en") < 0) primarySlots.set(key, row);
  }
  const slotRowsBySong = new Map<string, CsvRow[]>();
  for (const row of primarySlots.values()) {
    const songId = nonEmpty(row.songId);
    if (songId) slotRowsBySong.set(songId, [...(slotRowsBySong.get(songId) ?? []), row]);
  }
  const songs = preview.songs.map((song) => {
    const previewArtworks = song.artworks ?? [];
    const artworks = (slotRowsBySong.get(song.songId) ?? []).map((row) => {
      const role = arcaeaRole(nonEmpty(row.artworkRoleCandidate))!;
      const difficultyClass = arcaeaDifficulty(nonEmpty(row.difficultyClassCandidate));
      const previewArtwork = previewArtworks.find((artwork) => arcaeaRole(artwork.role) === role && arcaeaDifficulty(nonEmpty(artwork.difficulty)) === difficultyClass);
      const resourceId = nonEmpty(previewArtwork?.resourceId)
        ?? catalogJacketIdsBySha256.get(nonEmpty(row.fileSha256)?.toLowerCase() ?? "")
        ?? null;
      return {
        role,
        ...(difficultyClass ? { difficultyClass } : {}),
        resourceId,
        currentApkPresence: true,
        ...(nonEmpty(previewArtwork?.matchStatus) ? { matchStatus: previewArtwork!.matchStatus } : resourceId ? { matchStatus: "confirmed" as const } : { matchStatus: "missing" as const }),
        ...(relativeSourcePath(row.apkPath) ? { sourcePath: relativeSourcePath(row.apkPath)! } : {}),
      };
    });
    const titleAliases = [...parseLocalizedValues(JSON.stringify(song.titleLocalized)), ...flattenStringMap(song.searchTitle)];
    const artistAliases = flattenStringMap(song.searchArtist);
    return {
      songId: song.songId,
      displayTitle: song.title,
      titleAliases: uniqueStrings(titleAliases),
      artist: song.artist,
      artistAliases: uniqueStrings(artistAliases),
      packId: nonEmpty(song.pack?.packId) ?? "unknown",
      packDisplayName: parsePackName(song.pack?.localizedNames),
      version: song.version === undefined ? null : String(song.version),
      date: song.date ?? null,
      sideRaw: song.sideRaw ?? null,
      bpm: nonEmpty(song.bpm) ?? null,
      orderHint: song.idx ?? 0,
      charts: (song.charts ?? []).map((chart) => ({ difficultyClass: arcaeaDifficulty(chart.difficultyClass)!, displayLevel: chart.displayLevel })),
      artworks,
      relatedSongs: (song.relatedSongRecords ?? []).map((relation) => ({ songId: relation.songId, relationType: relation.relation, ...(nonEmpty(relation.evidence) ? { note: relation.evidence } : {}) })),
      ...(song.specialRelation ? { specialRelation: song.specialRelation } : {}),
    };
  });
  const resourceSemantics = reconciliationRows.map((row) => {
    const semanticStatus = nonEmpty(row.semanticStatus);
    const bucket = semanticStatus === "current-default-artwork" || semanticStatus === "current-difficulty-artwork" || semanticStatus === "current-special-artwork"
      ? "regular"
      : semanticStatus === "april-fools-special-song-artwork" ? "special"
        : semanticStatus === "legacy-duplicate-candidate" ? "archiveExtra" : "unresolvedExtra";
    const difficultyClass = arcaeaDifficulty(nonEmpty(row.matchedDifficulty));
    return {
      resourceId: row.resourceId,
      bucket,
      reason: semanticStatus ?? "unresolved-catalog-resource",
      ...(nonEmpty(row.matchedSongId) ? { relatedSongId: row.matchedSongId } : {}),
      ...(difficultyClass ? { difficultyClass } : {}),
      ...(nonEmpty(row.specialType) ? { specialType: row.specialType } : {}),
      ...(nonEmpty(row.displayTitle) ? { displayTitle: row.displayTitle } : {}),
      ...(nonEmpty(row.sourceFilename) ? { sourceFilename: row.sourceFilename } : {}),
    };
  });
  return ArcaeaSourceMetadata.parse({ schemaVersion: 1, game: "arcaea", sourceVersion: version, sourceSha256: sourceSha256.toLowerCase(), songs, resourceSemantics });
}

type PhigrosPreviewTrack = {
  sourceIdentityCandidate: string;
  sourceTrackPath: string;
  displayTitle?: string;
  sourceTitle?: string;
  artist?: string | null;
  sourceArtist?: string | null;
  indexRaw?: string | null;
  artwork?: { resourceId?: string; confidence?: string };
  charts?: Array<{ difficultyClass: string; structurallyPresent: boolean; errorVariant?: boolean }>;
};

function phigrosDifficulty(value: string | undefined): "EZ" | "HD" | "IN" | "AT" | "Legacy" | undefined {
  return value === "EZ" || value === "HD" || value === "IN" || value === "AT" || value === "Legacy" ? value : undefined;
}

function phigrosConfidence(value: string | undefined): "confirmed" | "high" | "medium" | "low" | "unknown" {
  return value === "confirmed" || value === "high" || value === "medium" || value === "low" || value === "unknown" ? value : "unknown";
}

async function bootstrapPhigros(auditDirectory: string): Promise<PhigrosSourceMetadataType> {
  const preview = await json<PhigrosPreviewTrack[]>(path.join(auditDirectory, "phigros-track-browse-projection.preview.json"));
  const specialRelations = await csv(path.join(auditDirectory, "phigros-special-track-relations.csv"));
  const reconciliationRows = await csv(path.join(auditDirectory, "phigros-catalog-reconciliation.csv"));
  const summary = await json<{ inputs?: { apkSha256?: string }; apk?: { versionName?: string } }>(path.join(auditDirectory, "phigros-reconciliation-summary.json"));
  const manifest = await json<unknown>(path.join(auditDirectory, "phigros-manifest.json"));
  const sourceSha256 = nonEmpty(summary.inputs?.apkSha256);
  if (!sourceSha256) throw new Error("Phigros bootstrap data has no APK SHA-256.");
  const relationByPath = new Map<string, CsvRow[]>();
  for (const relation of specialRelations) {
    const trackPath = nonEmpty(relation.trackPath);
    if (trackPath) relationByPath.set(trackPath, [...(relationByPath.get(trackPath) ?? []), relation]);
  }
  const errorRows = specialRelations.filter((relation) => relation.caseType === "error-chart-variant");
  const tracks = preview.map((track) => {
    const relations = relationByPath.get(track.sourceTrackPath) ?? [];
    const errorCharts = errorRows.filter((relation) => nonEmpty(relation.trackPath) === track.sourceTrackPath).map((relation) => ({ difficultyClass: phigrosDifficulty(relation.difficulty)!, structurallyPresent: true, errorVariant: true }));
    const familyMatch = track.sourceTrackPath.match(/^Assets\/Tracks\/(Random\.SobremSilentroom)\.(\d+)\/$/u);
    const family = familyMatch ? { familyId: familyMatch[1]!, memberIndex: Number(familyMatch[2]), memberCount: 7, primaryMemberIndex: 0 } : undefined;
    const introduction = relations.some((relation) => relation.caseType === "introduction-system-or-tutorial-candidate");
    const random = relations.some((relation) => relation.caseType === "random-family-member");
    const sourceTitle = nonEmpty(track.sourceTitle) ?? "unknown";
    const sourceTrackPath = relativeSourcePath(track.sourceTrackPath) ?? track.sourceTrackPath;
    return {
      sourceIdentityCandidate: phigrosTrackIdentity(track.sourceIdentityCandidate, sourceTrackPath),
      sourceTrackPath,
      ...(nonEmpty(track.displayTitle) ? { displayTitle: track.displayTitle } : {}),
      sourceTitle,
      displayArtist: nonEmpty(track.artist ?? undefined) ?? null,
      sourceArtist: nonEmpty(track.sourceArtist ?? undefined) ?? null,
      indexRaw: nonEmpty(track.indexRaw ?? undefined) ?? null,
      artworkResourceId: nonEmpty(track.artwork?.resourceId) ?? null,
      ...(track.artwork?.confidence ? { artworkConfidence: phigrosConfidence(track.artwork.confidence) } : {}),
      charts: [...(track.charts ?? []).map((chart) => ({ difficultyClass: phigrosDifficulty(chart.difficultyClass)!, structurallyPresent: chart.structurallyPresent, errorVariant: Boolean(chart.errorVariant) })), ...errorCharts],
      ...(introduction ? { specialKind: "system-or-tutorial-candidate" as const } : random ? { specialKind: "random-family-member" as const } : {}),
      ...(family ? { family } : {}),
      searchAliases: [],
    };
  });
  const resourceSemantics = reconciliationRows.flatMap((row) => {
    const resourceType = nonEmpty(row.resourceType);
    const semanticStatus = nonEmpty(row.semanticStatus);
    const bucket = resourceType === "phigros-april-fools" ? "special" : semanticStatus === "historical-artwork" ? "archiveExtra" : "current";
    if (resourceType !== "jacket" && resourceType !== "phigros-april-fools") return [];
    return [{
      resourceId: row.resourceId,
      bucket,
      reason: semanticStatus ?? (bucket === "special" ? "april-fools-artwork" : "current-track-artwork"),
      ...(nonEmpty(row.displayTitle) ? { displayTitle: row.displayTitle } : {}),
      ...(nonEmpty(row.sourceFilename) ? { sourceFilename: row.sourceFilename } : {}),
    }];
  });
  return PhigrosSourceMetadata.parse({ schemaVersion: 1, game: "phigros", sourceVersion: apkVersion(manifest) !== "unknown" ? apkVersion(manifest) : summary.apk?.versionName ?? "unknown", sourceSha256: sourceSha256.toLowerCase(), tracks, resourceSemantics });
}

type CliOptions = {
  catalog: string;
  output: string;
  curation: string;
  auditDirectory: string | undefined;
  arcaeaSource: string | undefined;
  phigrosSource: string | undefined;
  generatedAt: string;
};

function optionsFromArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    catalog: value("--catalog") ?? "catalog/index.json",
    output: value("--output") ?? "catalog/browse",
    curation: value("--curation") ?? "catalog/curation/arcaea-april-fools.json",
    auditDirectory: value("--bootstrap-audit"),
    arcaeaSource: value("--arcaea-source"),
    phigrosSource: value("--phigros-source"),
    generatedAt: value("--generated-at") ?? new Date().toISOString(),
  };
}

async function optionalJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return await json<T>(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const options = optionsFromArgs(process.argv.slice(2));
  const catalogPath = path.resolve(options.catalog);
  const outputDirectory = path.resolve(options.output);
  const catalog = await loadCatalogFile(catalogPath);
  const catalogSha256 = catalogSha256FromValue(catalog);
  const curation = ArcaeaCuration.parse(await json<unknown>(path.resolve(options.curation)));
  let arcaea: ArcaeaSourceMetadataType | undefined;
  let phigros: PhigrosSourceMetadataType | undefined;
  if (options.auditDirectory) {
    if (options.arcaeaSource || options.phigrosSource) throw new Error("--bootstrap-audit cannot be combined with --arcaea-source or --phigros-source.");
    // Explicit one-time migration path. Production updates should pass
    // extractor/reviewer output with --arcaea-source and --phigros-source.
    arcaea = await bootstrapArcaea(path.resolve(options.auditDirectory), catalog);
    phigros = await bootstrapPhigros(path.resolve(options.auditDirectory));
  } else if (options.arcaeaSource && options.phigrosSource) {
    arcaea = ArcaeaSourceMetadata.parse(await json<unknown>(path.resolve(options.arcaeaSource)));
    phigros = PhigrosSourceMetadata.parse(await json<unknown>(path.resolve(options.phigrosSource)));
  } else {
    throw new Error("Provide both --arcaea-source and --phigros-source, or explicitly use --bootstrap-audit for the migration baseline.");
  }
  const previousArcaea = await optionalJsonFile<unknown>(path.join(outputDirectory, "arcaea.json"));
  const previousPhigros = await optionalJsonFile<unknown>(path.join(outputDirectory, "phigros.json"));
  const result = buildBrowseProjections({
    catalog,
    catalogSha256,
    arcaea,
    phigros,
    arcaeaCuration: curation,
    generatedAt: options.generatedAt,
    ...(previousArcaea && previousPhigros ? { previous: { arcaea: ArcaeaBrowseProjection.parse(previousArcaea), phigros: PhigrosBrowseProjection.parse(previousPhigros) } } : {}),
  });
  const files = await writeBrowseProjectionAtomic(result, outputDirectory, catalog);
  console.log(JSON.stringify({
    outputDirectory,
    files,
    schemaVersion: 1,
    arcaea: result.arcaea.recordCounts,
    phigros: result.phigros.recordCounts,
    diagnostics: {
      arcaea: result.diagnostics.arcaea,
      phigros: result.diagnostics.phigros,
    },
  }, null, 2));
}

await main();
