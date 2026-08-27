import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROTAENO_CHART_DIFFICULTIES, sanitizeRotaenoCharts, sanitizeRotaenoSpecialCharts, type RotaenoPublicChart, type RotaenoPublicSpecialChart } from "./rotaeno/chart-metadata.js";

type JsonObject = Record<string, unknown>;
type SourceSong = {
  songId: string;
  title?: string;
  sourceUrl?: string;
  chartFields: RotaenoPublicChart[];
  specialCharts?: RotaenoPublicSpecialChart[];
  length?: string;
  bpm?: string;
  pack?: string;
  updateVersion?: string;
  updateDate?: string;
  fieldStatus: Record<string, string>;
  metadataStatus: "complete" | "partial" | "special" | "unresolved";
};
type SourceDocument = {
  kind: string;
  schemaVersion: string;
  game: string;
  version: string;
  sourceSnapshot: string;
  retrievedAt: string;
  sources: JsonObject;
  precedence: string[];
  songs: SourceSong[];
  diagnostics?: JsonObject;
  notes?: string[];
};

const VERSION = "2.26.1";
const SOURCE_KIND = "rotaeno-chart-metadata";
const REQUESTED_FIELDS = ["levels", "notes", "length", "bpm", "pack", "updateVersion", "updateDate", "constants"] as const;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedUpdateDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const wrapped = value.match(/^20\((\d{2})\/(\d{2})\/(\d{2})\)$/u);
  if (wrapped) return `20${wrapped[1]}/${wrapped[2]}/${wrapped[3]}`;
  const short = value.match(/^(\d{2})\/(\d{2})\/(\d{2})$/u);
  if (short) return `20${short[1]}/${short[2]}/${short[3]}`;
  return value;
}

function sourceSong(value: unknown, index: number): SourceSong {
  const input = object(value);
  const songId = text(input.songId);
  if (!songId) throw new Error(`source song ${index} is missing songId`);
  const chartFields = sanitizeRotaenoCharts((Array.isArray(input.chartFields) ? input.chartFields : []).map((chart) => ({
    ...object(chart),
    available: typeof object(chart).available === "boolean" ? object(chart).available : true,
    status: object(chart).status === "unavailable" ? "unavailable" : "available",
  })), `source song ${songId} chartFields`) ?? [];
  const specialCharts = sanitizeRotaenoSpecialCharts(input.specialCharts, `source song ${songId} specialCharts`);
  const fieldStatus = Object.fromEntries(REQUESTED_FIELDS.map((field) => [field, text(object(input.fieldStatus)[field]) ?? "unavailable"]));
  const metadataStatus = text(input.metadataStatus);
  if (metadataStatus !== "complete" && metadataStatus !== "partial" && metadataStatus !== "special" && metadataStatus !== "unresolved") {
    throw new Error(`source song ${songId} has an invalid metadataStatus`);
  }
  const result: SourceSong = { songId, chartFields, fieldStatus, metadataStatus };
  const title = text(input.title);
  const sourceUrl = text(input.sourceUrl);
  const length = text(input.length);
  const bpm = text(input.bpm);
  const pack = text(input.pack);
  const updateVersion = text(input.updateVersion);
  const updateDate = normalizedUpdateDate(text(input.updateDate));
  if (title) result.title = title;
  if (sourceUrl) result.sourceUrl = sourceUrl;
  if (specialCharts && specialCharts.length > 0) result.specialCharts = specialCharts;
  if (length) result.length = length;
  if (bpm) result.bpm = bpm;
  if (pack) result.pack = pack;
  if (updateVersion) result.updateVersion = updateVersion;
  if (updateDate) result.updateDate = updateDate;
  return result;
}

function parseSource(value: unknown): SourceDocument {
  const input = object(value);
  if (input.kind !== SOURCE_KIND || input.game !== "rotaeno") throw new Error("invalid Rotaeno Wiki song metadata source");
  const version = text(input.version);
  const schemaVersion = text(input.schemaVersion);
  const sourceSnapshot = text(input.sourceSnapshot);
  const retrievedAt = text(input.retrievedAt);
  if (!version || !schemaVersion || !sourceSnapshot || !retrievedAt || !Array.isArray(input.songs)) {
    throw new Error("Rotaeno Wiki song metadata source is missing required document fields");
  }
  const songs = input.songs.map(sourceSong);
  const ids = new Set<string>();
  for (const song of songs) {
    if (ids.has(song.songId)) throw new Error("duplicate Rotaeno Wiki source song ID: " + song.songId);
    ids.add(song.songId);
  }
  if (songs.length !== 420) throw new Error(`Rotaeno Wiki source must contain 420 song IDs, got ${songs.length}`);
  const precedence = Array.isArray(input.precedence) ? input.precedence.flatMap((item) => text(item) ? [text(item)!] : []) : [];
  return {
    kind: SOURCE_KIND,
    schemaVersion,
    game: "rotaeno",
    version,
    sourceSnapshot,
    retrievedAt,
    sources: object(input.sources),
    precedence,
    songs,
    ...(object(input.diagnostics) ? { diagnostics: object(input.diagnostics) } : {}),
    ...(Array.isArray(input.notes) ? { notes: input.notes.flatMap((item) => text(item) ? [text(item)!] : []) } : {}),
  };
}

