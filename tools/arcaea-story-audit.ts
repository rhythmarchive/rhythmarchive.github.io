import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  ARCAEA_STORY_ATLAS_SCHEMA_VERSION,
  ArcaeaStoryAtlas,
  ArcaeaStoryRelationEvidence,
  ArcaeaStoryScene,
  ArcaeaStoryTextProjection,
  type ArcaeaStoryAtlasType,
  type ArcaeaStoryRelationEvidenceType,
  type ArcaeaStorySceneType,
  type ArcaeaStoryTextBlockType,
} from "../packages/domain/src/browse.js";
import { validateCatalog } from "../packages/domain/src/validation.js";
import type { Catalog } from "../packages/domain/src/schema.js";

export const STORY_PARSER_VERSION = "arcaea-story-parser/1";
export const STORY_LOCALES = ["zh-Hans", "zh-Hant", "en", "ja", "ko"] as const;
export const CANDIDATE_ASSETS = [
  "1-ZR.jpg", "11-8-2.jpg", "12-6-2.jpg", "12-X.jpg", "16-7-2.jpg", "17-6-2.jpg",
  "2-D.jpg", "21-5-2.jpg", "22-2-2.jpg", "99-6.jpg", "E-1_epilogue.jpg", "E-2_epilogue.jpg",
  "E-4_epilogue.jpg", "F-2.jpg", "F-5.jpg", "F-7.jpg", "F-7-1.jpg", "F-7-2.jpg", "V-10.jpg",
] as const;

type JsonRecord = Record<string, unknown>;
type EntryRecord = {
  rawEntryKey: string;
  nodeKey: string;
  pathId: number;
  storyType: "nvl" | "vn";
  storyData?: string;
  characterIds: number[];
  clearSongId?: string;
  playableSongBgmId?: string;
  bgmOverride?: string;
  requiredPurchase?: string;
  requiredPurchaseAlternate?: string;
  requiredMinor?: number;
  additionalRequires: string[];
  requirementAnomalyId?: string;
  unlockedSongId?: string;
  mapId?: string;
  hasAlternative?: boolean;
  blockReadingUntilPrevRead?: boolean;
  hiddenFromCount?: boolean;
  storyCgPaths: string[];
  sourcePath: string;
};

type ParsedVns = {
  scriptStem: string;
  locale: string;
  sourcePath: string;
  sayBlocks: Array<{ page: number; text: string }>;
  commandCounts: Record<string, number>;
  visualReferences: Array<{ assetPath: string; commands: string[] }>;
  audioReferences: Array<{ assetPath: string; commands: string[] }>;
};

const normalizeSlash = (value: string): string => value.replaceAll("\\", "/").replace(/^\/+/, "");

