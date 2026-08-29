import type { ArcaeaStoryExplorerConnection, ArcaeaStoryExplorerPath, ArcaeaStoryExplorerSection } from "./arcaea-story-explorer";

export type StoryAtlasPoint = { x: number; y: number };
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
  orientation: "horizontal" | "vertical" | "stepped" | "compact-horizontal";
  title: StoryAtlasPoint;
  nodes: Record<string, StoryAtlasPoint>;
  avatars: StoryAtlasAvatar[];
  scenes: StoryAtlasScenePoint[];
};
export type StoryAtlasLayout = {
  sectionAct: number;
  width: number;
  height: number;
  paths: StoryAtlasPathLayout[];
  lines: StoryAtlasLine[];
  initialCamera: { x: number; y: number; scale: number };
};

const ORIENTATIONS: StoryAtlasPathLayout["orientation"][] = ["horizontal", "stepped", "vertical", "compact-horizontal"];

export function buildArcaeaStoryAtlasLayout(section: ArcaeaStoryExplorerSection): StoryAtlasLayout {
  const columns = section.paths.length <= 4 ? 2 : section.paths.length <= 9 ? 3 : 4;
  const cellWidth = 560;
  const cellHeight = 330;
  const marginX = 130;
  const marginY = 130;
  const pathLayouts = section.paths.map((storyPath, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = marginX + column * cellWidth;
    const y = marginY + row * cellHeight;
    const orientation = ORIENTATIONS[storyPath.pathId % ORIENTATIONS.length] ?? "horizontal";
    const nodes: Record<string, StoryAtlasPoint> = {};
    storyPath.entries.forEach((entry, nodeIndex) => {
      const point = nodePoint(x, y, orientation, nodeIndex, storyPath.entries.length);
      nodes[entry.key] = point;
    });
    const avatars = storyPath.characterIds.map((id, avatarIndex) => ({
      id,
      x: x + 100 + avatarIndex * 92,
      y: y - 72,
      pathId: storyPath.pathId,
      label: storyPath.title,
    }));
    const scenes = storyPath.pathScenes.map((scene, sceneIndex) => ({
      sceneId: scene.sceneId,
      x: x + Math.min(430, 100 + sceneIndex * 100),
      y: y + 215,
      kind: scene.kind,
      title: scene.displayTitle ?? scene.sceneId,
    }));
    return {
      path: storyPath,
      x,
      y,
      width: 500,
      height: 240,
      orientation,
      title: { x: x + 12, y: y - 26 },
      nodes,
      avatars,
      scenes,
    } satisfies StoryAtlasPathLayout;
  });
  const pointByNode = new Map<string, StoryAtlasPoint>();
  for (const pathLayout of pathLayouts) for (const [nodeKey, point] of Object.entries(pathLayout.nodes)) pointByNode.set(nodeKey, point);
  const lines = pathLayouts.flatMap((pathLayout) => pathLayout.path.connections.flatMap((connection) => lineForConnection(connection, pointByNode, pathLayout.path.pathId)))
    .concat(pathLayouts.flatMap((pathLayout) => pathLayout.path.externalConnections.flatMap((connection) => lineForConnection(connection, pointByNode, pathLayout.path.pathId, true))));
  const rows = Math.max(1, Math.ceil(pathLayouts.length / columns));
  const width = marginX * 2 + columns * cellWidth;
  const height = marginY * 2 + rows * cellHeight;
  const first = pathLayouts[0];
  const initialPoint = first ? { x: first.x + first.width / 2, y: first.y + first.height / 2 } : { x: width / 2, y: height / 2 };
  return { sectionAct: section.act, width, height, paths: pathLayouts, lines, initialCamera: { x: initialPoint.x, y: initialPoint.y, scale: 0.82 } };
}

function nodePoint(x: number, y: number, orientation: StoryAtlasPathLayout["orientation"], index: number, count: number): StoryAtlasPoint {
  if (orientation === "vertical") return { x: x + 210, y: y + index * 52 + 15 };
  if (orientation === "stepped") return { x: x + 55 + (index % 4) * 112, y: y + Math.floor(index / 4) * 72 + 35 };
  const gap = orientation === "compact-horizontal" || count > 7 ? 58 : 72;
  return { x: x + 34 + index * gap, y: y + 82 + (index % 2 === 0 ? 0 : 15) };
}

function lineForConnection(connection: ArcaeaStoryExplorerConnection, points: Map<string, StoryAtlasPoint>, pathId: number, external = false): StoryAtlasLine[] {
  const from = points.get(connection.from);
  const to = points.get(connection.to);
  if (!from || !to) return [];
  return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y, from: connection.from, to: connection.to, kind: connection.kind, provenance: connection.provenance, pathIds: [pathId], ...(external ? { external: true } : {}) }];
}