function existingSong(value: unknown, index: number): JsonObject & { songId: string } {
  const song = object(value);
  const songId = text(song.songId);
  if (!songId) throw new Error(`curation song ${index} is missing songId`);
  return { ...song, songId };
}

function sourceFields(song: SourceSong): RotaenoPublicChart[] {
  return song.chartFields;
}

function mergeSong(existing: JsonObject & { songId: string }, source: SourceSong): JsonObject {
  const existingCharts = sanitizeRotaenoCharts(existing.charts, `existing Rotaeno song ${source.songId} charts`) ?? [];
  const byDifficulty = new Map(existingCharts.map((chart) => [chart.difficulty, chart]));
  for (const field of sourceFields(source)) {
    const previous = byDifficulty.get(field.difficulty);
    const merged = {
      ...(previous ?? { difficulty: field.difficulty, available: true, status: "available" as const }),
      ...(field.level !== undefined ? { level: field.level } : {}),
      ...(field.notes !== undefined ? { notes: field.notes } : {}),
      ...(field.constant !== undefined && (!previous?.constant || (previous.source !== "apk" && previous.source !== "merged")) ? { constant: field.constant } : {}),
      available: field.available,
      status: field.status,
    } as RotaenoPublicChart;
    if (previous?.source) merged.source = previous.source;
    else if (field.source) merged.source = field.source;
    else merged.source = "wiki";
    byDifficulty.set(field.difficulty, merged);
  }
  const charts = [...byDifficulty.values()].sort((left, right) => ROTAENO_CHART_DIFFICULTIES.indexOf(left.difficulty) - ROTAENO_CHART_DIFFICULTIES.indexOf(right.difficulty));
  const output: JsonObject = {
    ...existing,
    charts,
    ...(source.specialCharts && source.specialCharts.length > 0 ? { specialCharts: source.specialCharts } : {}),
    ...(source.length ? { length: source.length } : {}),
    ...(source.bpm ? { bpm: source.bpm } : {}),
    ...(source.pack ? { pack: source.pack } : {}),
    ...(source.updateVersion ? { updateVersion: source.updateVersion } : {}),
    ...(source.updateDate ? { updateDate: normalizedUpdateDate(source.updateDate) } : {}),
    metadataStatus: source.metadataStatus,
    metadataCoverage: source.fieldStatus,
    ...(source.sourceUrl && !text(existing.sourceUrl) ? { sourceUrl: source.sourceUrl } : {}),
  };
  return output;
}

function countCharts(songs: JsonObject[]): { chartCount: number; specialChartCount: number; levelCount: number; notesCount: number; constantCount: number } {
  let chartCount = 0;
  let specialChartCount = 0;
  let levelCount = 0;
  let notesCount = 0;
  let constantCount = 0;
  for (const song of songs) {
    const charts = Array.isArray(song.charts) ? song.charts : [];
    const specialCharts = Array.isArray(song.specialCharts) ? song.specialCharts : [];
    chartCount += charts.length;
    specialChartCount += specialCharts.length;
    for (const chart of charts) {
      const item = object(chart);
      if (text(item.level)) levelCount += 1;
      if (typeof item.notes === "number") notesCount += 1;
      if (text(item.constant)) constantCount += 1;
    }
    for (const chart of specialCharts) {
      const item = object(chart);
      if (text(item.level)) levelCount += 1;
      if (typeof item.notes === "number") notesCount += 1;
    }
  }
  return { chartCount, specialChartCount, levelCount, notesCount, constantCount };
}

function missingSongIds(songs: JsonObject[], field: string): string[] {
  return songs.flatMap((song) => {
    const value = field === "charts" || field === "specialCharts" ? song[field] : song[field];
    if (field === "charts") return Array.isArray(value) && value.length > 0 ? [] : [text(song.songId)!];
    if (field === "specialCharts") return Array.isArray(value) && value.length > 0 ? [] : [text(song.songId)!];
    return text(value) ? [] : [text(song.songId)!];
  });
}

