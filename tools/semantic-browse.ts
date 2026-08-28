import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ArcaeaBrowseProjection,
  CategoryBrowseProjection,
  PhigrosCategoryBrowseProjection,
  loadCatalogFile,
  type CategoryBrowseProjectionType,
} from "../packages/domain/src/index.js";
import type { Catalog, Resource } from "../packages/domain/src/schema.js";

type CsvRow = Record<string, string | undefined>;
type SemanticPrimitive = string | number | boolean;
type ArcaeaStoryPath = {
  pathId: number;
  act: number;
  title: string;
  type: string;
  nodes: string[];
};
type ArcaeaStoryNodeAnnotation = {
  nodeKey: string;
  visual: "animation" | "illustration";
  unlockKind: "pack" | "song";
  relatedPackId?: string;
  relatedPackTitle?: string;
  relatedSongId?: string;
  staffRoll?: boolean;
};
type ArcaeaStoryCgIndexEntry = {
  assetPath: string;
  nodeKey: string;
  imageOrder: number;
  imageCount: number;
};
type ArcaeaStoryIndex = {
  schemaVersion: number;
  game: "arcaea";
  source: {
    packageVersion: string;
    packageSha256: string;
    orderingPath: string;
    verifiedAt: string;
    wikiSources: Array<{ url: string; usedFor: string }>;
  };
  sections: Array<{ act: number; label: string; pathIds: number[] }>;
  paths: ArcaeaStoryPath[];
  nodeAnnotations: ArcaeaStoryNodeAnnotation[];
  coverage: { physicalStoryCgCount: number; baselineRelationCount: number; curatedStoryCgCount: number };
  storyCg: ArcaeaStoryCgIndexEntry[];
};
type SemanticPatch = {
  displayTitle?: string;
  subtitle?: string;
  metadata?: Record<string, SemanticPrimitive>;
  badges?: string[];
  searchTerms?: string[];
  sortOrder?: number;
  facets?: Record<string, string[]>;
};
type SemanticDraft = {
  resourceId: string;
  resourceType: string;
  displayTitle?: string;
  subtitle?: string;
  metadata: Map<string, SemanticPrimitive>;
  badges: Set<string>;
  searchTerms: Set<string>;
  sortOrder?: number;
  facets: Map<string, Set<string>>;
};

const trackedInputs = new Map<string, string>();

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
  const header = (rows.shift() ?? []).map((key, index) => index === 0 ? key.replace(/^\uFEFF/u, "") : key);
  return rows
    .filter((cells) => cells.some((value) => value.length > 0))
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])));
}

async function trackedText(auditDirectory: string, filename: string): Promise<string> {
  const text = await readFile(path.join(auditDirectory, filename), "utf8");
  trackedInputs.set(filename, text);
  return text;
}

async function trackedCsv(auditDirectory: string, filename: string): Promise<CsvRow[]> {
  return parseCsv(await trackedText(auditDirectory, filename));
}

async function trackedJson<T>(auditDirectory: string, filename: string): Promise<T> {
  return JSON.parse(await trackedText(auditDirectory, filename)) as T;
}

async function json<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/gu, " ").trim();
}

function parseJsonStrings(value: string | undefined): string[] {
  const normalized = nonEmpty(value);
  if (!normalized) return [];
  try {
    const parsed: unknown = JSON.parse(normalized);
    return flattenStrings(parsed);
  } catch {
    return [];
  }
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenStrings);
  return [];
}

function parseLocalizedValues(value: string | undefined): string[] {
  const normalized = nonEmpty(value);
  if (!normalized) return [];
  return normalized.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 ? [part.slice(separator + 1).trim()] : [part.trim()];
  }).filter(Boolean);
}

function parseLocalizedMap(value: string | undefined): Map<string, string> {
  const normalized = nonEmpty(value);
  if (!normalized) return new Map();
  return new Map(normalized.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const result = part.slice(separator + 1).trim();
    return key && result ? [[key, result] as const] : [];
  }));
}

function integer(value: string | undefined): number | undefined {
  const parsed = Number(nonEmpty(value));
  return Number.isInteger(parsed) ? parsed : undefined;
}

