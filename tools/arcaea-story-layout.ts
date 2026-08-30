import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ArcaeaStoryLayout,
  type ArcaeaStoryAuthoredAvatarType,
  type ArcaeaStoryAuthoredContinuationNodeType,
  type ArcaeaStoryAuthoredLineType,
  type ArcaeaStoryAuthoredNodeType,
  type ArcaeaStoryAuthoredOverviewPathType,
  type ArcaeaStoryAuthoredPortalType,
  type ArcaeaStoryAuthoredTitleType,
  type ArcaeaStoryAuthoredWorldPathType,
  type ArcaeaStoryLayoutPlacementType,
  type ArcaeaStoryLayoutType,
} from "../packages/domain/src/browse.js";
import { readCsbFile, type CsbNode, type CsbPoint } from "./arcaea-story-csb.js";

const EXTRACTION_VERSION = "arcaea-story-csb-v1";
const LAYOUT_PADDING = 180;
const DEFAULT_NODE_WIDTH = 193;
const DEFAULT_NODE_HEIGHT = 193;
const DEFAULT_TITLE_WIDTH = 300;
const DEFAULT_TITLE_HEIGHT = 72;
const DEFAULT_AVATAR_SIZE = 72;
const DEFAULT_PORTAL_SIZE = 260;

type StoryIndex = {
  source: ArcaeaStoryLayoutType["source"];
  sections: Array<{ act: number; label: string; pathIds: number[] }>;
  paths: Array<{ pathId: number; act: number; title: string; type: string; characters: number[]; nodes: string[] }>;
};

type OrderingFile = {
  ordering: Array<{
    act: number;
    paths: Array<{ path: number; title: string; type: string; characters: number[]; nodes: string[] }>;
  }>;
};

type RawTransform = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
};

type RawNode = {
  transform: RawTransform;
  width?: number;
  height?: number;
  sourceName: string;
  artRef?: string | undefined;
};

type RawLine = RawTransform & {
  lineId: string;
  length: number;
  thickness: number;
  sourceName: string;
  resourcePath?: string | undefined;
  pathId?: number | undefined;
};

type RawPortal = RawTransform & {
  portalId: string;
  sourceName: string;
  artRef?: string | undefined;
  width?: number;
  height?: number;
};

type RawTitle = RawTransform & {
  sourceName: string;
  text?: string;
};

type RawBoundsItem = {
  transform: RawTransform;
  width: number;
  height: number;
};

type CsbPart = {
  act: number;
  part: number;
  overview: string;
  world: string;
};

const PARTS: CsbPart[] = [
  { act: 1, part: 1, overview: "overview_act1part1.csb", world: "act1part1.csb" },
  { act: 1, part: 2, overview: "overview_act1part2.csb", world: "act1part2.csb" },
  { act: 1, part: 3, overview: "overview_act1part3.csb", world: "act1part3.csb" },
  { act: 2, part: 1, overview: "overview_act2part1.csb", world: "act2part1.csb" },
  { act: 2, part: 2, overview: "overview_act2part2.csb", world: "act2part2.csb" },
];

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function numberFromName(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`Expected numeric ${label}, received ${JSON.stringify(value)}`);
  return Number(value);
}

function packagePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized.startsWith("assets/") ? normalized : `assets/${normalized}`;
}

function sourceTransform(node: CsbNode): RawTransform {
  return {
    x: finite(node.position.x, 0),
    y: finite(node.position.y, 0),
    scaleX: finite(node.scale.x, 1),
    scaleY: finite(node.scale.y, 1),
    rotation: finite(node.rotation, 0),
  };
}

function compose(parent: RawTransform, child: RawTransform): RawTransform {
  const radians = parent.rotation * Math.PI / 180;
  return {
    x: parent.x + Math.cos(radians) * child.x * parent.scaleX - Math.sin(radians) * child.y * parent.scaleY,
    y: parent.y + Math.sin(radians) * child.x * parent.scaleX + Math.cos(radians) * child.y * parent.scaleY,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
    rotation: parent.rotation + child.rotation,
  };
}

function identity(): RawTransform {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
}

function positiveDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nodeDimension(node: CsbNode, axis: "width" | "height", fallback: number): number {
  return positiveDimension(axis === "width" ? node.size.width : node.size.height, fallback);
}

