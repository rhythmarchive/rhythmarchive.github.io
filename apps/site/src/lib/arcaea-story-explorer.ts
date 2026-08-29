import type { ArcaeaStoryAtlasType, ArcaeaStorySceneType, ArcaeaStoryStructureType, ArcaeaStoryTextProjectionType } from "../../../../packages/domain/src/browse.js";
import type { PublicResource } from "./types";

export type ArcaeaStoryExplorerEntry = {
  pathId: number;
  key: string;
  order: number;
  visual: "animation" | "illustration" | "story";
  visualLabel: string;
  resources: PublicResource[];
  relatedSongs: string[];
  staffRoll: boolean;
  iconKey?: string;
  unlockLabel?: string;
  text?: ArcaeaStoryTextProjectionType["entries"][number];
  sceneIds: string[];
};

export type ArcaeaStoryExplorerConnection = {
  from: string;
  to: string;
  kind: "linear" | "branch" | "merge";
  external: boolean;
  provenance: "audited" | "sequential-fallback";
};

export type ArcaeaStoryExplorerScene = ArcaeaStorySceneType & { resources: PublicResource[] };

export type ArcaeaStoryExplorerPath = {
  pathId: number;
  act: number;
  sectionLabel: string;
  title: string;
  type: string;
  typeLabel: string;
  characterIds: number[];
  entries: ArcaeaStoryExplorerEntry[];
  connections: ArcaeaStoryExplorerConnection[];
  externalConnections: ArcaeaStoryExplorerConnection[];
  rootEntries: string[];
  vnResources: PublicResource[];
  pathScenes: ArcaeaStoryExplorerScene[];
  resourceCount: number;
};

export type ArcaeaStoryExplorerSection = {
  act: number;
  label: string;
  paths: ArcaeaStoryExplorerPath[];
  resourceCount: number;
};

export type ArcaeaStoryExplorerModel = {
  source: ArcaeaStoryStructureType["source"];
  sections: ArcaeaStoryExplorerSection[];
  paths: ArcaeaStoryExplorerPath[];
  unassignedResources: PublicResource[];
  storyAtlas?: ArcaeaStoryAtlasType;
  counts: {
    total: number;
    storyCg: number;
    vnCg: number;
    assigned: number;
    unassigned: number;
    pathScenes: number;
    vnScenes: number;
    textEntries: number;
  };
};

export function isArcaeaVnCgResource(resource: PublicResource): boolean {
  return resource.game === "arcaea"
    && resource.category === "story-cg"
    && resource.resourceType === "story-texture"
    && resource.metadata.storyVisualKind === "VN CG";
}

export function isArcaeaStoryCgResource(resource: PublicResource): boolean {
  return resource.game === "arcaea"
    && resource.category === "story-cg"
    && (resource.resourceType === "story-cg" || isArcaeaVnCgResource(resource));
}

