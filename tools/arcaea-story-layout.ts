import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ARCAEA_STORY_LAYOUT_SCHEMA_VERSION,
  ArcaeaStoryLayout,
  type ArcaeaStoryAuthoredAvatarType,
  type ArcaeaStoryAuthoredContinuationNodeType,
  type ArcaeaStoryAuthoredCompositeType,
  type ArcaeaStoryAuthoredLabelType,
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

const EXTRACTION_VERSION = "arcaea-story-csb-v3";
const LAYOUT_PADDING = 180;
const DEFAULT_NODE_WIDTH = 193;
const DEFAULT_NODE_HEIGHT = 193;
const DEFAULT_TITLE_WIDTH = 300;
const DEFAULT_TITLE_HEIGHT = 72;
const DEFAULT_PORTAL_SIZE = 260;
const EPILOGUE_COMPOSITE_SCALE = 0.72;
const EPILOGUE_FORK_GAP = 96;
const EPILOGUE_FORK_X_OFFSET = 80;

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
  matrix?: RawMatrix;
};

type RawMatrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
};

type RawNode = {
  transform: RawTransform;
  anchor: CsbPoint;
  width?: number;
  height?: number;
  label?: RawLabel;
  labelMode?: "overlay" | "baked";
  sourceName: string;
  artRef?: string | undefined;
};

type RawLabel = {
  transform: RawTransform;
  width: number;
  height: number;
  anchor: CsbPoint;
  text?: string;
  fontSize?: number;
  fontResourcePath?: string;
  fontName?: string;
  horizontalAlignment?: "left" | "center" | "right";
  verticalAlignment?: "top" | "center" | "bottom";
};

type RawLine = {
  transform: RawTransform;
  start: CsbPoint;
  end: CsbPoint;
  bounds: CsbPoint[];
  width: number;
  height: number;
  anchor: CsbPoint;
  lineId: string;
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
  label?: RawLabel;
};

type RawAvatar = {
  transform: RawTransform;
  characterId: number;
  sourceName: string;
  width: number;
  height: number;
  anchor: CsbPoint;
};

type StoryComponentGeometry = {
  entryLabel: RawLabel;
  titleLabel: RawLabel;
  avatarVisual: {
    transform: RawTransform;
    width: number;
    height: number;
    anchor: CsbPoint;
  };
};

type RawBoundsItem = {
  transform: RawTransform;
  width: number;
  height: number;
  anchor?: CsbPoint;
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
  const transform = {
    x: finite(node.position.x, 0),
    y: finite(node.position.y, 0),
    scaleX: finite(node.scale.x, 1),
    scaleY: finite(node.scale.y, 1),
    rotation: finite(node.rotation, 0),
  };
  return { ...transform, matrix: matrixFromTransform(transform) };
}

function compose(parent: RawTransform, child: RawTransform): RawTransform {
  return decomposeMatrix(multiplyMatrices(matrixFromTransform(parent), matrixFromTransform(child)));
}

function identity(): RawTransform {
  const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  return { ...transform, matrix: matrixFromTransform(transform) };
}

function matrixFromTransform(transform: Omit<RawTransform, "matrix"> | RawTransform): RawMatrix {
  if ("matrix" in transform && transform.matrix) return transform.matrix;
  const radians = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    a: cosine * transform.scaleX,
    b: -sine * transform.scaleX,
    c: sine * transform.scaleY,
    d: cosine * transform.scaleY,
    tx: transform.x,
    ty: transform.y,
  };
}

function multiplyMatrices(parent: RawMatrix, child: RawMatrix): RawMatrix {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  };
}

function applyMatrix(matrix: RawMatrix, point: CsbPoint): CsbPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
    y: matrix.b * point.x + matrix.d * point.y + matrix.ty,
  };
}

function applyMatrixVector(matrix: RawMatrix, point: CsbPoint): CsbPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y,
    y: matrix.b * point.x + matrix.d * point.y,
  };
}

