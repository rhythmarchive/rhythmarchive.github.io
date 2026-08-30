import type { ArcaeaStoryExplorerConnection, ArcaeaStoryExplorerPath, ArcaeaStoryExplorerSection } from "./arcaea-story-explorer";

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
export type StoryAtlasLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  from: string;
  to: string;
  kind: "linear" | "branch" | "merge";
  provenance: "audited" | "sequential-fallback";
  pathIds: number[];
  external?: boolean;
};
export type StoryAtlasAvatar = { id: number; x: number; y: number; pathId: number; label: string };
export type StoryAtlasScenePoint = { sceneId: string; x: number; y: number; kind: string; title: string };
export type StoryAtlasPathLayout = {
  path: ArcaeaStoryExplorerPath;
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: StoryAtlasOrientation;
  bounds: StoryAtlasBounds;
  interactiveBounds: StoryAtlasBounds;
  title: StoryAtlasPoint;
  titleBounds: StoryAtlasBounds;
  nodes: Record<string, StoryAtlasPoint>;
  nodeBounds: Record<string, StoryAtlasBounds>;
  avatars: StoryAtlasAvatar[];
  avatarBounds: StoryAtlasBounds[];
  scenes: StoryAtlasScenePoint[];
  sceneBounds: Record<string, StoryAtlasBounds>;
};
export type StoryAtlasLayout = {
  sectionAct: number;
  width: number;
  height: number;
  worldBounds: StoryAtlasBounds;
  paths: StoryAtlasPathLayout[];
  lines: StoryAtlasLine[];
  initialCamera: { x: number; y: number; scale: number };
};

const PATH_PADDING = 34;
const WORLD_MARGIN = 120;
const PATH_GAP = 86;
const NODE_HALF_WIDTH = 60;
const NODE_HALF_HEIGHT = 56;
const AVATAR_HALF_WIDTH = 52;
const AVATAR_HALF_HEIGHT = 56;
const SCENE_HALF_WIDTH = 96;
const SCENE_HALF_HEIGHT = 38;

// These are only content-layout hints. They are not Story facts and can be
// changed without touching the semantic projection.
const LAYOUT_OVERRIDES: Partial<Record<number, StoryAtlasOrientation>> = {
  1: "branch-horizontal", // Eternal Core
  2: "branch-horizontal", // Vicious Labyrinth
  8: "branch-horizontal", // Black Fate
  19: "branch-horizontal", // Final Verdict
  27: "branch-horizontal", // Absolute Nihil
  32: "stepped", // Liminal Eclipse
  33: "stepped", // Divine Oblivion
};

const CLUSTER_ANCHORS: StoryAtlasPoint[] = [
  { x: 100, y: 100 },
  { x: 1250, y: 100 },
  { x: 2400, y: 100 },
  { x: 120, y: 720 },
  { x: 1450, y: 720 },
  { x: 2700, y: 720 },
  { x: 520, y: 1400 },
  { x: 1900, y: 1400 },
];

const SEARCH_DIRECTIONS: StoryAtlasPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
];

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

