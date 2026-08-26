import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnifiedAssetManifest } from "../packages/domain/src/release.js";
import { sanitizeRotaenoCharts, type RotaenoPublicChart } from "./rotaeno/chart-metadata.js";

type JsonObject = Record<string, unknown>;
type Chart = RotaenoPublicChart;
type ChartSong = { songId: string; charts: Chart[] };
type ChartDiagnostics = { failures: unknown[]; duplicateCharts: unknown[]; duplicateDifficulties: unknown[]; fallbackChartCount: number; fallbackUnknownSongCount: number };
type ChartManifest = { kind: string; game: string; version: string; sourceSnapshot: string; songs: ChartSong[]; diagnostics: ChartDiagnostics };

const VERSION = "2.26.1-chart-metadata-v1";

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chartDiagnostics(input: JsonObject): ChartDiagnostics {
  const diagnostics = object(input.diagnostics);
  const failures = diagnostics.failures;
  const duplicateCharts = Array.isArray(diagnostics.duplicateCharts) ? diagnostics.duplicateCharts : [];
  const duplicateDifficulties = Array.isArray(diagnostics.duplicateDifficulties) ? diagnostics.duplicateDifficulties : [];
  const fallbackChartCount = diagnostics.fallbackChartCount;
  const fallbackUnknownSongCount = diagnostics.fallbackUnknownSongCount;
  if (!Array.isArray(failures)) throw new Error("Rotaeno chart manifest is missing bundle failure diagnostics");
  if (failures.length > 0) throw new Error("Rotaeno chart scan has " + failures.length + " failed bundle(s); refusing Catalog preparation");
  if (duplicateCharts.length > 0 || duplicateDifficulties.length > 0) throw new Error("Rotaeno chart scan has duplicate chart diagnostics; refusing Catalog preparation");
  if (typeof fallbackChartCount !== "number" || !Number.isInteger(fallbackChartCount) || fallbackChartCount !== 0) throw new Error("Rotaeno chart scan used chart-name association fallback; refusing Catalog preparation");
  if (typeof fallbackUnknownSongCount !== "number" || !Number.isInteger(fallbackUnknownSongCount) || fallbackUnknownSongCount !== 0) throw new Error("Rotaeno chart scan found fallback charts without a same-bundle SongDataSO; refusing Catalog preparation");
  return { failures, duplicateCharts, duplicateDifficulties, fallbackChartCount, fallbackUnknownSongCount };
}
function chartManifest(value: unknown): ChartManifest {
  const input = object(value);
  if (input.kind !== "rotaeno-chart-manifest" || input.game !== "rotaeno" || typeof input.version !== "string" || typeof input.sourceSnapshot !== "string" || !Array.isArray(input.songs)) {
    throw new Error("invalid Rotaeno chart manifest");
  }
  const diagnostics = chartDiagnostics(input);
  const songs = input.songs.flatMap((candidate) => {
    const song = object(candidate);
    const songId = text(song.songId);
    const charts = sanitizeRotaenoCharts(song.charts, "Rotaeno chart manifest song " + (songId ?? "unknown")) ?? [];
    return songId && charts.length > 0 ? [{ songId, charts }] : [];
  });
  return { kind: "rotaeno-chart-manifest", game: "rotaeno", version: input.version, sourceSnapshot: input.sourceSnapshot, songs, diagnostics };
}

async function main(): Promise<void> {
  const chartPath = path.resolve(process.argv[2] ?? "temp/rotaeno_analysis/chart-metadata-v1/rotaeno-chart-manifest.json");
  const previousPath = path.resolve(process.argv[3] ?? "temp/rhythmctl/rotaeno/2.26.1-display-metadata-v1-final2/candidate-manifest.json");
  const outputPath = path.resolve(process.argv[4] ?? "temp/rotaeno_chart_metadata/content-addition.json");
  const charts = chartManifest(JSON.parse(await readFile(chartPath, "utf8")) as unknown);
  const previous = UnifiedAssetManifest.parse(JSON.parse(await readFile(previousPath, "utf8")) as unknown);
  if (previous.gameId !== "rotaeno") throw new Error("previous manifest is not for Rotaeno");

  const chartsBySongId = new Map(charts.songs.map((song) => [song.songId, song]));
  const entries = previous.entries
    .filter((entry) => entry.assetType === "jacket")
    .flatMap((entry) => {
      const songId = text(object(entry.metadata.metadata).songId);
      const song = songId ? chartsBySongId.get(songId) : undefined;
      if (!song) return [];
      const metadata = {
        ...entry.metadata,
        metadata: {
          ...object(entry.metadata.metadata),
          charts: song.charts,
          chartDataSource: "Rotaeno StandardChartDataSO.v2InnerDifficulty",
          chartDataVersion: charts.version,
        },
      };
      return [{
        sourceIdentity: entry.sourceIdentity,
        assetType: entry.assetType,
        variantKey: entry.variantKey,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.artist ? { artist: entry.artist } : {}),
        aliases: [],
        metadata,
        origin: "metadata-only",
        needsReview: true,
        needsRename: false,
        anomalies: [],
      }];
    });
  if (entries.length === 0) throw new Error("no Rotaeno jacket entry matched the chart manifest");

  const input = {
    kind: "rhythm-content-addition",
    schemaVersion: "1",
    gameId: "rotaeno",
    version: VERSION,
    sourceSnapshot: charts.sourceSnapshot,
    entries,
    notes: [
      "Metadata-only Rotaeno chart addition derived from the APK-local StandardChartDataSO records.",
      "difficulty is the source chart class (I, II, III, IV, or IV_Alpha); level is v2InnerDifficulty formatted without binary float noise.",
      "The encrypted chart body and note data were not exported. Unmatched jacket resources remain without chart metadata and are shown as unavailable.",
      `Previous manifest: ${path.relative(process.cwd(), previousPath).replaceAll("\\", "/")}.`,
    ],
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(input, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    output: outputPath,
    version: VERSION,
    chartSongs: charts.songs.length,
    matchedJackets: entries.length,
    unmatchedChartSongs: charts.songs.filter((song) => !previous.entries.some((entry) => entry.assetType === "jacket" && object(entry.metadata.metadata).songId === song.songId)).length,
    chartCount: entries.reduce((count, entry) => { const charts = object(object(entry.metadata).metadata).charts; return count + (Array.isArray(charts) ? charts.length : 0); }, 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
