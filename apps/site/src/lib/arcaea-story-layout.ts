import type {
  ArcaeaStoryAuthoredContinuationType,
  ArcaeaStoryCompositeTransformType,
  ArcaeaStoryAuthoredLineType,
  ArcaeaStoryAuthoredNodeType,
  ArcaeaStoryAuthoredPortalType,
  ArcaeaStoryAuthoredSubworldType,
  ArcaeaStoryLayoutType,
} from "../../../../packages/domain/src/browse";
import type { ArcaeaStoryExplorerConnection, ArcaeaStoryExplorerPath, ArcaeaStoryExplorerSection, ArcaeaStoryExplorerModel } from "./arcaea-story-explorer";

export type StoryAtlasPoint = { x: number; y: number };
export type StoryAtlasBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};
export type StoryAtlasOrientation = "horizontal" | "compact-horizontal" | "vertical" | "branch-horizontal" | "stepped";
export type StoryAtlasNodeTransform = {
  scaleX: number;
  scaleY: number;
  rotation: number;
  width: number;
  height: number;
  artRef?: string;
};
export type StoryAtlasLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  lineId?: string;
  sourceName?: string;
  resourcePath?: string;
  provenance: "authored-csb" | "sequential-fallback";
  pathIds: number[];
  from?: string;
  to?: string;
  kind?: "linear" | "branch" | "merge";
  external?: boolean;
};
export type StoryAtlasAvatar = { id: number; x: number; y: number; pathId: number; label: string };
export type StoryAtlasScenePoint = { sceneId: string; x: number; y: number; kind: string; title: string };
export type StoryAtlasPortal = {
  portalId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  sourceName: string;
  artRef?: string;
};
export type StoryAtlasPathLayout = {
  path: ArcaeaStoryExplorerPath;
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: StoryAtlasOrientation;
  bounds: StoryAtlasBounds;
  interactiveBounds: StoryAtlasBounds;
  title?: StoryAtlasPoint;
  titleBounds?: StoryAtlasBounds;
  nodes: Record<string, StoryAtlasPoint>;
  nodeBounds: Record<string, StoryAtlasBounds>;
  nodeTransforms: Record<string, StoryAtlasNodeTransform>;
  avatars: StoryAtlasAvatar[];
  avatarBounds: StoryAtlasBounds[];
  scenes: StoryAtlasScenePoint[];
  sceneBounds: Record<string, StoryAtlasBounds>;
};
export type StoryAtlasOverviewPath = {
  pathId: number;
  point: StoryAtlasPoint;
  titlePoint?: StoryAtlasPoint;
};
export type StoryAtlasContinuationLayout = {
  continuation: ArcaeaStoryAuthoredContinuationType;
  bounds: StoryAtlasBounds;
  nodes: Record<string, StoryAtlasPoint>;
  nodeBounds: Record<string, StoryAtlasBounds>;
  nodeTransforms: Record<string, StoryAtlasNodeTransform>;
  lines: StoryAtlasLine[];
};
export type StoryAtlasSubworldLayout = {
  subworld: ArcaeaStoryAuthoredSubworldType;
  width: number;
  height: number;
  worldBounds: StoryAtlasBounds;
  title: StoryAtlasPoint;
  titleBounds: StoryAtlasBounds;
  nodes: Record<string, StoryAtlasPoint>;
  nodeBounds: Record<string, StoryAtlasBounds>;
  nodeTransforms: Record<string, StoryAtlasNodeTransform>;
  lines: StoryAtlasLine[];
  continuation?: StoryAtlasContinuationLayout;
  initialCamera: { x: number; y: number; scale: number };
};
export type StoryAtlasLayout = {
  layoutSource: "authored-csb" | "fallback-generated";
  sectionAct: number;
  width: number;
  height: number;
  worldBounds: StoryAtlasBounds;
  overview: {
    csbPath?: string;
    bounds: StoryAtlasBounds;
    paths: StoryAtlasOverviewPath[];
  };
  paths: StoryAtlasPathLayout[];
  lines: StoryAtlasLine[];
  portals: StoryAtlasPortal[];
  initialCamera: { x: number; y: number; scale: number };
};

const DEFAULT_NODE_WIDTH = 193;
const DEFAULT_NODE_HEIGHT = 193;
const DEFAULT_TITLE_WIDTH = 300;
const DEFAULT_TITLE_HEIGHT = 72;
const DEFAULT_AVATAR_SIZE = 72;
const DEFAULT_SCENE_WIDTH = 180;
const DEFAULT_SCENE_HEIGHT = 64;
const DEFAULT_PORTAL_SIZE = 260;