export function buildArcaeaStoryAtlasLayout(section: ArcaeaStoryExplorerSection): StoryAtlasLayout {
  const localLayouts = section.paths.map(buildPathLayout);
  const clusterOrder = new Map<string, number>();
  const clusterCounts = new Map<string, number>();
  for (const storyPath of section.paths) {
    const key = clusterKey(storyPath);
    if (!clusterOrder.has(key)) clusterOrder.set(key, clusterOrder.size);
  }

  const placed: StoryAtlasPathLayout[] = [];
  for (const [index, local] of localLayouts.entries()) {
    const key = clusterKey(local.path);
    const clusterIndex = clusterOrder.get(key) ?? index;
    const clusterOffset = clusterCounts.get(key) ?? 0;
    clusterCounts.set(key, clusterOffset + 1);
    const anchor = CLUSTER_ANCHORS[(clusterIndex + section.act) % CLUSTER_ANCHORS.length] ?? CLUSTER_ANCHORS[0]!;
    const seed = {
      x: anchor.x,
      y: anchor.y + clusterOffset * (local.height + PATH_GAP + 44),
    };
    placed.push(resolveCollision(translatePath(local, seed.x, seed.y), placed));
  }

  const minLeft = Math.min(0, ...placed.map((pathLayout) => pathLayout.interactiveBounds.left));
  const minTop = Math.min(0, ...placed.map((pathLayout) => pathLayout.interactiveBounds.top));
  const shiftX = WORLD_MARGIN - minLeft;
  const shiftY = WORLD_MARGIN - minTop;
  const paths = placed.map((pathLayout) => translatePath(pathLayout, pathLayout.x + shiftX, pathLayout.y + shiftY));
  const maxRight = Math.max(WORLD_MARGIN, ...paths.map((pathLayout) => pathLayout.interactiveBounds.right));
  const maxBottom = Math.max(WORLD_MARGIN, ...paths.map((pathLayout) => pathLayout.interactiveBounds.bottom));
  const width = Math.ceil(maxRight + WORLD_MARGIN);
  const height = Math.ceil(maxBottom + WORLD_MARGIN);
  const worldBounds = makeBounds(0, 0, width, height);
  const pointByNode = new Map<string, StoryAtlasPoint>();
  const pathByNode = new Map<string, number>();
  for (const pathLayout of paths) {
    for (const [nodeKey, point] of Object.entries(pathLayout.nodes)) {
      pointByNode.set(nodeKey, point);
      pathByNode.set(nodeKey, pathLayout.path.pathId);
    }
  }

  const lines: StoryAtlasLine[] = [];
  const lineKeys = new Set<string>();
  for (const pathLayout of paths) {
    for (const connection of [...pathLayout.path.connections, ...pathLayout.path.externalConnections]) {
      const external = connection.external;
      const key = connection.from + "|" + connection.to + "|" + connection.kind + "|" + external;
      if (lineKeys.has(key)) continue;
      lineKeys.add(key);
      const line = lineForConnection(connection, pointByNode, pathByNode, pathLayout.path.pathId, external);
      if (line) lines.push(line);
    }
  }

  return {
    sectionAct: section.act,
    width,
    height,
    worldBounds,
    paths,
    lines,
    initialCamera: { x: width / 2, y: height / 2, scale: 0.82 },
  };
}

type LocalPathLayout = StoryAtlasPathLayout;

function buildPathLayout(storyPath: ArcaeaStoryExplorerPath): LocalPathLayout {
  const orientation = chooseOrientation(storyPath);
  const nodes: Record<string, StoryAtlasPoint> = {};
  const nodeBounds: Record<string, StoryAtlasBounds> = {};
  const nodePositions = nodePositionsFor(storyPath, orientation);
  for (const [index, entry] of storyPath.entries.entries()) {
    const point = nodePositions[index] ?? { x: 80, y: 190 };
    nodes[entry.key] = point;
    nodeBounds[entry.key] = makeBounds(point.x - NODE_HALF_WIDTH, point.y - NODE_HALF_HEIGHT, NODE_HALF_WIDTH * 2, NODE_HALF_HEIGHT * 2);
  }

  const avatarPositions = avatarPositionsFor(storyPath.characterIds);
  const avatars = storyPath.characterIds.map((id, index) => ({
    id,
    x: avatarPositions[index]?.x ?? 54,
    y: avatarPositions[index]?.y ?? 62,
    pathId: storyPath.pathId,
    label: storyPath.title,
  }));
  const avatarBounds = avatars.map((avatar) => makeBounds(avatar.x - AVATAR_HALF_WIDTH, avatar.y - AVATAR_HALF_HEIGHT, AVATAR_HALF_WIDTH * 2, AVATAR_HALF_HEIGHT * 2));

  const titleWidth = Math.max(220, Math.min(370, 220 + Math.max(0, storyPath.title.length - 12) * 5));
  const avatarColumns = Math.min(3, Math.max(1, storyPath.characterIds.length));
  const titleLeft = storyPath.characterIds.length > 0 ? avatarColumns * 82 + 28 : 28;
  const titleBounds = makeBounds(titleLeft, 24, titleWidth, 68);
  const title = { x: titleBounds.left + titleBounds.width / 2, y: titleBounds.top + titleBounds.height / 2 };

  const maxNodeRight = Math.max(120, ...Object.values(nodeBounds).map((bounds) => bounds.right));
  const maxNodeBottom = Math.max(210, ...Object.values(nodeBounds).map((bounds) => bounds.bottom));
  const sceneStartX = Math.max(130, Math.min(maxNodeRight + 30, maxNodeRight - 40));
  const scenes = storyPath.pathScenes.map((scene, index) => ({
    sceneId: scene.sceneId,
    x: sceneStartX + index * (SCENE_HALF_WIDTH * 2 + 20),
    y: maxNodeBottom + 70,
    kind: scene.kind,
    title: scene.displayTitle ?? scene.sceneId,
  }));
  const sceneBounds: Record<string, StoryAtlasBounds> = {};
  for (const scene of scenes) {
    sceneBounds[scene.sceneId] = makeBounds(scene.x - SCENE_HALF_WIDTH, scene.y - SCENE_HALF_HEIGHT, SCENE_HALF_WIDTH * 2, SCENE_HALF_HEIGHT * 2);
  }

  const contentBounds = unionBounds([
    titleBounds,
    ...Object.values(nodeBounds),
    ...avatarBounds,
    ...Object.values(sceneBounds),
  ]);
  const shiftX = PATH_PADDING - contentBounds.left;
  const shiftY = PATH_PADDING - contentBounds.top;
  const translatedNodes = mapPoints(nodes, shiftX, shiftY);
  const translatedNodeBounds = mapBoundsRecord(nodeBounds, shiftX, shiftY);
  const translatedAvatars = avatars.map((avatar) => ({ ...avatar, x: avatar.x + shiftX, y: avatar.y + shiftY }));
  const translatedAvatarBounds = avatarBounds.map((bounds) => shiftBounds(bounds, shiftX, shiftY));
  const translatedScenes = scenes.map((scene) => ({ ...scene, x: scene.x + shiftX, y: scene.y + shiftY }));
  const translatedSceneBounds = mapBoundsRecord(sceneBounds, shiftX, shiftY);
  const translatedTitleBounds = shiftBounds(titleBounds, shiftX, shiftY);
  const translatedTitle = { x: title.x + shiftX, y: title.y + shiftY };
  const translatedContent = shiftBounds(contentBounds, shiftX, shiftY);
  const width = Math.ceil(translatedContent.right + PATH_PADDING);
  const height = Math.ceil(translatedContent.bottom + PATH_PADDING);
  const bounds = makeBounds(0, 0, width, height);

  return {
    path: storyPath,
    x: 0,
    y: 0,
    width,
    height,
    orientation,
    bounds,
    interactiveBounds: bounds,
    title: translatedTitle,
    titleBounds: translatedTitleBounds,
    nodes: translatedNodes,
    nodeBounds: translatedNodeBounds,
    avatars: translatedAvatars,
    avatarBounds: translatedAvatarBounds,
    scenes: translatedScenes,
    sceneBounds: translatedSceneBounds,
  };
}