export function normalizeStoryAssetPath(value: string): string | undefined {
  let normalized = normalizeSlash(value).replace(/^\.\//, "");
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  normalized = normalized.replace(/^assets\//, "");
  if (normalized.startsWith("cg/")) return `assets/app-data/story/${normalized}`;
  if (normalized.startsWith("vn/res/")) return `assets/app-data/story/${normalized}`;
  if (normalized.startsWith("app-data/")) return `assets/${normalized}`;
  if (normalized.startsWith("img/")) return `assets/${normalized}`;
  return undefined;
}

function stringValue(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(record: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

function booleanValue(record: JsonRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringArray(record: JsonRecord, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  }
  return [];
}

function numberArray(record: JsonRecord, ...keys: string[]): number[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
  }
  return [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 0))];
}

function physicalEntryKey(fileBase: string, minor: number): string {
  return `${fileBase}-${minor}`;
}

export function displayNodeKey(fileBase: string, record: JsonRecord, minor: number): string {
  const prefix = stringValue(record, "alternatePrefix") ?? fileBase;
  const suffix = stringValue(record, "alternateSuffix") ?? String(minor);
  return `${prefix}-${suffix}`;
}

function recordList(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (value && typeof value === "object") return Object.values(value).filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  return [];
}

function portableSourcePath(...parts: string[]): string {
  return normalizeSlash(path.posix.join(...parts.map(normalizeSlash)));
}

type StoryIndexLike = {
  source: ArcaeaStoryAtlasType["source"];
  sections: Array<{ act: number; label: string; pathIds: number[] }>;
  paths: Array<{ pathId: number; act: number; title: string; type: string; characters: number[]; nodes: string[] }>;
  nodeAnnotations: Array<{ nodeKey: string; relatedSongId?: string; relatedSongTitle?: string; storyType?: string }>;
};

function rawEntryObject(file: string): Promise<JsonRecord> {
  return readFile(file, "utf8").then((contents) => JSON.parse(contents) as JsonRecord);
}

function storyEntryFromRecord(fileBase: string, record: JsonRecord, pathByNode: Map<string, number>, sourcePath: string): EntryRecord | undefined {
  const minor = numberValue(record, "minor");
  if (minor === undefined) return undefined;
  const rawEntryKey = physicalEntryKey(fileBase, minor);
  const nodeKey = displayNodeKey(fileBase, record, minor);
  const pathId = pathByNode.get(nodeKey);
  if (pathId === undefined) return undefined;
  const type = stringValue(record, "storyType");
  const storyType = type === "vn" ? "vn" : "nvl";
  const result: EntryRecord = {
    rawEntryKey,
    nodeKey,
    pathId,
    storyType,
    characterIds: uniqueNumbers([
      ...numberArray(record, "characterIds", "characters", "charIds"),
      ...["clearCharaId", "charIcon1", "charIcon2"].map((key) => numberValue(record, key) ?? -1),
    ]),
    storyCgPaths: stringArray(record, "storyCgPath", "storyCgPaths").map((item) => normalizeStoryAssetPath(item)).filter((item): item is string => Boolean(item)),
    additionalRequires: stringArray(record, "additionalRequires"),
    sourcePath,
  };
  const storyData = stringValue(record, "storyData");
  const clearSongId = stringValue(record, "clearSongId");
  const playableSongBgmId = stringValue(record, "playableSongBgmId");
  const bgmOverride = stringValue(record, "bgmOverride");
  const requiredPurchase = stringValue(record, "requiredPurchase");
  const requiredPurchaseAlternate = stringValue(record, "requiredPurchaseAlternate");
  const requiredMinor = numberValue(record, "requiredMinor");
  const requirementAnomalyId = stringValue(record, "requirementAnomalyId");
  const unlockedSongId = stringValue(record, "unlockedSongId");
  const mapId = stringValue(record, "mapId");
  const hasAlternative = booleanValue(record, "hasAlternative");
  const blockReadingUntilPrevRead = booleanValue(record, "blockReadingUntilPrevRead");
  const hiddenFromCount = booleanValue(record, "hiddenFromCount");
  if (storyData) result.storyData = storyData;
  if (clearSongId) result.clearSongId = clearSongId;
  if (playableSongBgmId) result.playableSongBgmId = playableSongBgmId;
  if (bgmOverride) result.bgmOverride = bgmOverride;
  if (requiredPurchase) result.requiredPurchase = requiredPurchase;
  if (requiredPurchaseAlternate) result.requiredPurchaseAlternate = requiredPurchaseAlternate;
  if (requiredMinor !== undefined) result.requiredMinor = requiredMinor;
  if (requirementAnomalyId) result.requirementAnomalyId = requirementAnomalyId;
  if (unlockedSongId) result.unlockedSongId = unlockedSongId;
  if (mapId) result.mapId = mapId;
  if (hasAlternative !== undefined) result.hasAlternative = hasAlternative;
  if (blockReadingUntilPrevRead !== undefined) result.blockReadingUntilPrevRead = blockReadingUntilPrevRead;
  if (hiddenFromCount !== undefined) result.hiddenFromCount = hiddenFromCount;
  return result;
}

async function readStoryEntries(packageRoot: string, index: StoryIndexLike): Promise<EntryRecord[]> {
  const pathByNode = new Map<string, number>();
  for (const storyPath of index.paths) for (const nodeKey of storyPath.nodes) pathByNode.set(nodeKey, storyPath.pathId);
  const entries: EntryRecord[] = [];
  for (const side of ["main", "side"] as const) {
    const directory = path.join(packageRoot, "assets", "app-data", "story", side);
    const files = (await readdir(directory)).filter((file) => /^entries_\d+$/.test(file)).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    for (const file of files) {
      const fileBase = file.slice("entries_".length);
      const sourcePath = portableSourcePath("assets", "app-data", "story", side, file);
      const json = await rawEntryObject(path.join(directory, file));
      for (const record of recordList(json.entries)) {
        const entry = storyEntryFromRecord(fileBase, record, pathByNode, sourcePath);
        if (entry) entries.push(entry);
      }
    }
  }
  const seen = new Set<string>();
  const ordered: EntryRecord[] = [];
  for (const storyPath of index.paths) {
    for (const nodeKey of storyPath.nodes) {
      const entry = entries.find((candidate) => candidate.nodeKey === nodeKey);
      if (!entry || seen.has(entry.nodeKey)) continue;
      ordered.push(entry);
      seen.add(entry.nodeKey);
    }
  }
  if (ordered.length !== entries.length) throw new Error(`Story Entry ordering lost ${entries.length - ordered.length} package records.`);
  return ordered;
}

function localeMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string" && item.length > 0).map(([locale, item]) => [locale, item as string]));
}