function placement(transform: RawTransform, minX: number, maxY: number): ArcaeaStoryLayoutPlacementType {
  return {
    x: transform.x - minX + LAYOUT_PADDING,
    y: maxY - transform.y + LAYOUT_PADDING,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: -transform.rotation,
  };
}

function addTransformedRect(items: RawBoundsItem[], transform: RawTransform, width: number, height: number): void {
  items.push({ transform, width, height });
}

function transformedCorners(item: RawBoundsItem): CsbPoint[] {
  const halfWidth = item.width / 2;
  const halfHeight = item.height / 2;
  const radians = item.transform.rotation * Math.PI / 180;
  const corners: Array<[number, number]> = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ];
  return corners.map(([x, y]) => ({
    x: item.transform.x + Math.cos(radians) * x * item.transform.scaleX - Math.sin(radians) * y * item.transform.scaleY,
    y: item.transform.y + Math.sin(radians) * x * item.transform.scaleX + Math.cos(radians) * y * item.transform.scaleY,
  }));
}

function lineEndpoints(line: RawLine): CsbPoint[] {
  const radians = line.rotation * Math.PI / 180;
  const length = line.length * Math.abs(line.scaleX);
  return [
    { x: line.x, y: line.y },
    { x: line.x + Math.cos(radians) * length, y: line.y + Math.sin(radians) * length },
  ];
}