function chooseOrientation(storyPath: ArcaeaStoryExplorerPath): StoryAtlasOrientation {
  const override = LAYOUT_OVERRIDES[storyPath.pathId];
  if (override) return override;
  const hasBranchOrMerge = [...storyPath.connections, ...storyPath.externalConnections].some((connection) => connection.kind !== "linear");
  if (hasBranchOrMerge) return storyPath.entries.length >= 7 ? "branch-horizontal" : "stepped";
  if (storyPath.pathScenes.length > 0) return storyPath.entries.length <= 5 ? "vertical" : "stepped";
  if (storyPath.entries.length >= 8) return "compact-horizontal";
  return "horizontal";
}

function nodePositionsFor(storyPath: ArcaeaStoryExplorerPath, orientation: StoryAtlasOrientation): StoryAtlasPoint[] {
  const count = storyPath.entries.length;
  const nodeTop = 166;
  if (orientation === "vertical") {
    return storyPath.entries.map((_, index) => ({ x: 105 + (index % 2) * 32, y: nodeTop + index * 112 }));
  }
  if (orientation === "stepped") {
    const columns = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(Math.max(1, count) * 1.25))));
    return storyPath.entries.map((_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const serpentineColumn = row % 2 === 0 ? column : columns - 1 - column;
      return { x: 76 + serpentineColumn * 122, y: nodeTop + row * 128 };
    });
  }
  if (orientation === "branch-horizontal") {
    return storyPath.entries.map((entry, index) => {
      const incoming = storyPath.connections.find((connection) => connection.to === entry.key);
      const row = incoming?.kind === "branch" ? (index % 2 === 0 ? 0 : 2) : incoming?.kind === "merge" ? 1 : index % 3 === 0 ? 0 : 1;
      return { x: 76 + index * 112, y: nodeTop + row * 84 };
    });
  }
  const gap = orientation === "compact-horizontal" ? 98 : 116;
  return storyPath.entries.map((_, index) => ({
    x: 76 + index * gap,
    y: nodeTop + (orientation === "compact-horizontal" ? [0, 18, 8][index % 3]! : index % 2 === 0 ? 0 : 16),
  }));
}

function avatarPositionsFor(characterIds: number[]): StoryAtlasPoint[] {
  const columns = Math.min(3, Math.max(1, characterIds.length));
  return characterIds.map((_, index) => ({
    x: 54 + (index % columns) * 82,
    y: 62 + Math.floor(index / columns) * 76,
  }));
}