async function readLocalizedStory(packageRoot: string, side: "main" | "side"): Promise<Record<string, Record<string, string>>> {
  const source = portableSourcePath("assets", "app-data", "story", side, "vn");
  const json = await rawEntryObject(path.join(packageRoot, ...source.split("/")));
  return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, localeMap(value)]));
}

export function parseStoryTextBlocks(rawText: string): ArcaeaStoryTextBlockType[] {
  return rawText.split("|").map((rawBlock, page) => rawBlock.trim()).filter(Boolean).map((rawBlock, page) => {
    const cg = rawBlock.match(/%%CG:([^%]+)%%/u);
    if (cg?.[1]) {
      const assetPath = normalizeStoryAssetPath(cg[1]);
      return {
        kind: "display-event" as const,
        page,
        event: "cg" as const,
        ...(assetPath ? { assetPath } : {}),
        ...(rawBlock.replace(cg[0], "").trim() ? { text: rawBlock.replace(cg[0], "").trim() } : {}),
      };
    }
    return { kind: "paragraph" as const, page, text: rawBlock };
  });
}

function decodeVnsText(value: string): string {
  return value.replaceAll("\\\"", '"').replaceAll("\\\\", "\\").trim();
}

function vnsAssetPath(value: string): string | undefined {
  return normalizeStoryAssetPath(value);
}

export function parseVnsScript(contents: string, sourcePath: string, scriptStem: string, locale: string): ParsedVns {
  const sayBlocks: Array<{ page: number; text: string }> = [];
  const sayPattern = /^\s*say\s+"((?:\\.|[^"\\])*)"/gms;
  let sayMatch: RegExpExecArray | null;
  while ((sayMatch = sayPattern.exec(contents)) !== null) {
    const text = decodeVnsText(sayMatch[1] ?? "");
    if (text) sayBlocks.push({ page: sayBlocks.length, text });
  }

  const commandCounts: Record<string, number> = {};
  const visuals = new Map<string, Set<string>>();
  const audio = new Map<string, Set<string>>();
  const commandPattern = /^\s*([A-Za-z][A-Za-z0-9_]*)\s+"([^"]+)"[^\r\n]*$/gm;
  let commandMatch: RegExpExecArray | null;
  while ((commandMatch = commandPattern.exec(contents)) !== null) {
    const command = commandMatch[1]?.toLowerCase();
    const rawAsset = commandMatch[2];
    if (!command || !rawAsset || command === "say") continue;
    commandCounts[command] = (commandCounts[command] ?? 0) + 1;
    const assetPath = vnsAssetPath(rawAsset);
    if (!assetPath) continue;
    const target = ["show", "hide", "move", "scale"].includes(command) ? visuals : ["play", "stop", "volume"].includes(command) ? audio : undefined;
    if (!target) continue;
    const commands = target.get(assetPath) ?? new Set<string>();
    commands.add(command);
    target.set(assetPath, commands);
  }
  const toAssets = (map: Map<string, Set<string>>) => [...map.entries()].map(([assetPath, commands]) => ({ assetPath, commands: [...commands].sort() })).sort((left, right) => left.assetPath.localeCompare(right.assetPath));
  return {
    scriptStem,
    locale,
    sourcePath,
    sayBlocks,
    commandCounts,
    visualReferences: toAssets(visuals),
    audioReferences: toAssets(audio),
  };
}