export function buildArcaeaStoryExplorerModel(resources: PublicResource[], structure: ArcaeaStoryStructureType, storyAtlas?: ArcaeaStoryAtlasType): ArcaeaStoryExplorerModel {
  const storyResources = resources.filter(isArcaeaStoryCgResource);
  const pathById = new Map(structure.paths.map((path) => [path.pathId, path]));
  const pathByNode = new Map(structure.paths.flatMap((path) => path.nodes.map((nodeKey) => [nodeKey, path] as const)));
  const sectionByAct = new Map(structure.sections.map((section) => [section.act, section.label]));
  const annotationByNode = new Map(structure.nodeAnnotations.map((annotation) => [annotation.nodeKey, annotation]));
  const textByNode = new Map(storyAtlas?.text.entries.map((entry) => [entry.nodeKey, entry]) ?? []);
  const nodeResources = new Map<string, PublicResource[]>();
  const pathSceneResources = new Map<string, PublicResource[]>();
  const assignedIds = new Set<string>();

  for (const resource of storyResources) {
    const relationKind = stringMetadata(resource.metadata.storyRelationKind);
    const nodeKey = stringMetadata(resource.metadata.storyNode);
    const nodePath = nodeKey ? pathByNode.get(nodeKey) : undefined;
    const pathId = numericMetadata(resource.metadata.storyPathId) ?? nodePath?.pathId;
    if (pathId === undefined || !pathById.has(pathId)) continue;
    if (relationKind === "path-scene" || relationKind === "vn-scene" || isArcaeaVnCgResource(resource)) {
      const sceneId = stringMetadata(resource.metadata.storySceneId) ?? "path:33:divine-oblivion-vn";
      addResource(pathSceneResources, sceneId, resource);
      assignedIds.add(resource.resourceId);
      continue;
    }
    const storyPath = pathById.get(pathId);
    if (!nodeKey || !storyPath?.nodes.includes(nodeKey)) continue;
    addResource(nodeResources, `${pathId}:${nodeKey}`, resource);
    assignedIds.add(resource.resourceId);
  }

  const paths: ArcaeaStoryExplorerPath[] = structure.paths.map((storyPath): ArcaeaStoryExplorerPath => {
    const entries = storyPath.nodes.map((nodeKey, order) => {
      const resourcesForNode = sortResources(nodeResources.get(`${storyPath.pathId}:${nodeKey}`) ?? []);
      const annotation = annotationByNode.get(nodeKey);
      const iconKey = structure.nodeIcons[nodeKey];
      const text = textByNode.get(nodeKey);
      const sceneIds = storyAtlas?.scenes.filter((scene) => scene.nodeKey === nodeKey).map((scene) => scene.sceneId) ?? [];
      const visual = annotation?.visual ?? (resourcesForNode.length > 0 ? "illustration" : "story");
      const relatedSongs = uniqueStrings([
        ...resourcesForNode.map((resource) => stringMetadata(resource.metadata.relatedSongTitle) ?? ""),
        annotation?.relatedSongId ?? "",
      ]);
      const unlockLabel = annotation
        ? annotation.unlockKind === "pack"
          ? `解锁：${annotation.relatedPackTitle ?? "对应曲包"}`
          : `解锁：${relatedSongs[0] ?? annotation.relatedSongId ?? "对应歌曲"}`
        : relatedSongs.length > 0
          ? `关联：${relatedSongs.join("、")}`
          : undefined;
      return {
        pathId: storyPath.pathId,
        key: nodeKey,
        order,
        visual,
        visualLabel: visual === "animation" ? "动画" : visual === "illustration" ? "插画" : "剧情节点",
        resources: resourcesForNode,
        relatedSongs,
        staffRoll: annotation?.staffRoll ?? false,
        ...(iconKey ? { iconKey } : {}),
        ...(unlockLabel ? { unlockLabel } : {}),
        ...(text ? { text } : {}),
        sceneIds,
      } satisfies ArcaeaStoryExplorerEntry;
    });
    const pathNodeSet = new Set(storyPath.nodes);
    const explicitConnections = structure.nodeLinks.filter((link) => pathNodeSet.has(link.from) || pathNodeSet.has(link.to));
    const localExplicitConnections = explicitConnections.filter((link) => pathNodeSet.has(link.from) && pathNodeSet.has(link.to));
    const connections = (localExplicitConnections.length > 0
      ? localExplicitConnections
      : storyPath.nodes.slice(1).map((nodeKey, index) => ({
        from: storyPath.nodes[index]!,
        to: nodeKey,
        kind: "linear" as const,
      }))).map((link) => ({ ...link, external: false, provenance: localExplicitConnections.length > 0 ? "audited" as const : "sequential-fallback" as const }));
    const externalConnections = explicitConnections
      .filter((link) => !(pathNodeSet.has(link.from) && pathNodeSet.has(link.to)))
      .map((link) => ({ ...link, external: true, provenance: "audited" as const }));
    const rootEntries = rootEntryKeys(storyPath.nodes, storyPath.pathId);
    const pathScenes = [...(storyAtlas?.scenes ?? [])]
      .filter((scene) => scene.pathId === storyPath.pathId && (!scene.nodeKey || scene.kind === "path-scene" || scene.kind === "epilogue"))
      .map((scene) => ({ ...scene, resources: sortResources(pathSceneResources.get(scene.sceneId) ?? []) }));
    const fallbackSceneIds = [...pathSceneResources.entries()]
      .filter(([sceneId, sceneResources]) => sceneResources.some((resource) => numericMetadata(resource.metadata.storyPathId) === storyPath.pathId) && !pathScenes.some((scene) => scene.sceneId === sceneId))
      .map(([sceneId]) => sceneId);
    const fallbackScenes: ArcaeaStoryExplorerScene[] = fallbackSceneIds.map((sceneId) => ({
      sceneId,
      kind: "path-scene",
      displayTitle: "Path Scene",
      pathId: storyPath.pathId,
      resourceIds: sortResources(pathSceneResources.get(sceneId) ?? []).map((resource) => resource.resourceId),
      locales: {},
      resources: sortResources(pathSceneResources.get(sceneId) ?? []),
    }));
    const allPathScenes = [...pathScenes, ...fallbackScenes];
    const pathVnResources = sortResources(allPathScenes.flatMap((scene) => scene.resources));
    return {
      pathId: storyPath.pathId,
      act: storyPath.act,
      sectionLabel: sectionByAct.get(storyPath.act) ?? `Act ${storyPath.act + 1}`,
      title: storyPath.title,
      type: storyPath.type,
      typeLabel: storyTypeLabel(storyPath.type),
      characterIds: storyPath.characters,
      entries,
      connections,
      externalConnections,
      rootEntries,
      vnResources: pathVnResources,
      pathScenes: allPathScenes,
      resourceCount: entries.reduce((total, entry) => total + entry.resources.length, 0) + pathVnResources.length,
    } satisfies ArcaeaStoryExplorerPath;
  });
  const pathByIdModel = new Map(paths.map((path) => [path.pathId, path] as const));
  const sections = structure.sections.map((section) => {
    const sectionPaths = section.pathIds
      .map((pathId) => pathByIdModel.get(pathId))
      .filter((path): path is ArcaeaStoryExplorerPath => Boolean(path));
    return {
      act: section.act,
      label: section.label,
      paths: sectionPaths,
      resourceCount: sectionPaths.reduce((total, path) => total + path.resourceCount, 0),
    } satisfies ArcaeaStoryExplorerSection;
  });
  const unassignedResources = sortResources(storyResources.filter((resource) => !assignedIds.has(resource.resourceId)));
  return {
    source: structure.source,
    sections,
    paths,
    unassignedResources,
    counts: {
      total: storyResources.length,
      storyCg: storyResources.filter((resource) => resource.resourceType === "story-cg").length,
      vnCg: storyResources.filter(isArcaeaVnCgResource).length,
      assigned: assignedIds.size,
      unassigned: unassignedResources.length,
      pathScenes: paths.reduce((total, storyPath) => total + storyPath.pathScenes.length, 0),
      vnScenes: storyAtlas?.scenes.filter((scene) => scene.kind === "vn-scene" || scene.kind === "epilogue").length ?? 0,
      textEntries: storyAtlas?.text.coverage.entriesWithText ?? 0,
    },
    ...(storyAtlas ? { storyAtlas } : {}),
  };
}

