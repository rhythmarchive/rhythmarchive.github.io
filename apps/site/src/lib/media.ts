import type { PublicDownload, PublicResource } from "./types";

export type MediaClip = { id: string; label: string; duration: number; original: PublicDownload; poster: string };
export type MediaItem = { id: string; title: string; kind: string; category: string; spoiler: boolean; clips: MediaClip[] };

export function buildMediaItems(resources: PublicResource[]): MediaItem[] {
  return [...resources].sort((a, b) => Number(a.metadata.mediaOrder ?? 100) - Number(b.metadata.mediaOrder ?? 100) || a.displayTitle.localeCompare(b.displayTitle, "zh-CN")).map(resource => {
    const kind = String(resource.metadata.mediaKind ?? "unlock");
    return {
      id: resource.resourceId, title: resource.displayTitle, kind,
      category: kind === "story" ? "剧情过场" : kind === "background" ? "动态背景" : "曲目解锁演出",
      spoiler: resource.metadata.spoiler === true,
      clips: resource.variants.map(variant => {
        if (variant.original?.mime !== "video/mp4" || !variant.original.media) throw new Error(`Video has no playable original: ${resource.resourceId}`);
        const preview = variant.preview.medium ?? variant.preview.small ?? variant.preview.large;
        if (!preview?.mime.startsWith("image/")) throw new Error(`Video has no static poster: ${resource.resourceId}`);
        return { id: variant.variantId, label: variant.label, duration: variant.original.media.durationSeconds, original: variant.original, poster: preview.url };
      }),
    };
  });
}