function decomposeMatrix(matrix: RawMatrix): RawTransform {
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const scaleY = Math.hypot(matrix.c, matrix.d) * (determinant < 0 ? -1 : 1);
  const rotation = scaleX > 0 ? Math.atan2(-matrix.b, matrix.a) * 180 / Math.PI : 0;
  return {
    x: matrix.tx,
    y: matrix.ty,
    scaleX: scaleX || 1,
    scaleY: scaleY || 1,
    rotation,
    matrix,
  };
}

function positiveDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nodeDimension(node: CsbNode, axis: "width" | "height", fallback: number): number {
  return positiveDimension(axis === "width" ? node.size.width : node.size.height, fallback);
}

function horizontalAlignmentName(value: number | undefined): "left" | "center" | "right" | undefined {
  return value === 0 ? "left" : value === 1 ? "center" : value === 2 ? "right" : undefined;
}

function verticalAlignmentName(value: number | undefined): "top" | "center" | "bottom" | undefined {
  return value === 0 ? "top" : value === 1 ? "center" : value === 2 ? "bottom" : undefined;
}

function rawLabel(node: CsbNode, transform: RawTransform): RawLabel {
  const horizontalAlignment = horizontalAlignmentName(node.horizontalAlignment);
  const verticalAlignment = verticalAlignmentName(node.verticalAlignment);
  return {
    transform,
    width: nodeDimension(node, "width", 1),
    height: nodeDimension(node, "height", 1),
    anchor: node.anchor,
    ...(node.text ? { text: node.text } : {}),
    ...(node.fontSize && node.fontSize > 0 ? { fontSize: node.fontSize } : {}),
    ...(node.fontResourcePath ? { fontResourcePath: packagePath(node.fontResourcePath) } : {}),
    ...(node.fontName ? { fontName: node.fontName } : {}),
    ...(horizontalAlignment ? { horizontalAlignment } : {}),
    ...(verticalAlignment ? { verticalAlignment } : {}),
  };
}