async function readVnsScripts(packageRoot: string): Promise<ParsedVns[]> {
  const directory = path.join(packageRoot, "assets", "app-data", "story", "vn");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".vns")).sort();
  const parsed: ParsedVns[] = [];
  for (const file of files) {
    const match = file.match(/^(.+?)_(en|ja|ko|zh-Hans|zh-Hant)\.vns$/u);
    if (!match?.[1] || !match[2]) continue;
    const sourcePath = portableSourcePath("assets", "app-data", "story", "vn", file);
    parsed.push(parseVnsScript(await readFile(path.join(directory, file), "utf8"), sourcePath, match[1], match[2]));
  }
  return parsed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function mappedResourceId(catalog: Catalog | undefined, assetPath: string): string | undefined {
  if (!catalog) return undefined;
  const relative = assetPath.replace(/^assets\//, "");
  const resource = catalog.resources.find((candidate) => {
    if (candidate.game !== "arcaea" || candidate.lifecycle.status !== "published") return false;
    if (candidate.metadata.sourceRelativePath === relative) return true;
    return candidate.provenance.some((item) => item.sourceRelativePath.endsWith(`/${relative}`));
  });
  return resource?.id;
}

function sourceForEntry(entry: EntryRecord): string {
  return entry.storyType === "vn" ? entry.sourcePath : portableSourcePath(...entry.sourcePath.split("/").slice(0, -1), "vn");
}

async function buildTextProjection(packageRoot: string, index: StoryIndexLike, entries: EntryRecord[], vns: ParsedVns[]): Promise<ReturnType<typeof ArcaeaStoryTextProjection.parse>> {
  const mainText = await readLocalizedStory(packageRoot, "main");
  const sideText = await readLocalizedStory(packageRoot, "side");
  const scriptsByStem = new Map<string, Map<string, ParsedVns>>();
  for (const script of vns) {
    const byLocale = scriptsByStem.get(script.scriptStem) ?? new Map<string, ParsedVns>();
    byLocale.set(script.locale, script);
    scriptsByStem.set(script.scriptStem, byLocale);
  }
  const projected = entries.map((entry) => {
    const texts: Record<string, {
      locale: string;
      sourcePath: string;
      rawEntryKey: string;
      entryKey: string;
      parserVersion: string;
      blocks: ArcaeaStoryTextBlockType[];
      storyData?: string;
    }> = {};
    const rawLocales = entry.storyType === "nvl"
      ? (entry.sourcePath.includes("/main/") ? mainText : sideText)[entry.rawEntryKey] ?? {}
      : {};
    for (const [locale, rawText] of Object.entries(rawLocales)) {
      texts[locale] = {
        locale,
        sourcePath: sourceForEntry(entry),
        rawEntryKey: entry.rawEntryKey,
        entryKey: entry.nodeKey,
        parserVersion: STORY_PARSER_VERSION,
        blocks: parseStoryTextBlocks(rawText),
      };
    }
    if (entry.storyType === "vn" && entry.storyData) {
      const scripts = scriptsByStem.get(entry.storyData) ?? new Map<string, ParsedVns>();
      for (const [locale, script] of scripts) {
        texts[locale] = {
          locale,
          sourcePath: script.sourcePath,
          rawEntryKey: entry.rawEntryKey,
          entryKey: entry.nodeKey,
          storyData: entry.storyData,
          parserVersion: STORY_PARSER_VERSION,
          blocks: script.sayBlocks.map((block) => ({ kind: "paragraph" as const, page: block.page, text: block.text })),
        };
      }
    }
    const displayCg = Object.values(texts).flatMap((text) => text.blocks.flatMap((block) => block.assetPath ? [block.assetPath] : []));
    const storyCgPaths = uniqueStrings([...entry.storyCgPaths, ...displayCg]);
    return {
      nodeKey: entry.nodeKey,
      pathId: entry.pathId,
      rawEntryKey: entry.rawEntryKey,
      sourcePath: entry.sourcePath,
      storyType: entry.storyType,
      ...(entry.storyData ? { storyData: entry.storyData } : {}),
      characterIds: entry.characterIds,
      ...(entry.clearSongId ? { clearSongId: entry.clearSongId } : {}),
      ...(entry.playableSongBgmId ? { playableSongBgmId: entry.playableSongBgmId } : {}),
      ...(entry.bgmOverride ? { bgmOverride: entry.bgmOverride } : {}),
      ...(entry.requiredPurchase ? { requiredPurchase: entry.requiredPurchase } : {}),
      ...(entry.requiredPurchaseAlternate ? { requiredPurchaseAlternate: entry.requiredPurchaseAlternate } : {}),
      ...(entry.requiredMinor !== undefined ? { requiredMinor: entry.requiredMinor } : {}),
      additionalRequires: entry.additionalRequires,
      ...(entry.requirementAnomalyId ? { requirementAnomalyId: entry.requirementAnomalyId } : {}),
      ...(entry.unlockedSongId ? { unlockedSongId: entry.unlockedSongId } : {}),
      ...(entry.mapId ? { mapId: entry.mapId } : {}),
      ...(entry.hasAlternative !== undefined ? { hasAlternative: entry.hasAlternative } : {}),
      ...(entry.blockReadingUntilPrevRead !== undefined ? { blockReadingUntilPrevRead: entry.blockReadingUntilPrevRead } : {}),
      ...(entry.hiddenFromCount !== undefined ? { hiddenFromCount: entry.hiddenFromCount } : {}),
      storyCgPaths,
      texts,
    };
  });
  const localeCounts = Object.fromEntries(STORY_LOCALES.map((locale) => [locale, projected.filter((entry) => Boolean(entry.texts[locale])).length]));
  return ArcaeaStoryTextProjection.parse({
    schemaVersion: 1,
    game: "arcaea",
    source: index.source,
    parserVersion: STORY_PARSER_VERSION,
    entries: projected,
    coverage: {
      entryCount: projected.length,
      entriesWithText: projected.filter((entry) => Object.keys(entry.texts).length > 0).length,
      localeCounts,
    },
  });
}

function sceneLocale(script: ParsedVns): ArcaeaStorySceneType["locales"][string] {
  return {
    locale: script.locale,
    sourcePath: script.sourcePath,
    sayCount: script.sayBlocks.length,
    commandCounts: script.commandCounts,
    visualReferences: script.visualReferences,
    audioReferences: script.audioReferences,
  };
}

function sceneResourceIds(scripts: ParsedVns[], catalog: Catalog | undefined): string[] {
  return uniqueStrings(scripts.flatMap((script) => script.visualReferences.map((reference) => reference.assetPath))).map((assetPath) => mappedResourceId(catalog, assetPath)).filter((value): value is string => Boolean(value));
}

function nodeForStoryData(entries: EntryRecord[], storyData: string): EntryRecord | undefined {
  return entries.find((entry) => entry.storyData === storyData);
}

function buildStoryScenes(index: StoryIndexLike, entries: EntryRecord[], vns: ParsedVns[], catalog: Catalog | undefined): ReturnType<typeof ArcaeaStoryScene.parse>[] {
  const byStem = new Map<string, ParsedVns[]>();
  for (const script of vns) byStem.set(script.scriptStem, [...(byStem.get(script.scriptStem) ?? []), script]);
  const scenes: ReturnType<typeof ArcaeaStoryScene.parse>[] = [];
  for (const [scriptStem, scripts] of byStem) {
    const entry = nodeForStoryData(entries, scriptStem);
    const pathId = entry?.pathId ?? (scriptStem === "epilogue_last" ? 19 : undefined);
    const sceneId = `vn:${scriptStem}`;
    const scene: JsonRecord = {
      sceneId,
      kind: scriptStem === "epilogue_last" ? "epilogue" : "vn-scene",
      displayTitle: entry ? `${entry.nodeKey} · ${scriptStem}` : scriptStem,
      ...(pathId !== undefined ? { pathId } : {}),
      ...(entry && scriptStem !== "epilogue_last" ? { nodeKey: entry.nodeKey } : {}),
      ...(entry?.storyData ? { storyData: entry.storyData } : {}),
      scriptStem,
      resourceIds: sceneResourceIds(scripts, catalog),
      locales: Object.fromEntries(scripts.map((script) => [script.locale, sceneLocale(script)])),
    };
    scenes.push(ArcaeaStoryScene.parse(scene));
  }
  const divine = index as StoryIndexLike & { storyTextureCg?: Array<{ assetPath: string; pathId?: number }> };
  const divineAssets = divine.storyTextureCg ?? [];
  if (divineAssets.length > 0) {
    scenes.push(ArcaeaStoryScene.parse({
      sceneId: "path:33:divine-oblivion-vn",
      kind: "path-scene",
      displayTitle: "Divine Oblivion · VN scene",
      pathId: 33,
      resourceIds: divineAssets.map((asset) => mappedResourceId(catalog, asset.assetPath)).filter((value): value is string => Boolean(value)),
      locales: {},
    }));
  }
  return scenes;
}

type EvidenceBuilder = {
  evidence: JsonRecord[];
  nodeKeys: Set<string>;
  textNodes: Set<string>;
  pathIds: Set<number>;
  sceneIds: Set<string>;
  directNodes: Set<string>;
};

function addEvidence(map: Map<string, EvidenceBuilder>, assetPath: string, item: JsonRecord, entry?: EntryRecord, sceneId?: string, direct = false): void {
  const current = map.get(assetPath) ?? { evidence: [], nodeKeys: new Set<string>(), textNodes: new Set<string>(), pathIds: new Set<number>(), sceneIds: new Set<string>(), directNodes: new Set<string>() };
  const key = JSON.stringify(item);
  if (!current.evidence.some((candidate) => JSON.stringify(candidate) === key)) current.evidence.push(item);
  if (entry) {
    current.nodeKeys.add(entry.nodeKey);
    if (direct || item.kind === "localized-text-display-event") current.textNodes.add(entry.nodeKey);
    current.pathIds.add(entry.pathId);
    if (direct) current.directNodes.add(entry.nodeKey);
  }
  if (sceneId) current.sceneIds.add(sceneId);
  map.set(assetPath, current);
}

function relationAssetPath(filename: string): string {
  return portableSourcePath("assets", "app-data", "story", "cg", filename);
}

async function imageResolution(packageRoot: string, assetPath: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const info = await sharp(path.join(packageRoot, ...assetPath.split("/"))).metadata();
    return info.width && info.height ? { width: info.width, height: info.height } : undefined;
  } catch {
    return undefined;
  }
}