function addResource<T>(map: Map<T, PublicResource[]>, key: T, resource: PublicResource): void {
  map.set(key, [...(map.get(key) ?? []), resource]);
}

function sortResources(resources: PublicResource[]): PublicResource[] {
  return [...resources].sort((left, right) => {
    const leftImageOrder = numericMetadata(left.metadata.storyImageOrder) ?? Number.MAX_SAFE_INTEGER;
    const rightImageOrder = numericMetadata(right.metadata.storyImageOrder) ?? Number.MAX_SAFE_INTEGER;
    return leftImageOrder - rightImageOrder
      || (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER)
      || left.resourceId.localeCompare(right.resourceId, "en");
  });
}

function numericMetadata(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringMetadata(value: string | number | boolean | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function rootEntryKeys(nodes: string[], pathId: number): string[] {
  if (pathId === 1) return nodes.filter((nodeKey) => nodeKey === "1-1" || nodeKey === "2-1");
  if (pathId === 19) return nodes.filter((nodeKey) => nodeKey === "F-1" || nodeKey === "E-1");
  return nodes.length > 0 ? [nodes[0]!] : [];
}

function storyTypeLabel(value: string): string {
  if (value === "main") return "Main Story";
  if (value === "side") return "Side Story";
  if (value === "archive") return "Archive Story";
  return value;
}