async function main(): Promise<void> {
  const sourcePath = path.resolve(process.argv[2] ?? "temp/rotaeno_analysis/rotaeno-jp-wiki-song-info-2026-08-27.json");
  const curationPath = path.resolve(process.argv[3] ?? "catalog/curation/rotaeno-chart-metadata.json");
  const outputPath = path.resolve(process.argv[4] ?? curationPath);
  const source = parseSource(JSON.parse(await readFile(sourcePath, "utf8")) as unknown);
  const curation = object(JSON.parse(await readFile(curationPath, "utf8")) as unknown);
  if (curation.kind !== SOURCE_KIND || curation.game !== "rotaeno" || !Array.isArray(curation.songs)) {
    throw new Error("invalid existing Rotaeno chart metadata curation");
  }
  const currentSongs = curation.songs.map(existingSong);
  const currentIds = new Set(currentSongs.map((song) => song.songId));
  if (currentSongs.length !== 420 || currentIds.size !== currentSongs.length) throw new Error("existing Rotaeno curation must contain 420 unique song IDs");
  const sourceById = new Map(source.songs.map((song) => [song.songId, song]));
  const sourceOnly = [...sourceById.keys()].filter((songId) => !currentIds.has(songId));
  const curationOnly = [...currentIds].filter((songId) => !sourceById.has(songId));
  if (sourceOnly.length > 0 || curationOnly.length > 0) {
    throw new Error(`Rotaeno source/curation ID mismatch; source-only=${sourceOnly.join(",")}; curation-only=${curationOnly.join(",")}`);
  }
  const songs = currentSongs.map((song) => mergeSong(song, sourceById.get(song.songId)!));
  const counts = countCharts(songs);
  const metadataStatusCounts = Object.fromEntries(["complete", "partial", "special", "unresolved"].map((status) => [status, songs.filter((song) => song.metadataStatus === status).length]));
  const diagnostics = {
    ...object(curation.diagnostics),
    songCount: songs.length,
    sourceSongCount: source.songs.length,
    chartBearingSongCount: songs.filter((song) => Array.isArray(song.charts) && song.charts.length > 0).length,
    specialSongCount: songs.filter((song) => Array.isArray(song.specialCharts) && song.specialCharts.length > 0).length,
    ...counts,
    metadataStatusCounts,
    missingChartSongIds: missingSongIds(songs, "charts"),
    unresolvedSongIds: songs.filter((song) => song.metadataStatus === "unresolved").map((song) => song.songId),
    missingSongMetadata: Object.fromEntries(["length", "bpm", "pack", "updateVersion", "updateDate"].map((field) => [field, missingSongIds(songs, field)])),
    idMapping: {
      sourceSongCount: source.songs.length,
      curationSongCount: currentSongs.length,
      sourceOnly,
      curationOnly,
      duplicateSourceIds: [],
      duplicateCurationIds: [],
      titleAudit: "Asset songId is the join key; curation title is retained and Wiki title is source-scoped.",
    },
  };
  const output = {
    ...curation,
    schemaVersion: "1",
    version: VERSION,
    sourceSnapshot: source.sourceSnapshot,
    retrievedAt: source.retrievedAt,
    sources: source.sources,
    precedence: source.precedence,
    songs,
    diagnostics,
    notes: [
      "Song-level metadata is sourced from the Rotaeno Wiki per-song pages and its length/BPM/update indexes.",
      "Level is preserved as Wiki display text; values such as Lv.4 and Aleph 0 are intentionally not coerced to numbers.",
      "Notes are Rotaeno chart note counts only. Values unavailable in the Rotaeno sources remain absent and are reported by metadataCoverage.",
      "Constants use the existing APK-native -> Wiki per-song -> Wiki high-level precedence; an absent low-level constant is not inferred.",
      "The source/curation join is by the verified 420-song asset songId set; curation titles are not replaced by Wiki aliases.",
      "Special-only April Fools charts are kept in specialCharts and do not masquerade as standard I/II/III/IV/IV-alpha charts.",
      ...source.notes ?? [],
    ],
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    output: outputPath,
    sourceSnapshot: source.sourceSnapshot,
    songCount: songs.length,
    ...counts,
    metadataStatusCounts,
    missingSongMetadata: diagnostics.missingSongMetadata,
    unresolvedSongIds: diagnostics.unresolvedSongIds,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