async function buildRelationEvidence(packageRoot: string, index: StoryIndexLike, text: Awaited<ReturnType<typeof buildTextProjection>>, entries: EntryRecord[], vns: ParsedVns[], catalog: Catalog | undefined): Promise<ReturnType<typeof ArcaeaStoryRelationEvidence.parse>[]> {
  const byAsset = new Map<string, EvidenceBuilder>();
  for (const entry of entries) {
    for (const assetPath of entry.storyCgPaths) addEvidence(byAsset, assetPath, {
      kind: "entry-storyCgPath",
      sourcePath: entry.sourcePath,
      recordKey: entry.rawEntryKey,
      referencedAsset: assetPath,
      explanation: `Entry ${entry.nodeKey} contains the exact storyCgPath field.`,
    }, entry, undefined, true);
  }
  for (const textEntry of text.entries) {
    for (const locale of Object.values(textEntry.texts)) {
      for (const block of locale.blocks) {
        if (!block.assetPath) continue;
        addEvidence(byAsset, block.assetPath, {
          kind: "localized-text-display-event",
          sourcePath: locale.sourcePath,
          recordKey: locale.rawEntryKey,
          referencedAsset: block.assetPath,
          explanation: `Locale ${locale.locale} display data for Entry ${textEntry.nodeKey} contains an exact CG display event.`,
        }, entries.find((entry) => entry.nodeKey === textEntry.nodeKey));
      }
    }
  }
  for (const script of vns) {
    const entry = nodeForStoryData(entries, script.scriptStem);
    for (const reference of script.visualReferences) {
      for (const command of reference.commands) addEvidence(byAsset, reference.assetPath, {
        kind: "vn-script-visual",
        sourcePath: script.sourcePath,
        scriptName: script.scriptStem,
        scriptCommand: command,
        referencedAsset: reference.assetPath,
        explanation: `VN script ${script.scriptStem} uses the exact visual resource in a ${command} command.`,
      }, entry, `vn:${script.scriptStem}`);
    }
    if (entry) {
      for (const reference of script.visualReferences) addEvidence(byAsset, reference.assetPath, {
        kind: "storyData-mapping",
        sourcePath: entry.sourcePath,
        recordKey: entry.rawEntryKey,
        referencedAsset: reference.assetPath,
        explanation: `Entry ${entry.nodeKey} storyData=${entry.storyData} selects VN script ${script.scriptStem}.`,
      }, entry, `vn:${script.scriptStem}`);
    }
  }
  const orderingPath = index.source.orderingPath;
  for (const [assetPath, current] of byAsset) {
    if (current.pathIds.size === 1) {
      const pathId = [...current.pathIds][0];
      addEvidence(byAsset, assetPath, {
        kind: "ordering",
        sourcePath: orderingPath,
        recordKey: `path:${pathId}`,
        explanation: `The exact referenced Entry occurs in Story ordering path ${pathId}.`,
      });
    }
  }
  const epilogueAssets = new Set([relationAssetPath("E-1_epilogue.jpg"), relationAssetPath("E-4_epilogue.jpg")]);
  const entriesByNode = new Map(entries.map((entry) => [entry.nodeKey, entry]));
  const results: ReturnType<typeof ArcaeaStoryRelationEvidence.parse>[] = [];
  for (const filename of CANDIDATE_ASSETS) {
    const assetPath = relationAssetPath(filename);
    const current = byAsset.get(assetPath) ?? { evidence: [], nodeKeys: new Set<string>(), textNodes: new Set<string>(), pathIds: new Set<number>(), sceneIds: new Set<string>(), directNodes: new Set<string>() };
    let finalRelation: "node" | "path-scene" | "vn-scene" | "unresolved" = "unresolved";
    let finalNodeKey: string | undefined;
    let finalPathId: number | undefined;
    let finalSceneId: string | undefined;
    if (epilogueAssets.has(assetPath)) {
      finalRelation = "path-scene";
      finalPathId = 19;
      finalSceneId = "vn:epilogue_last";
      current.sceneIds.add(finalSceneId);
      current.pathIds.add(finalPathId);
      current.evidence.push({
        kind: "storyData-mapping",
        sourcePath: portableSourcePath("assets", "app-data", "story", "main", "entries_103"),
        recordKey: "103-1",
        referencedAsset: assetPath,
        explanation: "The epilogue asset is selected by a path-level epilogue VN scene; no exact single Entry storyCgPath proves a node binding.",
      });
    } else if (filename.startsWith("F-7")) {
      const f7 = entriesByNode.get("F-7");
      if (f7 && current.textNodes.has("F-7")) {
        finalRelation = "node";
        finalNodeKey = "F-7";
        finalPathId = f7.pathId;
      }
    } else if (current.directNodes.size === 1) {
      finalRelation = "node";
      finalNodeKey = [...current.directNodes][0];
      finalPathId = finalNodeKey ? entriesByNode.get(finalNodeKey)?.pathId : undefined;
    } else if (current.textNodes.size === 1) {
      finalRelation = "node";
      finalNodeKey = [...current.textNodes][0];
      finalPathId = finalNodeKey ? entriesByNode.get(finalNodeKey)?.pathId : undefined;
    } else if (current.sceneIds.size === 1) {
      finalRelation = "vn-scene";
      finalSceneId = [...current.sceneIds][0];
    }
    const resolution = await imageResolution(packageRoot, assetPath);
    const evidence = current.evidence.length > 0 ? current.evidence : [{
      kind: "ordering",
      sourcePath: orderingPath,
      explanation: "Package-wide relation scan found no direct Entry, localized display-event, or VN-script reference.",
    }];
    results.push(ArcaeaStoryRelationEvidence.parse({
      assetPath,
      ...(mappedResourceId(catalog, assetPath) ? { resourceId: mappedResourceId(catalog, assetPath) } : {}),
      ...(resolution ? { resolution } : {}),
      ...(current.textNodes.size === 1 ? { candidateNodeKey: [...current.textNodes][0] } : {}),
      ...(current.pathIds.size === 1 ? { candidatePathId: [...current.pathIds][0] } : {}),
      ...(current.sceneIds.size === 1 ? { candidateSceneId: [...current.sceneIds][0] } : {}),
      evidence,
      confidence: finalRelation === "node" ? "high" : finalRelation === "path-scene" || finalRelation === "vn-scene" ? "medium" : "unresolved",
      finalRelation,
      ...(finalNodeKey ? { finalNodeKey } : {}),
      ...(finalPathId !== undefined ? { finalPathId } : {}),
      ...(finalSceneId ? { finalSceneId } : {}),
    }));
  }
  return results;
}

