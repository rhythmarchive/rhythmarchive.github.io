import type { ArcaeaStoryStructureType } from "../../../../packages/domain/src/browse.js";
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
  unlockLabel?: string;
};

export type ArcaeaStoryExplorerPath = {
  pathId: number;
  act: number;
  sectionLabel: string;
  title: string;
  type: string;
  typeLabel: string;
  entries: ArcaeaStoryExplorerEntry[];
  vnResources: PublicResource[];
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
  counts: {
    total: number;
    storyCg: number;
    vnCg: number;
    assigned: number;
    unassigned: number;
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

export function buildArcaeaStoryExplorerModel(resources: PublicResource[], structure: ArcaeaStoryStructureType): ArcaeaStoryExplorerModel {
  const storyResources = resources.filter(isArcaeaStoryCgResource);
  const pathById = new Map(structure.paths.map((path) => [path.pathId, path]));
  const pathByNode = new Map(structure.paths.flatMap((path) => path.nodes.map((nodeKey) => [nodeKey, path] as const)));
  const sectionByAct = new Map(structure.sections.map((section) => [section.act, section.label]));
  const annotationByNode = new Map(structure.nodeAnnotations.map((annotation) => [annotation.nodeKey, annotation]));
  const nodeResources = new Map<string, PublicResource[]>();
  const vnResources = new Map<number, PublicResource[]>();
  const assignedIds = new Set<string>();

  for (const resource of storyResources) {
    const nodeKey = stringMetadata(resource.metadata.storyNode);
    const nodePath = nodeKey ? pathByNode.get(nodeKey) : undefined;
    const pathId = numericMetadata(resource.metadata.storyPathId) ?? nodePath?.pathId;
    if (pathId === undefined || !pathById.has(pathId)) continue;
    if (isArcaeaVnCgResource(resource)) {
      addResource(vnResources, pathId, resource);
      assignedIds.add(resource.resourceId);
      continue;
    }
    const storyPath = pathById.get(pathId);
    if (!nodeKey || !storyPath?.nodes.includes(nodeKey)) continue;
    addResource(nodeResources, `${pathId}:${nodeKey}`, resource);
    assignedIds.add(resource.resourceId);
  }

  const paths = structure.paths.map((storyPath) => {
    const entries = storyPath.nodes.map((nodeKey, order) => {
      const resourcesForNode = sortResources(nodeResources.get(`${storyPath.pathId}:${nodeKey}`) ?? []);
      const annotation = annotationByNode.get(nodeKey);
      const visual = annotation?.visual ?? (resourcesForNode.length > 0 ? "illustration" : "story");
      const relatedSongs = uniqueStrings(resourcesForNode.map((resource) => stringMetadata(resource.metadata.relatedSongTitle) ?? ""));
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
        ...(unlockLabel ? { unlockLabel } : {}),
      } satisfies ArcaeaStoryExplorerEntry;
    });
    const pathVnResources = sortResources(vnResources.get(storyPath.pathId) ?? []);
    return {
      pathId: storyPath.pathId,
      act: storyPath.act,
      sectionLabel: sectionByAct.get(storyPath.act) ?? `Act ${storyPath.act + 1}`,
      title: storyPath.title,
      type: storyPath.type,
      typeLabel: storyTypeLabel(storyPath.type),
      entries,
      vnResources: pathVnResources,
      resourceCount: entries.reduce((total, entry) => total + entry.resources.length, 0) + pathVnResources.length,
    } satisfies ArcaeaStoryExplorerPath;
  });
  const pathByIdModel = new Map(paths.map((path) => [path.pathId, path]));
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
    },
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

function storyTypeLabel(value: string): string {
  if (value === "main") return "Main Story";
  if (value === "side") return "Side Story";
  if (value === "archive") return "Archive Story";
  return value;
}
