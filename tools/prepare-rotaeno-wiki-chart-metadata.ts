import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContentAdditionInput } from "../packages/domain/src/content.js";
import { UnifiedAssetManifest } from "../packages/domain/src/release.js";
import { sanitizeRotaenoCharts, type RotaenoPublicChart } from "./rotaeno/chart-metadata.js";

type JsonObject = Record<string, unknown>;
type ChartSong = { songId: string; charts: RotaenoPublicChart[] };
type SourceDocument = {
  version: string;
  sourceSnapshot: string;
  songs: Map<string, ChartSong>;
  sourceUrls: string[];
};

const VERSION = "2.26.1-wiki-chart-metadata-v1";

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseSource(value: unknown): SourceDocument {
  const input = object(value);
  if (input.kind !== "rotaeno-chart-metadata" || input.game !== "rotaeno") {
    throw new Error("invalid Rotaeno Wiki chart metadata document");
  }
  const version = text(input.version);
  const sourceSnapshot = text(input.sourceSnapshot);
  if (!version || !sourceSnapshot || !Array.isArray(input.songs)) {
    throw new Error("Rotaeno Wiki chart metadata document is missing version, sourceSnapshot, or songs");
  }
  const songs = new Map<string, ChartSong>();
  for (const candidate of input.songs) {
    const song = object(candidate);
    const songId = text(song.songId);
    const charts = sanitizeRotaenoCharts(song.charts, "Rotaeno Wiki chart metadata song " + (songId ?? "unknown")) ?? [];
    if (!songId || charts.length === 0) continue;
    if (songs.has(songId)) throw new Error("duplicate Rotaeno Wiki song ID: " + songId);
    songs.set(songId, { songId, charts });
  }
  const sources = object(input.sources);
  const sourceUrls = Object.values(sources).flatMap((value) => text(value) ? [text(value)!] : []);
  return { version, sourceSnapshot, songs, sourceUrls };
}

async function main(): Promise<void> {
  const sourcePath = path.resolve(process.argv[2] ?? "catalog/curation/rotaeno-chart-metadata.json");
  const previousPath = path.resolve(process.argv[3] ?? "temp/rhythmctl/rotaeno/2.26.1-chart-metadata-v1/release-prepare/candidate-manifest.json");
  const outputPath = path.resolve(process.argv[4] ?? "temp/rotaeno_chart_metadata/wiki-content-addition.json");
  const source = parseSource(JSON.parse(await readFile(sourcePath, "utf8")) as unknown);
  const previous = UnifiedAssetManifest.parse(JSON.parse(await readFile(previousPath, "utf8")) as unknown);
  if (previous.gameId !== "rotaeno") throw new Error("previous manifest is not for Rotaeno");

  const entries = previous.entries
    .filter((entry) => entry.assetType === "jacket")
    .flatMap((entry) => {
      const nested = object(object(entry.metadata).metadata);
      const songId = text(nested.songId);
      const song = songId ? source.songs.get(songId) : undefined;
      if (!song) return [];
      const metadata = {
        ...entry.metadata,
        metadata: {
          ...nested,
          charts: song.charts,
          chartDataSource: "Rotaeno APK + Wiki",
          chartDataVersion: source.sourceSnapshot,
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
        origin: "metadata-only" as const,
        needsReview: true,
        needsRename: false,
        anomalies: [],
      }];
    });
  if (entries.length === 0) throw new Error("no Rotaeno jacket entry matched the Wiki chart metadata");

  const input = ContentAdditionInput.parse({
    kind: "rhythm-content-addition",
    schemaVersion: "1",
    gameId: "rotaeno",
    version: VERSION,
    sourceSnapshot: source.sourceSnapshot,
    entries,
    notes: [
      "Metadata-only Rotaeno chart correction from the APK-native chart projection plus the Rotaeno Wiki snapshot.",
      "difficulty is the chart class; level is the Wiki difficulty level; constant is the exact chart constant when the snapshot provides it.",
      "APK-native chart constants take precedence, followed by per-song Wiki pages and then the Wiki high-level constant table.",
      "Encrypted chart bodies and note data were not exported. Jacket resources without a matched chart remain unavailable.",
      ...source.sourceUrls.map((url) => "Source: " + url),
      "Previous manifest: " + path.relative(process.cwd(), previousPath).replaceAll("\\", "/") + ".",
    ],
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(input, null, 2) + "\n", "utf8");
  const chartCount = entries.reduce((count, entry) => {
    const charts = object(object(entry.metadata).metadata).charts;
    return count + (Array.isArray(charts) ? charts.length : 0);
  }, 0);
  console.log(JSON.stringify({
    output: outputPath,
    version: VERSION,
    sourceSongs: source.songs.size,
    matchedJackets: entries.length,
    chartCount,
    unmatchedSourceSongs: [...source.songs.keys()].filter((songId) => !entries.some((entry) => text(object(object(entry.metadata).metadata).songId) === songId)),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