async function loadCatalog(filePath: string | undefined): Promise<Catalog | undefined> {
  if (!filePath) return undefined;
  const parsed = validateCatalog(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  if (!parsed.success) throw new Error(`Catalog validation failed: ${parsed.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
  return parsed.data;
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function buildArcaeaStoryAudit(options: {
  packageRoot: string;
  indexPath: string;
  outputDir: string;
  catalogPath?: string;
}): Promise<ArcaeaStoryAtlasType> {
  const index = JSON.parse(await readFile(options.indexPath, "utf8")) as StoryIndexLike;
  const catalog = await loadCatalog(options.catalogPath);
  const entries = await readStoryEntries(options.packageRoot, index);
  const vns = await readVnsScripts(options.packageRoot);
  const text = await buildTextProjection(options.packageRoot, index, entries, vns);
  const scenes = buildStoryScenes(index, entries, vns, catalog);
  const relationEvidence = await buildRelationEvidence(options.packageRoot, index, text, entries, vns, catalog);
  const atlas = ArcaeaStoryAtlas.parse({
    schemaVersion: ARCAEA_STORY_ATLAS_SCHEMA_VERSION,
    source: index.source,
    text,
    scenes,
    relationEvidence,
    searchIndex: [],
  });
  await mkdir(options.outputDir, { recursive: true });
  await writeJson(path.join(options.outputDir, "arcaea-story-text.json"), text);
  await writeJson(path.join(options.outputDir, "arcaea-story-scenes.json"), scenes);
  await writeJson(path.join(options.outputDir, "arcaea-story-cg-relation-evidence.json"), relationEvidence);
  return atlas;
}

async function main(): Promise<void> {
  const packageRoot = argument("--package-root");
  const indexPath = argument("--index", "docs/apk-audit/data/arcaea-story-index.json");
  const outputDir = argument("--output", "docs/apk-audit/data");
  const catalogPath = argument("--catalog", "catalog/index.json");
  if (!packageRoot || !indexPath || !outputDir) throw new Error("Usage: arcaea-story-audit --package-root <extracted-package> [--index <story-index>] [--output <audit-dir>] [--catalog <catalog>]");
  const atlas = await buildArcaeaStoryAudit({ packageRoot, indexPath, outputDir, ...(catalogPath ? { catalogPath } : {}) });
  const relationCounts = Object.fromEntries(["node", "path-scene", "vn-scene", "unresolved"].map((kind) => [kind, atlas.relationEvidence.filter((item) => item.finalRelation === kind).length]));
  console.log(JSON.stringify({ entries: atlas.text.coverage, scenes: atlas.scenes.length, locales: Object.keys(atlas.text.entries[0]?.texts ?? {}), relationCounts }, null, 2));
}

if (process.argv[1]?.endsWith("arcaea-story-audit.ts")) await main();