export function boundsIntersect(left: StoryAtlasBounds, right: StoryAtlasBounds, gap = 0): boolean {
  return left.left < right.right + gap
    && left.right + gap > right.left
    && left.top < right.bottom + gap
    && left.bottom + gap > right.top;
}

export function boundsContains(outer: StoryAtlasBounds, inner: StoryAtlasBounds): boolean {
  return inner.left >= outer.left
    && inner.top >= outer.top
    && inner.right <= outer.right
    && inner.bottom <= outer.bottom;
}

function makeBounds(left: number, top: number, width: number, height: number): StoryAtlasBounds {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function unionBounds(bounds: StoryAtlasBounds[]): StoryAtlasBounds {
  if (bounds.length === 0) return makeBounds(0, 0, 1, 1);
  const left = Math.min(...bounds.map((item) => item.left));
  const top = Math.min(...bounds.map((item) => item.top));
  const right = Math.max(...bounds.map((item) => item.right));
  const bottom = Math.max(...bounds.map((item) => item.bottom));
  return makeBounds(left, top, right - left, bottom - top);
}

function pointFromPlacement(item: { x: number; y: number }): StoryAtlasPoint {
  return { x: item.x, y: item.y };
}

function nodeTransform(item: ArcaeaStoryAuthoredNodeType, fallbackWidth = DEFAULT_NODE_WIDTH, fallbackHeight = DEFAULT_NODE_HEIGHT): StoryAtlasNodeTransform {
  return {
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    rotation: item.rotation,
    width: item.width ?? fallbackWidth,
    height: item.height ?? fallbackHeight,
    ...(item.artRef ? { artRef: item.artRef } : {}),
  };
}

function nodeBounds(point: StoryAtlasPoint, transform: StoryAtlasNodeTransform): StoryAtlasBounds {
  const halfWidth = transform.width * Math.abs(transform.scaleX) / 2;
  const halfHeight = transform.height * Math.abs(transform.scaleY) / 2;
  const radians = transform.rotation * Math.PI / 180;
  const extentX = Math.abs(Math.cos(radians)) * halfWidth + Math.abs(Math.sin(radians)) * halfHeight;
  const extentY = Math.abs(Math.sin(radians)) * halfWidth + Math.abs(Math.cos(radians)) * halfHeight;
  return makeBounds(point.x - extentX, point.y - extentY, extentX * 2, extentY * 2);
}

function titleBounds(point: StoryAtlasPoint): StoryAtlasBounds {
  return makeBounds(point.x - DEFAULT_TITLE_WIDTH / 2, point.y - DEFAULT_TITLE_HEIGHT / 2, DEFAULT_TITLE_WIDTH, DEFAULT_TITLE_HEIGHT);
}

function authoredLine(item: ArcaeaStoryAuthoredLineType): StoryAtlasLine {
  return {
    x1: item.x1,
    y1: item.y1,
    x2: item.x2,
    y2: item.y2,
    thickness: item.thickness,
    lineId: item.lineId,
    sourceName: item.sourceName,
    ...(item.resourcePath ? { resourcePath: item.resourcePath } : {}),
    provenance: "authored-csb",
    pathIds: item.pathId === undefined ? [] : [item.pathId],
    ...(item.from ? { from: item.from } : {}),
    ...(item.to ? { to: item.to } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
  };
}

function authoredPortal(item: ArcaeaStoryAuthoredPortalType): StoryAtlasPortal {
  return {
    portalId: item.portalId,
    x: item.x,
    y: item.y,
    width: item.width ?? DEFAULT_PORTAL_SIZE,
    height: item.height ?? DEFAULT_PORTAL_SIZE,
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    rotation: item.rotation,
    sourceName: item.sourceName,
    ...(item.artRef ? { artRef: item.artRef } : {}),
  };
}

function pathScenes(path: ArcaeaStoryExplorerPath, lastPoint: StoryAtlasPoint): { scenes: StoryAtlasScenePoint[]; bounds: StoryAtlasBounds[] } {
  return {
    scenes: path.pathScenes.map((scene, index) => ({
      sceneId: scene.sceneId,
      x: lastPoint.x + 170 + index * (DEFAULT_SCENE_WIDTH + 24),
      y: lastPoint.y,
      kind: scene.kind,
      title: scene.displayTitle ?? scene.sceneId,
    })),
    bounds: path.pathScenes.map((_, index) => makeBounds(lastPoint.x + 170 + index * (DEFAULT_SCENE_WIDTH + 24) - DEFAULT_SCENE_WIDTH / 2, lastPoint.y - DEFAULT_SCENE_HEIGHT / 2, DEFAULT_SCENE_WIDTH, DEFAULT_SCENE_HEIGHT)),
  };
}

function makePathLayout(path: ArcaeaStoryExplorerPath, points: Record<string, StoryAtlasPoint>, transforms: Record<string, StoryAtlasNodeTransform>, avatars: StoryAtlasAvatar[], scenes: StoryAtlasScenePoint[], sceneBoundValues: StoryAtlasBounds[], title?: StoryAtlasPoint, titleBound?: StoryAtlasBounds): StoryAtlasPathLayout {
  const fallbackTransform: StoryAtlasNodeTransform = { scaleX: 1, scaleY: 1, rotation: 0, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  const nodeBoundValues = Object.entries(points).map(([key, point]) => nodeBounds(point, transforms[key] ?? fallbackTransform));
  const bounds = unionBounds([...nodeBoundValues, ...avatars.map((avatar) => makeBounds(avatar.x - DEFAULT_AVATAR_SIZE / 2, avatar.y - DEFAULT_AVATAR_SIZE / 2, DEFAULT_AVATAR_SIZE, DEFAULT_AVATAR_SIZE)), ...sceneBoundValues, ...(titleBound ? [titleBound] : [])]);
  const padded = makeBounds(bounds.left - 34, bounds.top - 34, bounds.width + 68, bounds.height + 68);
  const nodeBoundRecord: Record<string, StoryAtlasBounds> = {};
  for (const [key, point] of Object.entries(points)) nodeBoundRecord[key] = nodeBounds(point, transforms[key] ?? fallbackTransform);
  const sceneBoundRecord: Record<string, StoryAtlasBounds> = {};
  for (const [index, scene] of scenes.entries()) {
    const bound = sceneBoundValues[index];
    if (bound) sceneBoundRecord[scene.sceneId] = bound;
  }
  return {
    path,
    x: padded.left,
    y: padded.top,
    width: padded.width,
    height: padded.height,
    orientation: "horizontal",
    bounds: padded,
    interactiveBounds: padded,
    ...(title ? { title } : {}),
    ...(titleBound ? { titleBounds: titleBound } : {}),
    nodes: points,
    nodeBounds: nodeBoundRecord,
    nodeTransforms: transforms,
    avatars,
    avatarBounds: avatars.map((avatar) => makeBounds(avatar.x - DEFAULT_AVATAR_SIZE / 2, avatar.y - DEFAULT_AVATAR_SIZE / 2, DEFAULT_AVATAR_SIZE, DEFAULT_AVATAR_SIZE)),
    scenes,
    sceneBounds: sceneBoundRecord,
  };
}

function initialCamera(section: ArcaeaStoryExplorerSection, paths: StoryAtlasPathLayout[], worldBounds: StoryAtlasBounds): { x: number; y: number; scale: number } {
  const mainPaths = section.paths
    .filter((path) => path.type === "main")
    .map((path) => paths.find((layout) => layout.path.pathId === path.pathId))
    .filter((value): value is StoryAtlasPathLayout => value !== undefined);
  const focusPaths = (mainPaths.length > 0 ? mainPaths : paths).slice(0, 3);
  const points = focusPaths.flatMap((path) => Object.values(path.nodes));
  if (points.length === 0) return { x: worldBounds.width / 2, y: worldBounds.height / 2, scale: 0.78 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    scale: 0.78,
  };
}

function authoredOverview(layout: ArcaeaStoryLayoutType, sectionAct: number): StoryAtlasLayout["overview"] {
  const source = layout.sections.find((section) => section.sectionAct === sectionAct)?.overview;
  if (!source) return { bounds: makeBounds(0, 0, 1, 1), paths: [] };
  return {
    csbPath: source.csbPath,
    bounds: makeBounds(0, 0, source.bounds.width, source.bounds.height),
    paths: source.paths.map((path) => ({
      pathId: path.pathId,
      point: pointFromPlacement(path.entry ?? path.anchor),
      ...(path.title ? { titlePoint: pointFromPlacement(path.title) } : {}),
    })),
  };
}

function buildAuthoredLayout(section: ArcaeaStoryExplorerSection, authored: ArcaeaStoryLayoutType["sections"][number], layout: ArcaeaStoryLayoutType): StoryAtlasLayout {
  const paths: StoryAtlasPathLayout[] = [];
  for (const authoredPath of authored.world.paths) {
    if (authoredPath.pathId === 19 && authored.world.portals.length > 0) continue;
    const storyPath = section.paths.find((path) => path.pathId === authoredPath.pathId);
    if (!storyPath) continue;
    const points: Record<string, StoryAtlasPoint> = {};
    const transforms: Record<string, StoryAtlasNodeTransform> = {};
    for (const node of authoredPath.nodes) {
      if (!node.nodeKey || !storyPath.entries.some((entry) => entry.key === node.nodeKey)) continue;
      points[node.nodeKey] = pointFromPlacement(node);
      transforms[node.nodeKey] = nodeTransform(node);
    }
    const title = authoredPath.title ? pointFromPlacement(authoredPath.title) : undefined;
    const titleBound = title ? titleBounds(title) : undefined;
    const last = [...Object.values(points)].at(-1) ?? pointFromPlacement(authoredPath.anchor);
    const sceneResult = pathScenes(storyPath, last);
    const avatars = authoredPath.avatars.map((avatar) => ({
      id: avatar.characterId,
      x: avatar.x,
      y: avatar.y,
      pathId: authoredPath.pathId,
      label: storyPath.title,
    }));
    paths.push(makePathLayout(storyPath, points, transforms, avatars, sceneResult.scenes, sceneResult.bounds, title, titleBound));
  }
  const worldBounds = makeBounds(0, 0, authored.world.bounds.width, authored.world.bounds.height);
  return {
    layoutSource: "authored-csb",
    sectionAct: section.act,
    width: Math.ceil(worldBounds.width),
    height: Math.ceil(worldBounds.height),
    worldBounds,
    overview: authoredOverview(layout, section.act),
    paths,
    lines: authored.world.lines.map(authoredLine),
    portals: authored.world.portals.map(authoredPortal),
    initialCamera: initialCamera(section, paths, worldBounds),
  };
}

function fallbackLine(connection: ArcaeaStoryExplorerConnection, points: Map<string, StoryAtlasPoint>, pathIds: number[], external: boolean): StoryAtlasLine | undefined {
  const from = points.get(connection.from);
  const to = points.get(connection.to);
  if (!from || !to) return undefined;
  return {
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    thickness: 3,
    from: connection.from,
    to: connection.to,
    kind: connection.kind,
    provenance: "sequential-fallback",
    pathIds,
    ...(external ? { external: true } : {}),
  };
}

function buildFallbackLayout(section: ArcaeaStoryExplorerSection): StoryAtlasLayout {
  const paths: StoryAtlasPathLayout[] = [];
  const allPoints = new Map<string, StoryAtlasPoint>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(section.paths.length)));
  for (const [index, storyPath] of section.paths.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const points: Record<string, StoryAtlasPoint> = {};
    const transforms: Record<string, StoryAtlasNodeTransform> = {};
    for (const [entryIndex, entry] of storyPath.entries.entries()) {
      const point = { x: 180 + column * 880 + entryIndex * 230, y: 180 + row * 420 + (entryIndex % 2) * 48 };
      points[entry.key] = point;
      transforms[entry.key] = { scaleX: 1, scaleY: 1, rotation: 0, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
      allPoints.set(entry.key, point);
    }
    const last = [...Object.values(points)].at(-1) ?? { x: 180, y: 180 };
    const scenes = pathScenes(storyPath, last);
    const title = { x: Object.values(points)[0]?.x ?? last.x, y: last.y - 150 };
    paths.push(makePathLayout(storyPath, points, transforms, [], scenes.scenes, scenes.bounds, title, titleBounds(title)));
  }
  const lines: StoryAtlasLine[] = [];
  for (const storyPath of section.paths) {
    for (const connection of [...storyPath.connections, ...storyPath.externalConnections]) {
      const line = fallbackLine(connection, allPoints, [storyPath.pathId], connection.external);
      if (line) lines.push(line);
    }
  }
  const contentBounds = unionBounds(paths.map((path) => path.interactiveBounds));
  const width = Math.ceil(contentBounds.right + 180);
  const height = Math.ceil(contentBounds.bottom + 180);
  const worldBounds = makeBounds(0, 0, width, height);
  return {
    layoutSource: "fallback-generated",
    sectionAct: section.act,
    width,
    height,
    worldBounds,
    overview: { bounds: makeBounds(0, 0, 1, 1), paths: [] },
    paths,
    lines,
    portals: [],
    initialCamera: initialCamera(section, paths, worldBounds),
  };
}

export function buildArcaeaStoryAtlasLayout(section: ArcaeaStoryExplorerSection, storyAtlas?: ArcaeaStoryExplorerModel["storyAtlas"]): StoryAtlasLayout {
  const authored = storyAtlas?.layout?.sections.find((item) => item.sectionAct === section.act);
  return authored && storyAtlas?.layout ? buildAuthoredLayout(section, authored, storyAtlas.layout) : buildFallbackLayout(section);
}

function continuationLayout(continuation: ArcaeaStoryAuthoredContinuationType, transform: ArcaeaStoryCompositeTransformType = { translateX: 0, translateY: 0, scale: 1 }): StoryAtlasContinuationLayout {
  const nodes: Record<string, StoryAtlasPoint> = {};
  const transforms: Record<string, StoryAtlasNodeTransform> = {};
  const bounds: Record<string, StoryAtlasBounds> = {};
  for (const node of continuation.nodes) {
    const point = {
      x: transform.translateX + node.x * transform.scale,
      y: transform.translateY + node.y * transform.scale,
    };
    nodes[node.nodeId] = point;
    transforms[node.nodeId] = {
      scaleX: node.scaleX * transform.scale,
      scaleY: node.scaleY * transform.scale,
      rotation: node.rotation,
      width: node.width ?? 420,
      height: node.height ?? 350,
      ...(node.artRef ? { artRef: node.artRef } : {}),
    };
    bounds[node.nodeId] = nodeBounds(point, transforms[node.nodeId]!);
  }
  return {
    continuation,
    bounds: makeBounds(transform.translateX, transform.translateY, continuation.bounds.width * transform.scale, continuation.bounds.height * transform.scale),
    nodes,
    nodeBounds: bounds,
    nodeTransforms: transforms,
    lines: continuation.lines.map((line) => {
      const authored = authoredLine(line);
      return {
        ...authored,
        x1: transform.translateX + authored.x1 * transform.scale,
        y1: transform.translateY + authored.y1 * transform.scale,
        x2: transform.translateX + authored.x2 * transform.scale,
        y2: transform.translateY + authored.y2 * transform.scale,
        thickness: authored.thickness * transform.scale,
      };
    }),
  };
}

export function buildArcaeaStorySubworldLayout(subworld: ArcaeaStoryAuthoredSubworldType): StoryAtlasSubworldLayout {
  const nodes: Record<string, StoryAtlasPoint> = {};
  const transforms: Record<string, StoryAtlasNodeTransform> = {};
  const bounds: Record<string, StoryAtlasBounds> = {};
  for (const node of subworld.nodes) {
    const point = pointFromPlacement(node);
    nodes[node.nodeKey] = point;
    transforms[node.nodeKey] = nodeTransform(node, node.width ?? DEFAULT_NODE_WIDTH, node.height ?? DEFAULT_NODE_HEIGHT);
    bounds[node.nodeKey] = nodeBounds(point, transforms[node.nodeKey]!);
  }
  const title = subworld.titlePlacement ? pointFromPlacement(subworld.titlePlacement) : { x: subworld.bounds.width / 2, y: 48 };
  const continuation = subworld.continuation
    ? continuationLayout(subworld.continuation, subworld.composite?.epilogueTransform)
    : undefined;
  const lines = [
    ...subworld.lines.map(authoredLine),
    ...(subworld.composite?.forkLines ?? []).map(authoredLine),
    ...(continuation?.lines ?? []),
  ];
  const initialNode = nodes["F-7"] ?? Object.values(nodes)[0] ?? { x: subworld.bounds.width / 2, y: subworld.bounds.height / 2 };
  return {
    subworld,
    width: Math.ceil(subworld.bounds.width),
    height: Math.ceil(subworld.bounds.height),
    worldBounds: makeBounds(0, 0, subworld.bounds.width, subworld.bounds.height),
    title,
    titleBounds: titleBounds(title),
    nodes,
    nodeBounds: bounds,
    nodeTransforms: transforms,
    lines,
    ...(continuation ? { continuation } : {}),
    initialCamera: { x: initialNode.x, y: initialNode.y, scale: 0.78 },
  };
}