function clusterKey(storyPath: ArcaeaStoryExplorerPath): string {
  const characters = [...storyPath.characterIds].sort((left, right) => left - right);
  return characters.length > 0 ? "characters:" + characters.join(",") : "type:" + storyPath.type;
}

function resolveCollision(candidate: StoryAtlasPathLayout, placed: StoryAtlasPathLayout[]): StoryAtlasPathLayout {
  if (placed.every((other) => !boundsIntersect(candidate.interactiveBounds, other.interactiveBounds, PATH_GAP))) return candidate;
  const stepX = Math.max(260, Math.round(candidate.width * 0.72));
  const stepY = Math.max(190, Math.round(candidate.height * 0.78));
  for (let ring = 1; ring <= 64; ring += 1) {
    for (const direction of SEARCH_DIRECTIONS.slice(1)) {
      const shifted = translatePath(candidate, candidate.x + direction.x * ring * stepX, candidate.y + direction.y * ring * stepY);
      if (shifted.interactiveBounds.left < 0 || shifted.interactiveBounds.top < 0) continue;
      if (placed.every((other) => !boundsIntersect(shifted.interactiveBounds, other.interactiveBounds, PATH_GAP))) return shifted;
    }
  }
  return candidate;
}

function lineForConnection(
  connection: ArcaeaStoryExplorerConnection,
  points: Map<string, StoryAtlasPoint>,
  pathByNode: Map<string, number>,
  pathId: number,
  external: boolean,
): StoryAtlasLine | undefined {
  const from = points.get(connection.from);
  const to = points.get(connection.to);
  if (!from || !to) return undefined;
  const pathIds = [...new Set([pathId, pathByNode.get(connection.to)])].filter((value): value is number => value !== undefined);
  return {
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    from: connection.from,
    to: connection.to,
    kind: connection.kind,
    provenance: connection.provenance,
    pathIds,
    ...(external ? { external: true } : {}),
  };
}

function makeBounds(left: number, top: number, width: number, height: number): StoryAtlasBounds {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function shiftBounds(bounds: StoryAtlasBounds, x: number, y: number): StoryAtlasBounds {
  return makeBounds(bounds.left + x, bounds.top + y, bounds.width, bounds.height);
}

function mapPoints(points: Record<string, StoryAtlasPoint>, x: number, y: number): Record<string, StoryAtlasPoint> {
  return Object.fromEntries(Object.entries(points).map(([key, point]) => [key, { x: point.x + x, y: point.y + y }]));
}

function mapBoundsRecord(bounds: Record<string, StoryAtlasBounds>, x: number, y: number): Record<string, StoryAtlasBounds> {
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, shiftBounds(value, x, y)]));
}

function unionBounds(bounds: StoryAtlasBounds[]): StoryAtlasBounds {
  if (bounds.length === 0) return makeBounds(0, 0, 0, 0);
  const left = Math.min(...bounds.map((item) => item.left));
  const top = Math.min(...bounds.map((item) => item.top));
  const right = Math.max(...bounds.map((item) => item.right));
  const bottom = Math.max(...bounds.map((item) => item.bottom));
  return makeBounds(left, top, right - left, bottom - top);
}

function translatePath(pathLayout: StoryAtlasPathLayout, x: number, y: number): StoryAtlasPathLayout {
  const deltaX = x - pathLayout.x;
  const deltaY = y - pathLayout.y;
  return {
    ...pathLayout,
    x,
    y,
    bounds: shiftBounds(pathLayout.bounds, deltaX, deltaY),
    interactiveBounds: shiftBounds(pathLayout.interactiveBounds, deltaX, deltaY),
    title: { x: pathLayout.title.x + deltaX, y: pathLayout.title.y + deltaY },
    titleBounds: shiftBounds(pathLayout.titleBounds, deltaX, deltaY),
    nodes: mapPoints(pathLayout.nodes, deltaX, deltaY),
    nodeBounds: mapBoundsRecord(pathLayout.nodeBounds, deltaX, deltaY),
    avatars: pathLayout.avatars.map((avatar) => ({ ...avatar, x: avatar.x + deltaX, y: avatar.y + deltaY })),
    avatarBounds: pathLayout.avatarBounds.map((bounds) => shiftBounds(bounds, deltaX, deltaY)),
    scenes: pathLayout.scenes.map((scene) => ({ ...scene, x: scene.x + deltaX, y: scene.y + deltaY })),
    sceneBounds: mapBoundsRecord(pathLayout.sceneBounds, deltaX, deltaY),
  };
}