function normalizedBounds(items: RawBoundsItem[], lines: RawLine[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = items.flatMap((item) => transformedCorners(item));
  points.push(...lines.flatMap((line) => lineEndpoints(line)));
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function normalizedSize(bounds: { minX: number; minY: number; maxX: number; maxY: number }): { width: number; height: number } {
  return {
    width: Math.max(1, bounds.maxX - bounds.minX + LAYOUT_PADDING * 2),
    height: Math.max(1, bounds.maxY - bounds.minY + LAYOUT_PADDING * 2),
  };
}

function normalizedLine(line: RawLine, bounds: { minX: number; maxY: number }): ArcaeaStoryAuthoredLineType {
  return {
    ...placement(line, bounds.minX, bounds.maxY),
    lineId: line.lineId,
    length: Math.max(1, line.length),
    thickness: Math.max(0.5, line.thickness),
    sourceName: line.sourceName,
    ...(line.resourcePath ? { resourcePath: line.resourcePath } : {}),
    ...(line.pathId === undefined ? {} : { pathId: line.pathId }),
  };
}

function normalizedNode(node: RawNode, pathId: number, slot: number, bounds: { minX: number; maxY: number }): ArcaeaStoryAuthoredNodeType {
  return {
    ...placement(node.transform, bounds.minX, bounds.maxY),
    nodeKey: "",
    pathId,
    slot,
    sourceName: node.sourceName,
    ...(node.artRef ? { artRef: node.artRef } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
  };
}

function normalizedTitle(title: RawTitle, bounds: { minX: number; maxY: number }): ArcaeaStoryAuthoredTitleType {
  return {
    ...placement(title, bounds.minX, bounds.maxY),
    sourceName: title.sourceName,
    ...(title.text ? { text: title.text } : {}),
  };
}

function findDescendants(root: CsbNode, predicate: (node: CsbNode) => boolean): CsbNode[] {
  const matches: CsbNode[] = [];
  const visit = (node: CsbNode): void => {
    if (predicate(node)) matches.push(node);
    node.children.forEach(visit);
  };
  root.children.forEach(visit);
  return matches;
}

function findDirect(node: CsbNode, predicate: (child: CsbNode) => boolean): CsbNode | undefined {
  return node.children.find(predicate);
}


function resourcePathForNode(node: CsbNode): string | undefined {
  const resource = node.normalPath ?? node.resourcePath;
  return resource ? packagePath(resource) : undefined;
}

function isEntryProjectNode(node: CsbNode): boolean {
  return node.classname === "ProjectNode" && (node.resourcePath ?? "").endsWith("layouts/story/StoryV2Entry.csb");
}

function isTitleProjectNode(node: CsbNode): boolean {
  return node.classname === "ProjectNode" && (node.resourcePath ?? "").endsWith("layouts/story/StoryV2TitleButton.csb");
}

function isAvatarProjectNode(node: CsbNode): boolean {
  return node.classname === "ProjectNode" && (node.resourcePath ?? "").endsWith("layouts/story/StoryV2CharaPointerNode.csb");
}

function extractRawLines(root: CsbNode, base: RawTransform, pathId?: number): RawLine[] {
  const lines: RawLine[] = [];
  let count = 0;
  const visit = (node: CsbNode, parent: RawTransform): void => {
    const transform = compose(parent, sourceTransform(node));
    const resource = node.resourcePath ?? node.normalPath;
    if (node.visible && resource === "img/white.png") {
      const length = positiveDimension(node.size.width, 1);
      const thickness = positiveDimension(node.size.height, 1);
      lines.push({
        ...transform,
        lineId: `${pathId === undefined ? "world" : `path-${pathId}`}-${count++}-${node.name || node.classname}`,
        length,
        thickness,
        sourceName: node.name || node.classname,
        resourcePath: "assets/img/white.png",
        ...(pathId === undefined ? {} : { pathId }),
      });
    }
    node.children.forEach((child) => visit(child, transform));
  };
  root.children.forEach((child) => visit(child, base));
  return lines;
}

function overviewFromDocument(documentRoot: CsbNode): {
  paths: ArcaeaStoryAuthoredOverviewPathType[];
  bounds: { width: number; height: number };
} {
  const rawPaths: Array<{
    pathId: number;
    sourceName: string;
    anchor: RawTransform;
    entry?: RawTransform;
    title?: RawTitle;
  }> = [];
  const boundsItems: RawBoundsItem[] = [];
  for (const group of documentRoot.children) {
    if (group.classname !== "SingleNode") continue;
    const pathId = numberFromName(group.name, "overview path id");
    const anchor = sourceTransform(group);
    const entryNode = findDirect(group, isEntryProjectNode);
    const titleNode = findDirect(group, isTitleProjectNode);
    const entry = entryNode ? compose(anchor, sourceTransform(entryNode)) : undefined;
    const title = titleNode ? {
      ...compose(anchor, sourceTransform(titleNode)),
      sourceName: titleNode.name || "title",
      ...(titleNode.text ? { text: titleNode.text } : {}),
    } : undefined;
    rawPaths.push({ pathId, sourceName: group.name, anchor, ...(entry ? { entry } : {}), ...(title ? { title } : {}) });
    addTransformedRect(boundsItems, anchor, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
    if (entry) addTransformedRect(boundsItems, entry, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
    if (title) addTransformedRect(boundsItems, title, DEFAULT_TITLE_WIDTH, DEFAULT_TITLE_HEIGHT);
  }
  const bounds = normalizedBounds(boundsItems, []);
  return {
    bounds: normalizedSize(bounds),
    paths: rawPaths.map((item) => ({
      pathId: item.pathId,
      slot: item.pathId + 1,
      sourceName: item.sourceName,
      anchor: placement(item.anchor, bounds.minX, bounds.maxY),
      ...(item.entry ? { entry: placement(item.entry, bounds.minX, bounds.maxY) } : {}),
      ...(item.title ? { title: normalizedTitle(item.title, { minX: bounds.minX, maxY: bounds.maxY }) } : {}),
    })),
  };
}

function worldFromDocument(documentRoot: CsbNode, csbPath: string, ordering: Map<number, string[]>): {
  paths: ArcaeaStoryAuthoredWorldPathType[];
  lines: ArcaeaStoryAuthoredLineType[];
  portals: ArcaeaStoryAuthoredPortalType[];
  bounds: { width: number; height: number };
} {
  const rawPaths: Array<{
    pathId: number;
    sourceName: string;
    anchor: RawTransform;
    title?: RawTitle;
    nodes: Array<RawNode & { slot: number }>;
    avatars: Array<{ transform: RawTransform; characterId: number; sourceName: string }>;
  }> = [];
  const rawLines: RawLine[] = [];
  const rawPortals: RawPortal[] = [];
  const boundsItems: RawBoundsItem[] = [];

  for (const group of documentRoot.children) {
    const pathGroup = findDirect(group, (child) => child.classname === "SingleNode" && /^\d+$/u.test(child.name));
    if (!pathGroup) continue;
    const pathId = numberFromName(pathGroup.name, "world path id");
    const pathAnchor = compose(sourceTransform(group), sourceTransform(pathGroup));
    const pathNodes: Array<RawNode & { slot: number }> = [];
    const pathAvatars: Array<{ transform: RawTransform; characterId: number; sourceName: string }> = [];
    let title: RawTitle | undefined;
    const pathOrdering = ordering.get(pathId) ?? [];
    for (const child of pathGroup.children) {
      const transform = compose(pathAnchor, sourceTransform(child));
      if (isEntryProjectNode(child)) {
        const slot = numberFromName(child.name, "CSB entry slot");
        const nodeKey = pathOrdering[slot - 1];
        if (!nodeKey) throw new Error(`Missing ordering node for path ${pathId}, slot ${slot} in ${csbPath}`);
        const width = nodeDimension(child, "width", DEFAULT_NODE_WIDTH);
        const height = nodeDimension(child, "height", DEFAULT_NODE_HEIGHT);
        pathNodes.push({
          transform,
          width,
          height,
          sourceName: child.name,
          artRef: packagePath(child.resourcePath ?? "layouts/story/StoryV2Entry.csb"),
          slot,
        });
        addTransformedRect(boundsItems, transform, width, height);
        void nodeKey;
      } else if (isTitleProjectNode(child)) {
        title = { ...transform, sourceName: child.name || "title", ...(child.text ? { text: child.text } : {}) };
        addTransformedRect(boundsItems, transform, DEFAULT_TITLE_WIDTH, DEFAULT_TITLE_HEIGHT);
      } else if (isAvatarProjectNode(child)) {
        const match = /^chara_(\d+)$/u.exec(child.name);
        if (match) {
          const characterId = Number(match[1]);
          pathAvatars.push({ transform, characterId, sourceName: child.name });
          addTransformedRect(boundsItems, transform, DEFAULT_AVATAR_SIZE, DEFAULT_AVATAR_SIZE);
        }
      } else if (child.classname === "ProjectNode" && (child.resourcePath ?? "").endsWith("StoryV2EntryFinale.csb")) {
        rawPortals.push({
          ...transform,
          portalId: `final-verdict-${pathId}`,
          sourceName: child.name || "final-verdict",
          artRef: packagePath(child.resourcePath ?? "layouts/story/StoryV2EntryFinale.csb"),
          width: DEFAULT_PORTAL_SIZE,
          height: DEFAULT_PORTAL_SIZE,
        });
        addTransformedRect(boundsItems, transform, DEFAULT_PORTAL_SIZE, DEFAULT_PORTAL_SIZE);
      }
    }
    rawLines.push(...extractRawLines(pathGroup, pathAnchor, pathId));
    rawPaths.push({
      pathId,
      sourceName: group.name || pathGroup.name,
      anchor: pathAnchor,
      ...(title ? { title } : {}),
      nodes: pathNodes,
      avatars: pathAvatars,
    });
  }

  const bounds = normalizedBounds(boundsItems, rawLines);
  return {
    bounds: normalizedSize(bounds),
    paths: rawPaths.map((item) => ({
      pathId: item.pathId,
      sourceName: item.sourceName,
      anchor: placement(item.anchor, bounds.minX, bounds.maxY),
      ...(item.title ? { title: normalizedTitle(item.title, { minX: bounds.minX, maxY: bounds.maxY }) } : {}),
      nodes: item.nodes
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((node): ArcaeaStoryAuthoredNodeType => ({
          ...normalizedNode(node, item.pathId, node.slot, { minX: bounds.minX, maxY: bounds.maxY }),
          nodeKey: (ordering.get(item.pathId) ?? [])[node.slot - 1] ?? "",
        })),
      avatars: item.avatars.map((avatar): ArcaeaStoryAuthoredAvatarType => ({
        ...placement(avatar.transform, bounds.minX, bounds.maxY),
        characterId: avatar.characterId,
        sourceName: avatar.sourceName,
      })),
    })),
    lines: rawLines.map((line) => normalizedLine(line, { minX: bounds.minX, maxY: bounds.maxY })),
    portals: rawPortals.map((portal): ArcaeaStoryAuthoredPortalType => ({
      ...placement(portal, bounds.minX, bounds.maxY),
      portalId: portal.portalId,
      sourceName: portal.sourceName,
      ...(portal.artRef ? { artRef: portal.artRef } : {}),
      ...(portal.width ? { width: portal.width } : {}),
      ...(portal.height ? { height: portal.height } : {}),
    })),
  };
}

function finaleSubworld(documentRoot: CsbNode): {
  nodes: ArcaeaStoryAuthoredNodeType[];
  lines: ArcaeaStoryAuthoredLineType[];
  bounds: { width: number; height: number };
} {
  const rawNodes: Array<RawNode & { slot: number }> = [];
  const rawLines: RawLine[] = [];
  const boundsItems: RawBoundsItem[] = [];
  for (const item of composeChildren(documentRoot)) {
    const match = /^button_102-(\d+)$/u.exec(item.node.name);
    if (item.node.classname === "Button" && match) {
      const slot = Number(match[1]);
      const width = nodeDimension(item.node, "width", DEFAULT_NODE_WIDTH);
      const height = nodeDimension(item.node, "height", DEFAULT_NODE_HEIGHT);
      rawNodes.push({
        transform: item.transform,
        width,
        height,
        sourceName: item.node.name,
        ...(resourcePathForNode(item.node) ? { artRef: resourcePathForNode(item.node) } : {}),
        slot,
      });
      addTransformedRect(boundsItems, item.transform, width, height);
    }
    const resource = item.node.resourcePath ?? item.node.normalPath;
    if (item.node.classname === "Sprite" && resource && /Finale-Divider/u.test(resource)) {
      const width = nodeDimension(item.node, "width", 12);
      const height = nodeDimension(item.node, "height", 12);
      rawLines.push({
        ...item.transform,
        lineId: `finale-${rawLines.length}-${item.node.name || "divider"}`,
        length: Math.max(width, height),
        thickness: Math.min(width, height),
        sourceName: item.node.name || "divider",
        ...(resourcePathForNode(item.node) ? { resourcePath: resourcePathForNode(item.node) } : {}),
      });
      addTransformedRect(boundsItems, item.transform, width, height);
    }
  }
  const bounds = normalizedBounds(boundsItems, rawLines);
  return {
    bounds: normalizedSize(bounds),
    nodes: rawNodes
      .sort((a, b) => a.slot - b.slot)
      .map((node): ArcaeaStoryAuthoredNodeType => ({
        ...placement(node.transform, bounds.minX, bounds.maxY),
        nodeKey: `F-${node.slot}`,
        pathId: 19,
        slot: node.slot,
        sourceName: node.sourceName,
        ...(node.artRef ? { artRef: node.artRef } : {}),
        ...(node.width ? { width: node.width } : {}),
        ...(node.height ? { height: node.height } : {}),
      })),
    lines: rawLines.map((line) => normalizedLine(line, { minX: bounds.minX, maxY: bounds.maxY })),
  };
}

function epilogueContinuation(documentRoot: CsbNode, csbPath: string): {
  continuationId: string;
  title: string;
  csbPath: string;
  bounds: { width: number; height: number };
  nodes: ArcaeaStoryAuthoredContinuationNodeType[];
  lines: ArcaeaStoryAuthoredLineType[];
} {
  const rawNodes: Array<RawNode & { nodeId: string; label?: string }> = [];
  const rawLines: RawLine[] = [];
  const boundsItems: RawBoundsItem[] = [];
  for (const parent of documentRoot.children) {
    const button = findDescendants(parent, (node) => node.classname === "Button" && /Epilogue-[AB]\.png$/u.test(node.normalPath ?? ""))[0];
    if (!button) continue;
    const item = composeChildren(parent).find((entry) => entry.node === button);
    if (!item) continue;
    const label = findDescendants(parent, (node) => node.classname === "Text" && Boolean(node.text))[0]?.text;
    const width = nodeDimension(button, "width", 420);
    const height = nodeDimension(button, "height", 350);
    rawNodes.push({
      transform: item.transform,
      width,
      height,
      sourceName: button.name || parent.name,
      ...(resourcePathForNode(button) ? { artRef: resourcePathForNode(button) } : {}),
      nodeId: parent.name || button.name || `epilogue-${rawNodes.length + 1}`,
      ...(label ? { label } : {}),
    });
    addTransformedRect(boundsItems, item.transform, width, height);
    rawLines.push(...extractRawLines(parent, sourceTransform(parent)).filter((line) => /(?:Epilogue-Line|Finale-Divider)/u.test(line.resourcePath ?? "")));
  }
  const bounds = normalizedBounds(boundsItems, rawLines);
  return {
    continuationId: "epilogue",
    title: "Epilogue",
    csbPath,
    bounds: normalizedSize(bounds),
    nodes: rawNodes.map((node): ArcaeaStoryAuthoredContinuationNodeType => ({
      ...placement(node.transform, bounds.minX, bounds.maxY),
      nodeId: node.nodeId,
      sourceName: node.sourceName,
      ...(node.artRef ? { artRef: node.artRef } : {}),
      ...(node.label ? { label: node.label } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
    })),
    lines: rawLines.map((line) => normalizedLine(line, { minX: bounds.minX, maxY: bounds.maxY })),
  };
}

function flattenOrdering(value: OrderingFile): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const act of value.ordering) {
    for (const storyPath of act.paths) result.set(storyPath.path, [...storyPath.nodes]);
  }
  return result;
}

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function buildArcaeaStoryLayout(packageRoot: string, indexPath: string): Promise<ArcaeaStoryLayoutType> {
  const index = await loadJson<StoryIndex>(indexPath);
  const orderingPath = path.join(packageRoot, "assets", "app-data", "story2", "ordering");
  const ordering = flattenOrdering(await loadJson<OrderingFile>(orderingPath));
  const sections = [];
  const csbPaths: string[] = [];

  for (let sectionAct = 0; sectionAct < PARTS.length; sectionAct += 1) {
    const part = PARTS[sectionAct];
    if (!part) throw new Error(`Missing CSB part at index ${sectionAct}`);
    const overviewPath = `assets/app-data/story2/${part.overview}`;
    const worldPath = `assets/app-data/story2/${part.world}`;
    const overviewDocument = await readCsbFile(path.join(packageRoot, overviewPath));
    const worldDocument = await readCsbFile(path.join(packageRoot, worldPath));
    const overview = overviewFromDocument(overviewDocument.root);
    const world = worldFromDocument(worldDocument.root, worldPath, ordering);
    const expectedPathIds = index.sections.find((section) => section.act === sectionAct)?.pathIds ?? [];
    const overviewPathIds = new Set(overview.paths.map((item) => item.pathId));
    const worldPathIds = new Set(world.paths.map((item) => item.pathId).concat(world.portals.length ? [19] : []));
    for (const pathId of expectedPathIds) {
      if (!overviewPathIds.has(pathId)) throw new Error(`Missing overview path ${pathId} in ${overviewPath}`);
      if (pathId !== 19 && !worldPathIds.has(pathId)) throw new Error(`Missing world path ${pathId} in ${worldPath}`);
    }
    csbPaths.push(overviewPath, worldPath);
    sections.push({
      sectionAct,
      overview: { csbPath: overviewPath, ...overview },
      world: { csbPath: worldPath, ...world },
    });
  }

  const finalePath = "assets/app-data/story/main/f.csb";
  const epiloguePath = "assets/app-data/story/main/epilogue.csb";
  const finaleDocument = await readCsbFile(path.join(packageRoot, finalePath));
  const epilogueDocument = await readCsbFile(path.join(packageRoot, epiloguePath));
  const finale = finaleSubworld(finaleDocument.root);
  const continuation = epilogueContinuation(epilogueDocument.root, epiloguePath);
  csbPaths.push(finalePath, epiloguePath);

  return ArcaeaStoryLayout.parse({
    schemaVersion: 1,
    game: "arcaea",
    source: index.source,
    extractionVersion: EXTRACTION_VERSION,
    csbPaths,
    sections,
    subworlds: [{
      subworldId: "final-verdict",
      sectionAct: 2,
      title: "Final Verdict",
      csbPath: finalePath,
      bounds: finale.bounds,
      titlePlacement: {
        x: finale.bounds.width / 2,
        y: 48,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        sourceName: "final-verdict-title",
        text: "Final Verdict",
      },
      nodes: finale.nodes,
      lines: finale.lines,
      continuation,
    }],
  });
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("arcaea-story-layout.ts")) {
  const packageRoot = argument("--package-root", "apk/Arcaea_7.0.0c");
  const indexPath = argument("--index", "docs/apk-audit/data/arcaea-story-index.json");
  const outputPath = argument("--output", "docs/apk-audit/data/arcaea-story-layout.json");
  const layout = await buildArcaeaStoryLayout(packageRoot, indexPath);
  await writeFile(outputPath, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}: ${layout.sections.length} sections, ${layout.subworlds.length} subworlds, ${layout.csbPaths.length} CSB inputs`);
}

function composeChildren(root: CsbNode): Array<{ node: CsbNode; transform: RawTransform }> {
  const result: Array<{ node: CsbNode; transform: RawTransform }> = [];
  const visit = (node: CsbNode, parent: RawTransform): void => {
    const transform = compose(parent, sourceTransform(node));
    result.push({ node, transform });
    node.children.forEach((child) => visit(child, transform));
  };
  root.children.forEach((child) => visit(child, identity()));
  return result;
}