function composeLabel(parent: RawTransform, template: RawLabel): RawLabel {
  return { ...template, transform: compose(parent, template.transform) };
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

function addTransformedRect(items: RawBoundsItem[], transform: RawTransform, width: number, height: number, anchor: CsbPoint = { x: 0.5, y: 0.5 }): void {
  items.push({ transform, width, height, anchor });
}

function transformedCorners(item: RawBoundsItem): CsbPoint[] {
  const anchor = item.anchor ?? { x: 0.5, y: 0.5 };
  const corners: Array<[number, number]> = [
    [-anchor.x * item.width, -anchor.y * item.height],
    [(1 - anchor.x) * item.width, -anchor.y * item.height],
    [(1 - anchor.x) * item.width, (1 - anchor.y) * item.height],
    [-anchor.x * item.width, (1 - anchor.y) * item.height],
  ];
  return corners.map(([x, y]) => applyMatrix(matrixFromTransform(item.transform), { x, y }));
}

function lineGeometry(node: CsbNode, transform: RawTransform, axis: "x" | "y" = "x"): { start: CsbPoint; end: CsbPoint; bounds: CsbPoint[]; width: number; height: number; thickness: number; anchor: CsbPoint } {
  const width = nodeDimension(node, "width", 1);
  const height = nodeDimension(node, "height", 1);
  const anchor = node.anchor;
  const centerX = (0.5 - anchor.x) * width;
  const matrix = matrixFromTransform(transform);
  const start = axis === "x"
    ? applyMatrix(matrix, { x: -anchor.x * width, y: (0.5 - anchor.y) * height })
    : applyMatrix(matrix, { x: centerX, y: -anchor.y * height });
  const end = axis === "x"
    ? applyMatrix(matrix, { x: (1 - anchor.x) * width, y: (0.5 - anchor.y) * height })
    : applyMatrix(matrix, { x: centerX, y: (1 - anchor.y) * height });
  const corners: Array<[number, number]> = [
    [-anchor.x * width, -anchor.y * height],
    [(1 - anchor.x) * width, -anchor.y * height],
    [(1 - anchor.x) * width, (1 - anchor.y) * height],
    [-anchor.x * width, (1 - anchor.y) * height],
  ];
  const bounds = corners.map(([x, y]) => applyMatrix(matrix, { x, y }));
  const transformedThickness = axis === "x"
    ? applyMatrixVector(matrix, { x: 0, y: 1 })
    : applyMatrixVector(matrix, { x: 1, y: 0 });
  return {
    start,
    end,
    bounds,
    width,
    height,
    thickness: Math.max(0.5, (axis === "x" ? height : width) * Math.hypot(transformedThickness.x, transformedThickness.y)),
    anchor,
  };
}

function normalizedBounds(items: RawBoundsItem[], lines: RawLine[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = items.flatMap((item) => transformedCorners(item));
  points.push(...lines.flatMap((line) => line.bounds));
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
  const start = {
    x: line.start.x - bounds.minX + LAYOUT_PADDING,
    y: bounds.maxY - line.start.y + LAYOUT_PADDING,
  };
  const end = {
    x: line.end.x - bounds.minX + LAYOUT_PADDING,
    y: bounds.maxY - line.end.y + LAYOUT_PADDING,
  };
  return {
    ...placement(line.transform, bounds.minX, bounds.maxY),
    lineId: line.lineId,
    length: Math.max(1, Math.hypot(end.x - start.x, end.y - start.y)),
    thickness: line.thickness,
    sourceName: line.sourceName,
    width: line.width,
    height: line.height,
    anchorX: line.anchor.x,
    anchorY: line.anchor.y,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    ...(line.resourcePath ? { resourcePath: line.resourcePath } : {}),
    ...(line.pathId === undefined ? {} : { pathId: line.pathId }),
  };
}

function normalizedNode(node: RawNode, pathId: number, slot: number, bounds: { minX: number; maxY: number }, labelText?: string): ArcaeaStoryAuthoredNodeType {
  return {
    ...placement(node.transform, bounds.minX, bounds.maxY),
    nodeKey: "",
    pathId,
    slot,
    sourceName: node.sourceName,
    ...(node.artRef ? { artRef: node.artRef } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    labelMode: node.labelMode ?? "overlay",
    ...(node.label ? { label: normalizedLabel(node.label, bounds, labelText) } : {}),
  };
}

function normalizedLabel(label: RawLabel, bounds: { minX: number; maxY: number }, textOverride?: string): ArcaeaStoryAuthoredLabelType {
  const text = textOverride ?? label.text;
  return {
    ...placement(label.transform, bounds.minX, bounds.maxY),
    width: label.width,
    height: label.height,
    anchorX: label.anchor.x,
    anchorY: label.anchor.y,
    ...(text ? { text } : {}),
    ...(label.fontSize ? { fontSize: label.fontSize } : {}),
    ...(label.fontResourcePath ? { fontResourcePath: label.fontResourcePath } : {}),
    ...(label.fontName ? { fontName: label.fontName } : {}),
    ...(label.horizontalAlignment ? { horizontalAlignment: label.horizontalAlignment } : {}),
    ...(label.verticalAlignment ? { verticalAlignment: label.verticalAlignment } : {}),
  };
}

function normalizedTitle(title: RawTitle, bounds: { minX: number; maxY: number }): ArcaeaStoryAuthoredTitleType {
  return {
    ...placement(title, bounds.minX, bounds.maxY),
    sourceName: title.sourceName,
    ...(title.text ? { text: title.text } : {}),
    ...(title.label ? { label: normalizedLabel(title.label, bounds) } : {}),
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

async function loadStoryComponentGeometry(packageRoot: string): Promise<StoryComponentGeometry> {
  const componentRoot = path.join(packageRoot, "assets", "layouts", "story");
  const [entry, title, avatar, finale] = await Promise.all([
    readCsbFile(path.join(componentRoot, "StoryV2Entry.csb")),
    readCsbFile(path.join(componentRoot, "StoryV2TitleButton.csb")),
    readCsbFile(path.join(componentRoot, "StoryV2CharaPointerNode.csb")),
    readCsbFile(path.join(componentRoot, "StoryV2EntryFinale.csb")),
  ]);
  const entryLabelNode = findDescendants(entry.root, (node) => node.classname === "Text" && node.name === "text")[0];
  const titleLabelNode = findDescendants(title.root, (node) => node.classname === "Text" && node.name === "text")[0];
  const avatarVisualNode = findDescendants(avatar.root, (node) => node.classname === "Button" && node.name === "button")[0];
  const finaleTextNode = findDescendants(finale.root, (node) => node.classname.startsWith("Text"))[0];
  if (!entryLabelNode || !titleLabelNode || !avatarVisualNode) {
    throw new Error("Story component CSB is missing Entry, Title or Avatar geometry");
  }
  if (finaleTextNode) throw new Error("StoryV2EntryFinale unexpectedly contains a text label");
  return {
    entryLabel: rawLabel(entryLabelNode, sourceTransform(entryLabelNode)),
    titleLabel: rawLabel(titleLabelNode, sourceTransform(titleLabelNode)),
    avatarVisual: {
      transform: sourceTransform(avatarVisualNode),
      width: nodeDimension(avatarVisualNode, "width", 1),
      height: nodeDimension(avatarVisualNode, "height", 1),
      anchor: avatarVisualNode.anchor,
    },
  };
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
      const geometry = lineGeometry(node, transform);
      lines.push({
        transform,
        ...geometry,
        lineId: `${pathId === undefined ? "world" : `path-${pathId}`}-${count++}-${node.name || node.classname}`,
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

function overviewFromDocument(documentRoot: CsbNode, components: StoryComponentGeometry): {
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
    const titleTransform = titleNode ? compose(anchor, sourceTransform(titleNode)) : undefined;
    const title = titleNode && titleTransform ? {
      ...titleTransform,
      sourceName: titleNode.name || "title",
      ...(titleNode.text ? { text: titleNode.text } : {}),
      label: composeLabel(titleTransform, components.titleLabel),
    } : undefined;
    rawPaths.push({ pathId, sourceName: group.name, anchor, ...(entry ? { entry } : {}), ...(title ? { title } : {}) });
    addTransformedRect(boundsItems, anchor, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, group.anchor);
    if (entry) addTransformedRect(boundsItems, entry, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, entryNode?.anchor);
    if (title) addTransformedRect(boundsItems, title, DEFAULT_TITLE_WIDTH, DEFAULT_TITLE_HEIGHT, titleNode?.anchor);
    if (title?.label) addTransformedRect(boundsItems, title.label.transform, title.label.width, title.label.height, title.label.anchor);
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

function worldFromDocument(documentRoot: CsbNode, csbPath: string, ordering: Map<number, string[]>, components: StoryComponentGeometry): {
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
    avatars: RawAvatar[];
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
    const pathAvatars: RawAvatar[] = [];
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
          anchor: child.anchor,
          width,
          height,
          label: composeLabel(transform, components.entryLabel),
          sourceName: child.name,
          artRef: packagePath(child.resourcePath ?? "layouts/story/StoryV2Entry.csb"),
          slot,
        });
        addTransformedRect(boundsItems, transform, width, height, child.anchor);
        addTransformedRect(boundsItems, composeLabel(transform, components.entryLabel).transform, components.entryLabel.width, components.entryLabel.height, components.entryLabel.anchor);
        void nodeKey;
      } else if (isTitleProjectNode(child)) {
        const titleLabel = composeLabel(transform, components.titleLabel);
        title = {
          ...transform,
          sourceName: child.name || "title",
          ...(child.text ? { text: child.text } : {}),
          label: titleLabel,
        };
        addTransformedRect(boundsItems, transform, DEFAULT_TITLE_WIDTH, DEFAULT_TITLE_HEIGHT, child.anchor);
        addTransformedRect(boundsItems, titleLabel.transform, titleLabel.width, titleLabel.height, titleLabel.anchor);
      } else if (isAvatarProjectNode(child)) {
        const match = /^chara_(\d+)$/u.exec(child.name);
        if (match) {
          const characterId = Number(match[1]);
          const avatarTransform = compose(transform, components.avatarVisual.transform);
          pathAvatars.push({
            transform: avatarTransform,
            characterId,
            sourceName: child.name,
            width: components.avatarVisual.width,
            height: components.avatarVisual.height,
            anchor: components.avatarVisual.anchor,
          });
          addTransformedRect(boundsItems, avatarTransform, components.avatarVisual.width, components.avatarVisual.height, components.avatarVisual.anchor);
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
        addTransformedRect(boundsItems, transform, DEFAULT_PORTAL_SIZE, DEFAULT_PORTAL_SIZE, child.anchor);
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
        .map((node): ArcaeaStoryAuthoredNodeType => {
          const nodeKey = (ordering.get(item.pathId) ?? [])[node.slot - 1] ?? "";
          return {
            ...normalizedNode(node, item.pathId, node.slot, { minX: bounds.minX, maxY: bounds.maxY }, nodeKey),
            nodeKey,
          };
        }),
      avatars: item.avatars.map((avatar): ArcaeaStoryAuthoredAvatarType => ({
        ...placement(avatar.transform, bounds.minX, bounds.maxY),
        characterId: avatar.characterId,
        sourceName: avatar.sourceName,
        width: avatar.width,
        height: avatar.height,
        anchorX: avatar.anchor.x,
        anchorY: avatar.anchor.y,
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
        anchor: item.node.anchor,
        width,
        height,
        sourceName: item.node.name,
        ...(resourcePathForNode(item.node) ? { artRef: resourcePathForNode(item.node) } : {}),
        slot,
      });
      addTransformedRect(boundsItems, item.transform, width, height, item.node.anchor);
    }
    const resource = item.node.resourcePath ?? item.node.normalPath;
    if (item.node.classname === "Sprite" && resource && /Finale-Divider/u.test(resource)) {
      const width = nodeDimension(item.node, "width", 12);
      const height = nodeDimension(item.node, "height", 12);
      rawLines.push({
        transform: item.transform,
        ...lineGeometry(item.node, item.transform, "y"),
        lineId: `finale-${rawLines.length}-${item.node.name || "divider"}`,
        sourceName: item.node.name || "divider",
        ...(resourcePathForNode(item.node) ? { resourcePath: resourcePathForNode(item.node) } : {}),
      });
      addTransformedRect(boundsItems, item.transform, width, height, item.node.anchor);
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
        labelMode: "baked",
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
  const rawNodes: Array<RawNode & { nodeId: string; displayLabel?: string }> = [];
  const rawLines: RawLine[] = [];
  const boundsItems: RawBoundsItem[] = [];
  for (const parent of documentRoot.children) {
    const button = findDescendants(parent, (node) => node.classname === "Button" && /Epilogue-[AB]\.png$/u.test(node.normalPath ?? ""))[0];
    if (!button) continue;
    const item = composeChildren(parent).find((entry) => entry.node === button);
    if (!item) continue;
    const parentTransform = sourceTransform(parent);
    const labelNode = findDescendants(parent, (node) => node.classname === "Text" && node.name === "label")[0];
    const label = labelNode ? rawLabel(labelNode, compose(parentTransform, sourceTransform(labelNode))) : undefined;
    const width = nodeDimension(button, "width", 420);
    const height = nodeDimension(button, "height", 350);
    rawNodes.push({
      transform: item.transform,
      anchor: button.anchor,
      width,
      height,
      sourceName: button.name || parent.name,
      ...(resourcePathForNode(button) ? { artRef: resourcePathForNode(button) } : {}),
      nodeId: parent.name || button.name || `epilogue-${rawNodes.length + 1}`,
      ...(label ? { label } : {}),
      ...(label?.text ? { displayLabel: label.text } : {}),
    });
    addTransformedRect(boundsItems, item.transform, width, height, button.anchor);
    if (label) addTransformedRect(boundsItems, label.transform, label.width, label.height, label.anchor);
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
      labelMode: "overlay",
      ...(node.displayLabel ? { label: node.displayLabel } : {}),
      ...(node.label ? { labelGeometry: normalizedLabel(node.label, { minX: bounds.minX, maxY: bounds.maxY }) } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
    })),
    lines: rawLines.map((line) => normalizedLine(line, { minX: bounds.minX, maxY: bounds.maxY })),
  };
}

type LayoutBox = { left: number; top: number; right: number; bottom: number };

function layoutBox(left: number, top: number, right: number, bottom: number): LayoutBox {
  return { left, top, right, bottom };
}

function unionLayoutBoxes(boxes: LayoutBox[]): LayoutBox {
  if (boxes.length === 0) return layoutBox(0, 0, 1, 1);
  return layoutBox(
    Math.min(...boxes.map((box) => box.left)),
    Math.min(...boxes.map((box) => box.top)),
    Math.max(...boxes.map((box) => box.right)),
    Math.max(...boxes.map((box) => box.bottom)),
  );
}

function authoredNodeBox(node: { x: number; y: number; scaleX: number; scaleY: number; rotation: number; width?: number; height?: number }): LayoutBox {
  const halfWidth = (node.width ?? DEFAULT_NODE_WIDTH) * Math.abs(node.scaleX) / 2;
  const halfHeight = (node.height ?? DEFAULT_NODE_HEIGHT) * Math.abs(node.scaleY) / 2;
  const radians = node.rotation * Math.PI / 180;
  const extentX = Math.abs(Math.cos(radians)) * halfWidth + Math.abs(Math.sin(radians)) * halfHeight;
  const extentY = Math.abs(Math.sin(radians)) * halfWidth + Math.abs(Math.cos(radians)) * halfHeight;
  return layoutBox(node.x - extentX, node.y - extentY, node.x + extentX, node.y + extentY);
}

function authoredLineBox(line: ArcaeaStoryAuthoredLineType): LayoutBox {
  const padding = Math.max(0.5, line.thickness / 2);
  return layoutBox(
    Math.min(line.x1, line.x2) - padding,
    Math.min(line.y1, line.y2) - padding,
    Math.max(line.x1, line.x2) + padding,
    Math.max(line.y1, line.y2) + padding,
  );
}

function transformPoint(point: CsbPoint, transform: { translateX: number; translateY: number; scale: number }): CsbPoint {
  return {
    x: transform.translateX + point.x * transform.scale,
    y: transform.translateY + point.y * transform.scale,
  };
}

function transformContinuationBox(bounds: { width: number; height: number }, transform: { translateX: number; translateY: number; scale: number }): LayoutBox {
  return layoutBox(
    transform.translateX,
    transform.translateY,
    transform.translateX + bounds.width * transform.scale,
    transform.translateY + bounds.height * transform.scale,
  );
}

function shiftAuthoredNode(node: ArcaeaStoryAuthoredNodeType, x: number, y: number): ArcaeaStoryAuthoredNodeType {
  return { ...node, x: node.x + x, y: node.y + y };
}

function shiftAuthoredLine(line: ArcaeaStoryAuthoredLineType, x: number, y: number): ArcaeaStoryAuthoredLineType {
  return {
    ...line,
    x: line.x + x,
    y: line.y + y,
    x1: line.x1 + x,
    y1: line.y1 + y,
    x2: line.x2 + x,
    y2: line.y2 + y,
  };
}

function forkLine(from: CsbPoint, to: CsbPoint, lineId: string, targetKey: string): ArcaeaStoryAuthoredLineType {
  const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
  return {
    x: from.x,
    y: from.y,
    scaleX: 1,
    scaleY: 1,
    rotation: Math.atan2(-(to.y - from.y), to.x - from.x) * 180 / Math.PI,
    lineId,
    length,
    thickness: 3,
    sourceName: "final-verdict-fork",
    width: length,
    height: 3,
    anchorX: 0,
    anchorY: 0.5,
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    from: "F-7",
    to: targetKey,
    kind: "branch",
    pathId: 19,
  };
}

function composeFinaleSubworld(finale: ReturnType<typeof finaleSubworld>, continuation: ReturnType<typeof epilogueContinuation>): {
  bounds: { width: number; height: number };
  nodes: ArcaeaStoryAuthoredNodeType[];
  lines: ArcaeaStoryAuthoredLineType[];
  continuation: ReturnType<typeof epilogueContinuation>;
  composite: ArcaeaStoryAuthoredCompositeType;
} {
  const f7 = finale.nodes.find((node) => node.nodeKey === "F-7");
  const oneLastDream = continuation.nodes.find((node) => node.nodeId === "epilogue_a");
  if (!f7 || !oneLastDream) {
    return {
      bounds: finale.bounds,
      nodes: finale.nodes,
      lines: finale.lines,
      continuation,
      composite: {
        epilogueTransform: { translateX: 0, translateY: 0, scale: 1 },
        forkLines: [],
      },
    };
  }
  const scale = EPILOGUE_COMPOSITE_SCALE;
  const f7Top = f7.y - (f7.height ?? DEFAULT_NODE_HEIGHT) * Math.abs(f7.scaleY) / 2;
  const translateX = f7.x + EPILOGUE_FORK_X_OFFSET - oneLastDream.x * scale;
  const translateY = f7Top - EPILOGUE_FORK_GAP
    - (oneLastDream.y * scale + (oneLastDream.height ?? DEFAULT_NODE_HEIGHT) * scale / 2);
  const preTransform = { translateX, translateY, scale };
  const endingPoints = continuation.nodes.map((node) => {
    const point = transformPoint({ x: node.x, y: node.y }, preTransform);
    return {
      node,
      point,
      bottom: point.y + (node.height ?? DEFAULT_NODE_HEIGHT) * scale * Math.abs(node.scaleY) / 2,
    };
  });
  const forkStart = { x: f7.x, y: f7Top };
  const forkLines = endingPoints.map((ending, index) => forkLine(
    forkStart,
    { x: ending.point.x, y: ending.bottom },
    "final-verdict-fork-" + (index + 1),
    ending.node.nodeId === "epilogue_a" ? "E-1" : "E-2",
  ));
  const bounds = unionLayoutBoxes([
    layoutBox(0, 0, finale.bounds.width, finale.bounds.height),
    transformContinuationBox(continuation.bounds, preTransform),
    ...forkLines.map(authoredLineBox),
  ]);
  const offsetX = -bounds.left;
  const offsetY = -bounds.top;
  const compositeTransform = {
    translateX: translateX + offsetX,
    translateY: translateY + offsetY,
    scale,
  };
  return {
    bounds: {
      width: Math.max(1, bounds.right + offsetX),
      height: Math.max(1, bounds.bottom + offsetY),
    },
    nodes: finale.nodes.map((node) => shiftAuthoredNode(node, offsetX, offsetY)),
    lines: finale.lines.map((line) => shiftAuthoredLine(line, offsetX, offsetY)),
    continuation,
    composite: {
      epilogueTransform: compositeTransform,
      forkLines: forkLines.map((line) => shiftAuthoredLine(line, offsetX, offsetY)),
    },
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
  const componentGeometry = await loadStoryComponentGeometry(packageRoot);
  const sections = [];
  const csbPaths: string[] = [
    "assets/layouts/story/StoryV2Entry.csb",
    "assets/layouts/story/StoryV2CharaPointerNode.csb",
    "assets/layouts/story/StoryV2TitleButton.csb",
    "assets/layouts/story/StoryV2EntryFinale.csb",
  ];

  for (let sectionAct = 0; sectionAct < PARTS.length; sectionAct += 1) {
    const part = PARTS[sectionAct];
    if (!part) throw new Error(`Missing CSB part at index ${sectionAct}`);
    const overviewPath = `assets/app-data/story2/${part.overview}`;
    const worldPath = `assets/app-data/story2/${part.world}`;
    const overviewDocument = await readCsbFile(path.join(packageRoot, overviewPath));
    const worldDocument = await readCsbFile(path.join(packageRoot, worldPath));
    const overview = overviewFromDocument(overviewDocument.root, componentGeometry);
    const world = worldFromDocument(worldDocument.root, worldPath, ordering, componentGeometry);
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
  const composite = composeFinaleSubworld(finale, continuation);
  csbPaths.push(finalePath, epiloguePath);

  return ArcaeaStoryLayout.parse({
    schemaVersion: ARCAEA_STORY_LAYOUT_SCHEMA_VERSION,
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
      bounds: composite.bounds,
      titlePlacement: {
        x: composite.bounds.width / 2,
        y: 48,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        sourceName: "final-verdict-title",
        text: "Final Verdict",
      },
      nodes: composite.nodes,
      lines: composite.lines,
      continuation: composite.continuation,
      composite: composite.composite,
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