function cleanIdentifier(value: string): string {
  return value
    .replace(/\.(?:png|jpg|jpeg|webp)$/iu, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

type CharacterNames = { zhHans?: string; ja?: string; en?: string; ko?: string };

function characterNames(characterName: string | undefined, searchStrings: string[]): CharacterNames {
  const candidates = unique(searchStrings);
  const hanOnly = candidates.filter((value) => /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value) && !/[\u3040-\u30ff\uac00-\ud7af]/u.test(value));
  const firstHan = hanOnly[0];
  const firstHanIndex = firstHan ? candidates.indexOf(firstHan) : -1;
  const zhHans = firstHanIndex === 0 && hanOnly.length > 1 ? hanOnly[1] : firstHan;
  const ja = candidates.find((value) => /[\u3040-\u30ff]/u.test(value)) ?? firstHan;
  const ko = candidates.find((value) => /[\uac00-\ud7af]/u.test(value));
  return {
    ...(zhHans ? { zhHans } : {}),
    ...(ja ? { ja } : {}),
    ...(characterName ? { en: characterName } : {}),
    ...(ko ? { ko } : {}),
  };
}

function localizedCharacterName(characterName: string | undefined, searchStrings: string[]): string | undefined {
  const candidates = unique([...searchStrings, ...(characterName ? [characterName] : [])]);
  const names = characterNames(characterName, searchStrings);
  return names.zhHans ?? names.ja ?? names.ko ?? names.en ?? candidates[0];
}

function storyTypeLabel(value: string | undefined): string {
  const normalized = normalizeSearch(value ?? "");
  if (normalized === "main") return "Main Story";
  if (normalized === "side") return "Side Story";
  if (normalized === "archive") return "Archive Story";
  if (normalized === "single") return "Single Story";
  if (normalized === "collaboration" || normalized === "collab") return "Collaboration";
  return "Story";
}

function storyLocator(row: CsvRow, nodeKey = nonEmpty(row.nodeKey)): string | undefined {
  if (nodeKey) return `Entry ${nodeKey}`;
  const chapter = nonEmpty(row.chapter);
  const entry = nonEmpty(row.entry);
  if (chapter && entry) return `Chapter ${chapter} · Entry ${entry}`;
  if (entry) return `Entry ${entry}`;
  return undefined;
}

function storySortOrder(row: CsvRow, fallback: number, pathId?: number, nodeOrder?: number, imageOrder?: number, unresolved = false): number {
  if (pathId !== undefined) return pathId * 100_000 + (nodeOrder ?? 99_999) * 100 + (imageOrder ?? 0);
  if (unresolved) return 2_000_000_000 + fallback;
  const act = integer(row.act);
  const chapter = integer(row.chapter);
  const entry = integer(row.entry);
  const order = integer(row.order);
  if (act !== undefined || chapter !== undefined || entry !== undefined || order !== undefined) {
    return 1_000_000_000 + (act ?? 999) * 1_000_000 + (chapter ?? 999) * 1_000 + (entry ?? 999) * 10 + (order ?? 999);
  }
  return 2_000_000_000 + fallback;
}

function localeLabel(value: string | undefined): string | undefined {
  const normalized = normalizeSearch(value ?? "");
  if (normalized === "en") return "EN";
  if (normalized === "jp" || normalized === "ja") return "JA";
  if (normalized === "kr" || normalized === "ko") return "KO";
  if (normalized === "sc") return "简中";
  if (normalized === "tc") return "繁中";
  if (normalized === "sc_tc") return "简中/繁中";
  return normalized ? normalized.toUpperCase() : "默认";
}

function apkVersion(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const record = value as { manifest?: { attributes?: { versionName?: unknown } } };
  return typeof record.manifest?.attributes?.versionName === "string" ? record.manifest.attributes.versionName : "unknown";
}

function sourceDigest(excludedFilenames: ReadonlySet<string> = new Set()): string {
  const hash = createHash("sha256");
  for (const [filename, text] of [...trackedInputs.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (excludedFilenames.has(filename)) continue;
    hash.update(filename).update("\0").update(text);
  }
  return hash.digest("hex");
}

function createPathIndex(catalog: Catalog): Map<string, Resource[]> {
  const index = new Map<string, Resource[]>();
  for (const resource of catalog.resources.filter((candidate) => candidate.lifecycle.status === "published")) {
    for (const provenance of resource.provenance) {
      const key = normalizePath(provenance.sourceRelativePath);
      index.set(key, [...(index.get(key) ?? []), resource]);
    }
  }
  return index;
}

function findResource(index: Map<string, Resource[]>, game: "arcaea" | "phigros", assetPath: string): Resource | undefined {
  const asset = normalizePath(assetPath).replace(/^assets\//u, "");
  const prefix = game === "arcaea" ? "Arcaea/current-apk/" : "Phigros/current-apk/";
  return index.get(`${prefix}${asset}`)?.find((resource) => resource.game === game);
}

function addDraft(drafts: Map<string, SemanticDraft>, resource: Resource | undefined, patch: SemanticPatch): void {
  if (!resource) return;
  const current = drafts.get(resource.id) ?? {
    resourceId: resource.id,
    resourceType: resource.resourceType,
    badges: new Set<string>(),
    searchTerms: new Set<string>(),
    facets: new Map<string, Set<string>>(),
    metadata: new Map<string, SemanticPrimitive>(),
  };
  if (patch.displayTitle && !current.displayTitle) current.displayTitle = patch.displayTitle;
  if (patch.subtitle && !current.subtitle) current.subtitle = patch.subtitle;
  for (const [key, value] of Object.entries(patch.metadata ?? {})) if (!current.metadata.has(key)) current.metadata.set(key, value);
  for (const badge of patch.badges ?? []) current.badges.add(badge);
  for (const term of patch.searchTerms ?? []) if (term.trim()) current.searchTerms.add(term.trim());
  for (const [key, values] of Object.entries(patch.facets ?? {})) {
    const facet = current.facets.get(key) ?? new Set<string>();
    for (const value of values) if (value.trim()) facet.add(value.trim());
    current.facets.set(key, facet);
  }
  if (patch.sortOrder !== undefined && (current.sortOrder === undefined || patch.sortOrder < current.sortOrder)) current.sortOrder = patch.sortOrder;
  drafts.set(resource.id, current);
}

function characterMaps(rows: CsvRow[]): { byId: Map<string, { title?: string; aliases: string[]; names: CharacterNames }>; byName: Map<string, { title?: string; aliases: string[]; names: CharacterNames }>; mapped: Map<string, boolean> } {
  const byId = new Map<string, { title?: string; aliases: string[]; names: CharacterNames }>();
  const byName = new Map<string, { title?: string; aliases: string[]; names: CharacterNames }>();
  for (const row of rows) {
    const characterId = nonEmpty(row.characterId);
    if (!characterId) continue;
    const searchStrings = parseJsonStrings(row.searchStrings);
    const aliases = unique([nonEmpty(row.characterName) ?? "", ...searchStrings]);
    const names = characterNames(nonEmpty(row.characterName), searchStrings);
    const title = localizedCharacterName(nonEmpty(row.characterName), searchStrings);
    if (!byId.has(characterId) || (!byId.get(characterId)!.title && title)) byId.set(characterId, { ...(title ? { title } : {}), aliases, names });
    else {
      const current = byId.get(characterId)!;
      current.aliases = unique([...current.aliases, ...aliases]);
      current.names = { ...current.names, ...names };
      if (!current.title && title) current.title = title;
    }
    const current = byId.get(characterId)!;
    for (const alias of aliases) {
      const key = normalizeSearch(alias);
      if (key && !byName.has(key)) byName.set(key, current);
    }
  }
  return { byId, byName, mapped: new Map() };
}

function characterForAssetPath(byName: Map<string, { title?: string; aliases: string[]; names: CharacterNames }>, assetPath: string): { title?: string; aliases: string[]; names: CharacterNames } | undefined {
  const filename = normalizePath(assetPath).split("/").pop() ?? "";
  const stem = cleanIdentifier(filename);
  return [...byName.entries()]
    .sort((left, right) => right[0].length - left[0].length)
    .find(([key]) => stem === cleanIdentifier(key) || stem.startsWith(`${cleanIdentifier(key)} `))?.[1];
}

function inferPackId(assetPath: string): string | undefined {
  const filename = normalizePath(assetPath).split("/").pop() ?? "";
  return filename.match(/(?:divider|select|overlay|small)_([a-z0-9]+(?:_append_\d+)?)/iu)?.[1];
}

function localizedPackName(value: string | undefined): string | undefined {
  const map = parseLocalizedMap(value);
  return map.get("en") ?? parseLocalizedValues(value)[0];
}

function displayPackName(packId: string | undefined, sourceName: string | undefined, packById: Map<string, CsvRow>): string {
  const name = sourceName ?? localizedPackName(packId ? packById.get(packId)?.nameLocalized : undefined);
  if (!name) return packId ? `曲包界面素材 · ${cleanIdentifier(packId)}` : "曲包界面素材";
  const chapter = name.match(/^Collaboration Chapter (\d+)$/iu);
  if (!chapter) return name;
  const pack = packId ? packById.get(packId) : undefined;
  const parentId = nonEmpty(pack?.packParent) ?? packId?.replace(/_append_\d+$/iu, "");
  const parentName = localizedPackName(parentId ? packById.get(parentId)?.nameLocalized : undefined);
  return parentName ? `${parentName} · ${name}` : name;
}

function buildArcaeaSemantics(catalog: Catalog, arcaeaBrowse: ReturnType<typeof ArcaeaBrowseProjection.parse>, index: Map<string, Resource[]>, characterRows: CsvRow[], storyRows: CsvRow[], storyIndex: ArcaeaStoryIndex, storyReferenceRows: CsvRow[], backgroundRows: CsvRow[], packRows: CsvRow[], packRecordRows: CsvRow[], linkplayRows: CsvRow[]): { projection: CategoryBrowseProjectionType; metrics: Record<string, number> } {
  const drafts = new Map<string, SemanticDraft>();
  const characters = characterMaps(characterRows);
  const songById = new Map(arcaeaBrowse.songs.map((song) => [song.songId, song]));
  if (storyIndex.game !== "arcaea" || storyIndex.source.packageVersion !== arcaeaBrowse.source.version || storyIndex.source.packageSha256.toLowerCase() !== arcaeaBrowse.source.sha256.toLowerCase()) {
    throw new Error(`Arcaea story index is not aligned with ${arcaeaBrowse.source.version} (${arcaeaBrowse.source.sha256})`);
  }
  const storyPathById = new Map(storyIndex.paths.map((storyPath) => [storyPath.pathId, storyPath]));
  const storySectionByAct = new Map(storyIndex.sections.map((section) => [section.act, section.label]));
  const storyNodeByKey = new Map<string, { path: ArcaeaStoryPath; nodeOrder: number }>();
  for (const storyPath of storyIndex.paths) {
    storyPath.nodes.forEach((nodeKey, nodeOrder) => storyNodeByKey.set(nodeKey, { path: storyPath, nodeOrder }));
  }
  const storyNodeAnnotationByKey = new Map(storyIndex.nodeAnnotations.map((annotation) => [annotation.nodeKey, annotation]));
  const portraitResources = new Set(catalog.resources.filter((resource) => resource.game === "arcaea" && resource.resourceType === "character-portrait" && resource.lifecycle.status === "published").map((resource) => resource.id));
  const avatarResources = new Set(catalog.resources.filter((resource) => resource.game === "arcaea" && resource.resourceType === "character-avatar" && resource.lifecycle.status === "published").map((resource) => resource.id));
  const mappedPortrait = new Set<string>();
  const mappedAvatar = new Set<string>();
  const indexedStoryCgResources = new Set<string>();

  characterRows.forEach((row, rowIndex) => {
    const resource = findResource(index, "arcaea", row.assetPath ?? "");
    if (!resource || !["character-portrait", "character-avatar", "linkplay-preview"].includes(resource.resourceType)) return;
    const character = characters.byId.get(nonEmpty(row.characterId) ?? "") ?? characterForAssetPath(characters.byName, row.assetPath ?? "");
    const isNamed = Boolean(character?.title);
    const fallbackIdentifier = cleanIdentifier(resource.title ?? resource.provenance[0]?.sourceFilename ?? "");
    const fallbackTitle = resource.resourceType === "linkplay-preview" ? "LinkPlay 通用预览" : resource.resourceType === "character-avatar" ? `头像 · ${fallbackIdentifier || "角色资源"}` : `角色立绘 · ${fallbackIdentifier || "角色资源"}`;
    const title = character?.title ?? fallbackTitle;
    const names = character?.names;
    const variant = nonEmpty(row.variant);
    const variantRaw = nonEmpty(row.variantRaw);
    const variantLabel = variantRaw ?? variant;
    const isBase = !variant || ["base", "main", "icon"].includes(normalizeSearch(variant));
    const namedSubtitle = resource.resourceType === "linkplay-preview" && nonEmpty(row.versionFrom) === "7.0.0" ? "LinkPlay 预览" : isBase ? undefined : "变体";
    addDraft(drafts, resource, {
      displayTitle: title,
      ...(isNamed ? (namedSubtitle ? { subtitle: namedSubtitle } : {}) : { subtitle: "角色名称未在 characters.json 中找到", badges: ["待确认"] }),
      metadata: {
        ...(names?.zhHans ? { characterName: names.zhHans, characterChineseName: names.zhHans } : {}),
        ...(names?.ja ? { characterJapaneseName: names.ja } : {}),
        ...(names?.en ? { characterEnglishName: names.en } : {}),
        ...(names?.ko ? { characterKoreanName: names.ko } : {}),
        ...(variantLabel ? { characterVariant: variantLabel } : {}),
      },
      searchTerms: [...(character?.aliases ?? []), ...(variantRaw ? [variantRaw] : []), ...(variant ? [variant] : [])],
      sortOrder: (Number(nonEmpty(row.characterId)) >= 0 ? Number(nonEmpty(row.characterId)) : 9999) * 1000 + (isBase ? 0 : 1) * 100 + rowIndex,
      facets: character?.title ? { character: [character.title] } : {},
    });
    if (isNamed && portraitResources.has(resource.id)) mappedPortrait.add(resource.id);
    if (isNamed && avatarResources.has(resource.id)) mappedAvatar.add(resource.id);
  });

  linkplayRows.forEach((row, rowIndex) => {
    const resource = findResource(index, "arcaea", row.assetPath ?? "");
    if (!resource || resource.resourceType !== "sticker") return;
    const family = nonEmpty(row.resourceFamily) ?? "Sticker";
    const familyCharacter = [...characters.byId.values()].find((character) => character.aliases.some((alias) => normalizeSearch(alias) === normalizeSearch(family)));
    const title = familyCharacter?.title ?? cleanIdentifier(family);
    const locale = localeLabel(nonEmpty(row.normalizedLocale) ?? nonEmpty(row.localeSuffix));
    addDraft(drafts, resource, {
      displayTitle: title,
      subtitle: "LinkPlay 贴纸",
      badges: locale ? [locale] : [],
      searchTerms: [family, ...(familyCharacter?.aliases ?? []), nonEmpty(row.rawLocaleSuffix) ?? ""],
      sortOrder: rowIndex,
      facets: { ...(locale ? { locale: [locale] } : {}), family: [family] },
    });
  });

  storyRows.forEach((row, rowIndex) => {
    const resource = findResource(index, "arcaea", row.assetPath ?? "");
    if (!resource || resource.resourceType !== "story-cg") return;
    indexedStoryCgResources.add(resource.id);
    const nodeKey = nonEmpty(row.nodeKey);
    const nodeContext = nodeKey ? storyNodeByKey.get(nodeKey) : undefined;
    const rowPath = integer(row.pathId) !== undefined ? storyPathById.get(integer(row.pathId)!) : undefined;
    const storyPath = rowPath ?? nodeContext?.path;
    const pathId = storyPath?.pathId ?? integer(row.pathId);
    const nodeOrder = integer(row.order) ?? nodeContext?.nodeOrder;
    const typeLabel = storyTypeLabel(storyPath?.type ?? row.storyPath);
    const pathTitle = storyPath?.title ?? nonEmpty(row.pathTitle);
    const sectionLabel = storyPath ? storySectionByAct.get(storyPath.act) : undefined;
    const locator = storyLocator(row, nodeKey);
    const relatedSong = songById.get(nonEmpty(row.relatedSongId) ?? "");
    const relatedSongTitle = relatedSong?.displayTitle;
    const unresolved = nonEmpty(row.confidence)?.toLowerCase() === "unresolved" || nonEmpty(row.resourceRole)?.includes("unreferenced");
    const fallbackIdentifier = cleanIdentifier(resource.title ?? resource.provenance[0]?.sourceFilename ?? "");
    const displayTitle = pathTitle ?? (unresolved ? `剧情 CG · ${fallbackIdentifier || "技术资源"}` : typeLabel);
    const subtitle = unresolved && !pathTitle && !locator ? "剧情路径待确认" : [typeLabel, sectionLabel, locator].filter(Boolean).join(" · ");
    addDraft(drafts, resource, {
      displayTitle,
      subtitle,
      badges: [ ...(relatedSongTitle ? [`关联：${relatedSongTitle}`] : []), ...(unresolved ? ["待确认"] : []) ],
      metadata: {
        ...(pathTitle ? { storyPathTitle: pathTitle } : {}),
        storyType: typeLabel,
        ...(storyPath ? { storyPathId: storyPath.pathId } : pathId !== undefined ? { storyPathId: pathId } : {}),
        ...(storyPath ? { storyAct: String(storyPath.act) } : nonEmpty(row.act) ? { storyAct: nonEmpty(row.act)! } : {}),
        ...(sectionLabel ? { storySection: sectionLabel } : {}),
        ...(nonEmpty(row.chapter) ? { storyChapter: nonEmpty(row.chapter)! } : {}),
        ...(nonEmpty(row.entry) ? { storyEntry: nonEmpty(row.entry)! } : {}),
        ...(nodeKey ? { storyNode: nodeKey } : {}),
        ...(nodeOrder !== undefined ? { storyNodeOrder: nodeOrder } : {}),
        ...(nonEmpty(row.relatedSongId) ? { relatedSongId: nonEmpty(row.relatedSongId)! } : {}),
        ...(relatedSongTitle ? { relatedSongTitle } : {}),
      },
      searchTerms: [pathTitle ?? "", typeLabel, sectionLabel ?? "", locator ?? "", nodeKey ?? "", nonEmpty(row.assetPath) ?? "", nonEmpty(row.relatedSongId) ?? "", relatedSongTitle ?? "", ...(relatedSong?.titleAliases ?? []), nonEmpty(row.storyType) ?? ""],
      sortOrder: storySortOrder(row, rowIndex, pathId, nodeOrder, undefined, unresolved),
      facets: {
        type: [typeLabel],
        path: [pathTitle ?? typeLabel],
        ...(sectionLabel ? { section: [sectionLabel] } : {}),
        ...(nonEmpty(row.chapter) ? { chapter: [`Chapter ${nonEmpty(row.chapter)}`] } : {}),
      },
    });
  });

  storyIndex.storyCg.forEach((curated, curatedIndex) => {
    const resource = findResource(index, "arcaea", curated.assetPath);
    if (!resource || resource.resourceType !== "story-cg") return;
    indexedStoryCgResources.add(resource.id);
    if (drafts.has(resource.id)) return;
    const nodeContext = storyNodeByKey.get(curated.nodeKey);
    const annotation = storyNodeAnnotationByKey.get(curated.nodeKey);
    const storyPath = nodeContext?.path;
    const pathId = storyPath?.pathId;
    const nodeOrder = nodeContext?.nodeOrder;
    const typeLabel = storyTypeLabel(storyPath?.type);
    const pathTitle = storyPath?.title ?? "Divine Oblivion";
    const sectionLabel = storyPath ? storySectionByAct.get(storyPath.act) : undefined;
    const locator = storyLocator({ nodeKey: curated.nodeKey }, curated.nodeKey);
    const relatedSongId = annotation?.relatedSongId;
    const relatedSong = relatedSongId ? songById.get(relatedSongId) : undefined;
    const relatedSongTitle = relatedSong?.displayTitle;
    const imageLabel = curated.imageCount > 1 ? `CG ${curated.imageOrder}/${curated.imageCount}` : undefined;
    const sourceFilename = curated.assetPath.split("/").pop() ?? curated.assetPath;
    addDraft(drafts, resource, {
      displayTitle: pathTitle,
      subtitle: [typeLabel, sectionLabel, locator, imageLabel].filter(Boolean).join(" · "),
      badges: relatedSongTitle ? [`关联：${relatedSongTitle}`] : [],
      metadata: {
        storyPathTitle: pathTitle,
        storyType: typeLabel,
        ...(pathId !== undefined ? { storyPathId: pathId } : {}),
        ...(storyPath ? { storyAct: String(storyPath.act) } : {}),
        ...(sectionLabel ? { storySection: sectionLabel } : {}),
        storyNode: curated.nodeKey,
        ...(nodeOrder !== undefined ? { storyNodeOrder: nodeOrder } : {}),
        storyImageOrder: curated.imageOrder,
        storyImageCount: curated.imageCount,
        ...(relatedSongId ? { relatedSongId } : {}),
        ...(relatedSongTitle ? { relatedSongTitle } : {}),
        ...(annotation?.relatedPackId ? { relatedPackId: annotation.relatedPackId } : {}),
        ...(annotation?.relatedPackTitle ? { relatedPackTitle: annotation.relatedPackTitle } : {}),
      },
      searchTerms: [pathTitle, typeLabel, sectionLabel ?? "", locator ?? "", curated.nodeKey, sourceFilename, curated.assetPath, relatedSongId ?? "", relatedSongTitle ?? "", ...(relatedSong?.titleAliases ?? [])],
      sortOrder: storySortOrder({}, curatedIndex, pathId, nodeOrder, curated.imageOrder),
      facets: {
        type: [typeLabel],
        path: [pathTitle],
        ...(sectionLabel ? { section: [sectionLabel] } : {}),
      },
    });
  });

  const storyCgResources = catalog.resources.filter((resource) => resource.game === "arcaea" && resource.resourceType === "story-cg" && resource.lifecycle.status === "published");
  const baselineStoryCgRows = storyRows.filter((row) => normalizePath(nonEmpty(row.assetPath) ?? "").startsWith("assets/app-data/story/cg/"));
  const missingStoryCgResources = storyCgResources.filter((resource) => !indexedStoryCgResources.has(resource.id));
  const missingCuratedStoryCg = storyIndex.storyCg.filter((curated) => {
    const resource = findResource(index, "arcaea", curated.assetPath);
    return !resource || resource.resourceType !== "story-cg";
  });
  if (baselineStoryCgRows.length !== storyIndex.coverage.baselineRelationCount || storyCgResources.length !== storyIndex.coverage.physicalStoryCgCount || storyIndex.storyCg.length !== storyIndex.coverage.curatedStoryCgCount || missingStoryCgResources.length > 0 || missingCuratedStoryCg.length > 0) {
    const missing = missingStoryCgResources.map((resource) => resource.provenance[0]?.sourceRelativePath ?? resource.id);
    const missingCurated = missingCuratedStoryCg.map((curated) => curated.assetPath);
    throw new Error(`Arcaea story CG index coverage failed: expected ${storyIndex.coverage.baselineRelationCount} baseline rows and ${storyIndex.coverage.physicalStoryCgCount} resources with ${storyIndex.coverage.curatedStoryCgCount} curated additions, found ${baselineStoryCgRows.length}, ${storyCgResources.length} and ${storyIndex.storyCg.length}; missing [${[...missing, ...missingCurated].join(", ")}]`);
  }

  const textureRelations = new Map<string, { resource: Resource; rows: CsvRow[] }>();
  storyReferenceRows.forEach((row) => {
    if (!nonEmpty(row.resourceRole)?.includes("visual")) return;
    const resource = findResource(index, "arcaea", row.resolvedAPKPath ?? "");
    if (!resource || resource.resourceType !== "story-texture") return;
    const current = textureRelations.get(resource.id) ?? { resource, rows: [] };
    current.rows.push(row);
    textureRelations.set(resource.id, current);
  });
  [...textureRelations.values()].forEach(({ resource, rows }, resourceIndex) => {
    const contexts = unique(rows.map((row) => [nonEmpty(row.relatedNodeKey), nonEmpty(row.relatedStoryData), nonEmpty(row.relatedEntryPath)?.replace(/^.*entries_/u, "Entry ")].filter(Boolean).join(" · ")).filter(Boolean));
    const entries = unique(rows.map((row) => nonEmpty(row.relatedNodeKey) ?? nonEmpty(row.relatedEntryPath)?.replace(/^.*entries_/u, "") ?? "").filter(Boolean));
    const songTitles = unique(rows.map((row) => songById.get(nonEmpty(row.relatedSongId) ?? "")?.displayTitle ?? "").filter(Boolean));
    const subtitle = contexts.length === 1 ? (contexts[0] ?? "VN 剧情资源") : contexts.length > 1 ? `关联 ${contexts.length} 个剧情 Entry` : "VN 剧情资源";
    addDraft(drafts, resource, {
      displayTitle: "剧情贴图",
      subtitle,
      badges: songTitles.length === 1 ? [`关联：${songTitles[0]}`] : [],
      searchTerms: ["剧情贴图", ...contexts, ...entries, ...rows.flatMap((row) => [nonEmpty(row.scriptStem) ?? "", nonEmpty(row.relatedStoryData) ?? "", nonEmpty(row.relatedSongId) ?? ""]), ...songTitles],
      sortOrder: 1_000_000_000 + resourceIndex,
      facets: entries.length > 0 ? { entry: entries } : {},
    });
  });

  const packByResource = new Map<string, { resource: Resource; rows: CsvRow[] }>();
  const packById = new Map(packRecordRows.flatMap((row) => nonEmpty(row.packId) ? [[nonEmpty(row.packId)!, row] as const] : []));
  packRows.forEach((row, rowIndex) => {
    const resource = findResource(index, "arcaea", row.assetPath ?? "");
    if (!resource || resource.resourceType !== "pack-cover") return;
    const current = packByResource.get(resource.id) ?? { resource, rows: [] };
    current.rows.push({ ...row, __rowIndex: String(rowIndex) });
    packByResource.set(resource.id, current);
  });
  [...packByResource.values()].forEach(({ resource, rows }) => {
    const first = rows[0]!;
    const packId = nonEmpty(first.packId) ?? rows.map((row) => inferPackId(row.assetPath ?? "")).find(Boolean);
    const names = unique(rows.flatMap((row) => parseLocalizedValues(row.nameLocalized)));
    const title = displayPackName(packId, localizedPackName(first.nameLocalized), packById);
    const order = integer(first.packOrder) ?? 999999;
    const uiOnly = rows.every((row) => nonEmpty(row.coverRole) !== "pack-cover");
    addDraft(drafts, resource, {
      displayTitle: title,
      subtitle: uiOnly ? "曲包界面素材" : "曲包封面",
      badges: uiOnly ? ["界面素材"] : [],
      searchTerms: [title, ...names, packId ?? "", ...rows.flatMap((row) => [...parseLocalizedValues(row.nameLocalized), nonEmpty(row.assetPath) ?? ""])],
      sortOrder: order * 100 + rows.length,
      facets: { pack: [title] },
    });
  });

  const backgroundGroups = new Map<string, { resource: Resource; rows: CsvRow[] }>();
  backgroundRows.forEach((row) => {
    const resource = findResource(index, "arcaea", row.assetPath ?? "");
    if (!resource || resource.resourceType !== "background") return;
    const current = backgroundGroups.get(resource.id) ?? { resource, rows: [] };
    current.rows.push(row);
    backgroundGroups.set(resource.id, current);
  });
  [...backgroundGroups.values()].forEach(({ resource, rows }, rowIndex) => {
    const keys = unique(rows.map((row) => nonEmpty(row.backgroundKey) ?? "").filter(Boolean));
    const songTitles = unique(rows.map((row) => songById.get(nonEmpty(row.songId) ?? "")?.displayTitle ?? "").filter(Boolean));
    const title = cleanIdentifier(keys[0] ?? resource.title ?? "背景");
    addDraft(drafts, resource, {
      displayTitle: title || "游玩背景",
      subtitle: `用于 ${unique(rows.map((row) => nonEmpty(row.songId) ?? "").filter(Boolean)).length} 首歌曲`,
      searchTerms: [title, ...keys, ...songTitles, ...rows.map((row) => nonEmpty(row.songId) ?? "")],
      sortOrder: rowIndex,
      facets: keys.length > 0 ? { background: keys } : {},
    });
  });

  const fallbackResources = catalog.resources.filter((resource) => resource.game === "arcaea" && ["character-portrait", "character-avatar", "story-texture"].includes(resource.resourceType) && resource.lifecycle.status === "published");
  fallbackResources.forEach((resource, index) => {
    if (drafts.has(resource.id)) return;
    const raw = resource.title ?? resource.provenance[0]?.sourceFilename ?? "";
    const character = characterForAssetPath(characters.byName, raw);
    const fallbackIdentifier = cleanIdentifier(raw);
    const displayTitle = character?.title ?? (resource.resourceType === "story-texture" ? `剧情素材 · ${fallbackIdentifier || "技术资源"}` : resource.resourceType === "character-avatar" ? `头像 · ${fallbackIdentifier || "角色资源"}` : `角色立绘 · ${fallbackIdentifier || "角色资源"}`);
    addDraft(drafts, resource, {
      displayTitle,
      subtitle: resource.resourceType === "story-texture" ? "VN/过场技术素材" : "角色名称未在 characters.json 中找到",
      badges: ["待确认"],
      searchTerms: [raw],
      sortOrder: 2_500_000_000 + index,
    });
  });

  const sourceVersion = arcaeaBrowse.source.version;
  const updateResources = catalog.resources.filter((resource) => {
    if (resource.game !== "arcaea" || resource.resourceType === "jacket" || resource.lifecycle.status !== "published") return false;
    return resource.metadata.gameVersion === sourceVersion;
  });
  updateResources.forEach((resource, index) => {
    if (drafts.has(resource.id)) return;
    const raw = resource.title ?? resource.provenance[0]?.sourceFilename ?? "Arcaea 资源";
    const subtitle = resource.resourceType === "pack-cover"
      ? "曲包封面"
      : resource.resourceType === "story-cg"
        ? "剧情 CG"
        : resource.resourceType === "story-texture"
          ? "剧情贴图"
          : resource.resourceType === "background"
            ? "游玩背景"
            : resource.resourceType === "startup"
              ? "启动页面"
              : resource.resourceType === "character-portrait"
                ? "角色立绘"
                : resource.resourceType === "character-avatar"
                  ? "角色头像"
                  : resource.resourceType === "linkplay-preview" ? "LinkPlay 预览" : "Arcaea 7.0 资源";
    const packId = typeof resource.metadata.packId === "string" ? resource.metadata.packId : undefined;
    const sourcePath = resource.provenance[0]?.sourceRelativePath;
    addDraft(drafts, resource, {
      displayTitle: raw,
      subtitle,
      badges: [sourceVersion],
      metadata: {
        sourceVersion,
        ...(packId ? { packId } : {}),
      },
      searchTerms: [raw, sourcePath ?? "", packId ?? ""],
      sortOrder: 3_100_000_000 + index,
      facets: { release: [sourceVersion] },
    });
  });

  const resources = [...drafts.values()].map((draft) => ({
    resourceId: draft.resourceId,
    resourceType: draft.resourceType,
    ...(draft.displayTitle ? { displayTitle: draft.displayTitle } : {}),
    ...(draft.subtitle ? { subtitle: draft.subtitle } : {}),
    badges: [...draft.badges],
    metadata: Object.fromEntries(draft.metadata),
    searchTerms: [...draft.searchTerms],
    ...(draft.sortOrder !== undefined ? { sortOrder: draft.sortOrder } : {}),
    facets: Object.fromEntries([...draft.facets.entries()].map(([key, values]) => [key, [...values]])),
  })).sort((left, right) => (left.sortOrder ?? 3_000_000_000) - (right.sortOrder ?? 3_000_000_000) || (left.displayTitle ?? "").localeCompare(right.displayTitle ?? "", "zh-CN") || left.resourceId.localeCompare(right.resourceId, "en"));
  const projection = CategoryBrowseProjection.parse({
    schemaVersion: 1,
    game: "arcaea",
    generatedAt: catalog.generatedAt,
    source: { snapshot: `Arcaea APK ${arcaeaBrowse.source.version}`, sha256: sourceDigest() },
    resources,
  });
  return { projection, metrics: { characterPortraitMapped: mappedPortrait.size, characterPortraitTotal: portraitResources.size, characterAvatarMapped: mappedAvatar.size, characterAvatarTotal: avatarResources.size, storyCgAnnotated: resources.filter((resource) => resource.resourceType === "story-cg").length, storyCgBaselineRows: baselineStoryCgRows.length, storyCgIndexed: indexedStoryCgResources.size, storyCgTotal: storyCgResources.length, storyCgMissing: missingStoryCgResources.length, storyTextureWithRelation: textureRelations.size, storyTextureTotal: resources.filter((resource) => resource.resourceType === "story-texture").length, backgroundAnnotated: resources.filter((resource) => resource.resourceType === "background").length, packCoverAnnotated: resources.filter((resource) => resource.resourceType === "pack-cover").length, linkplayStickerAnnotated: resources.filter((resource) => resource.resourceType === "sticker").length } };
}

function buildPhigrosSemantics(catalog: Catalog, auditRows: CsvRow[], snapshot: string, digest: string): { projection: CategoryBrowseProjectionType; metrics: Record<string, number> } {
  const resources = catalog.resources.filter((resource) => resource.game === "phigros" && resource.resourceType === "pack-cover" && resource.lifecycle.status === "published").map((resource, index) => {
    const raw = resource.title ?? "";
    const main = raw.match(/^MainStory(\d+)/iu);
    const side = raw.match(/^SideStory(\d+)/iu);
    const variant = raw.match(/^(?:MainStory\d+|SideStory\d+)(.+)$/iu)?.[1];
    if (main) {
      return { resourceId: resource.id, resourceType: resource.resourceType, displayTitle: `主线 · 第${main[1]}章`, subtitle: "主线章节封面", badges: variant ? ["封面变体"] : [], searchTerms: [raw, `Main Story ${main[1]}`, `主线 第${main[1]}章`], sortOrder: Number(main[1]) * 10 + (variant ? 1 : 0), facets: { kind: ["主线"] } };
    }
    if (side) {
      return { resourceId: resource.id, resourceType: resource.resourceType, displayTitle: `支线 · 第${side[1]}章`, subtitle: "支线章节封面", badges: variant ? ["封面变体"] : [], searchTerms: [raw, `Side Story ${side[1]}`, `支线 第${side[1]}章`], sortOrder: 1_000 + Number(side[1]) * 10 + (variant ? 1 : 0), facets: { kind: ["支线"] } };
    }
    if (normalizeSearch(raw) === "single") return { resourceId: resource.id, resourceType: resource.resourceType, displayTitle: "单曲", subtitle: "单曲封面", badges: [], searchTerms: [raw, "Single", "单曲"], sortOrder: 2_000, facets: { kind: ["单曲"] } };
    if (normalizeSearch(raw) === "allsong") return { resourceId: resource.id, resourceType: resource.resourceType, displayTitle: "全部曲目", subtitle: "曲目集合封面", badges: [], searchTerms: [raw, "All Song", "全部曲目"], sortOrder: 2_100, facets: { kind: ["全部曲目"] } };
    const title = cleanIdentifier(raw) || "曲包封面";
    return { resourceId: resource.id, resourceType: resource.resourceType, displayTitle: title, subtitle: "曲包封面", badges: [], searchTerms: [raw, title], sortOrder: 3_000 + index, facets: { kind: ["其他曲包"] } };
  });
  const projection = PhigrosCategoryBrowseProjection.parse({ schemaVersion: 1, game: "phigros", generatedAt: catalog.generatedAt, source: { snapshot, sha256: digest }, resources });
  return { projection, metrics: { packCoverAnnotated: resources.length, chapterAuditRows: auditRows.length } };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argument = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
  };
  const catalogPath = path.resolve(argument("--catalog", "catalog/index.json"));
  const auditDirectory = path.resolve(argument("--audit", "docs/apk-audit/data"));
  const outputDirectory = path.resolve(argument("--output", "catalog/browse"));
  const catalog = await loadCatalogFile(catalogPath);
  const arcaeaBrowse = ArcaeaBrowseProjection.parse(await json(path.join(outputDirectory, "arcaea.json")));
  const arcaeaManifest = await json<unknown>(path.join(auditDirectory, "arcaea-manifest.json"));
  const phigrosManifest = await json<unknown>(path.join(auditDirectory, "phigros-manifest.json"));
  const characterRows = await trackedCsv(auditDirectory, "arcaea-character-relations.csv");
  const storyRows = await trackedCsv(auditDirectory, "arcaea-story-resource-relations.csv");
  const storyIndex = await trackedJson<ArcaeaStoryIndex>(auditDirectory, "arcaea-story-index.json");
  const storyReferenceRows = await trackedCsv(auditDirectory, "arcaea-story-vn-references.csv");
  const backgroundRows = await trackedCsv(auditDirectory, "arcaea-background-relations.csv");
  const packRows = await trackedCsv(auditDirectory, "arcaea-pack-cover-relations.csv");
  const packRecordRows = await trackedCsv(auditDirectory, "arcaea-pack-records.csv");
  const linkplayRows = await trackedCsv(auditDirectory, "arcaea-linkplay-relations.csv");
  const phigrosChapterRows = await trackedCsv(auditDirectory, "phigros-chapter-cover-records.csv");
  const index = createPathIndex(catalog);
  const arcaea = buildArcaeaSemantics(catalog, arcaeaBrowse, index, characterRows, storyRows, storyIndex, storyReferenceRows, backgroundRows, packRows, packRecordRows, linkplayRows);
  const phigros = buildPhigrosSemantics(catalog, phigrosChapterRows, `Phigros APK ${apkVersion(phigrosManifest)}`, sourceDigest(new Set(["arcaea-story-index.json"])));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "arcaea-semantics.json"), `${JSON.stringify(arcaea.projection, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDirectory, "phigros-semantics.json"), `${JSON.stringify(phigros.projection, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    outputDirectory,
    arcaea: arcaea.metrics,
    phigros: phigros.metrics,
    sourceSnapshots: { arcaea: `Arcaea APK ${arcaeaBrowse.source.version}`, phigros: `Phigros APK ${apkVersion(phigrosManifest)}` },
  }, null, 2));
}

await main();
