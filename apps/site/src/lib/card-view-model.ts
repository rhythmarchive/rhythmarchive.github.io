import type { BrowseGalleryItem } from "./browse-gallery";
import { selectCardPreview } from "./card-preview";
import type { GalleryCard } from "./gallery-projection";
import type { PublicPreview, PublicResource, PublicSearchImage } from "./types";

export type CardViewModel = {
  resourceId: string;
  route: string;
  game: string;
  resourceType: string;
  displayTitle: string;
  artist?: string;
  subtitle?: string;
  preview: { primary: PublicSearchImage | null; fallback: PublicSearchImage | null; srcset: string };
  hasUpscaled: boolean;
  labels: string[];
};

type CardSource = Pick<PublicResource, "resourceId" | "route" | "game" | "resourceType" | "displayTitle" | "artist" | "subtitle"> & {
  preview: PublicPreview;
};

function cardView(source: CardSource, hasUpscaled: boolean, labels: Array<string | null | undefined>, includeSubtitle = true): CardViewModel {
  return {
    resourceId: source.resourceId,
    route: source.route,
    game: source.game,
    resourceType: source.resourceType,
    displayTitle: source.displayTitle,
    ...(source.artist ? { artist: source.artist } : {}),
    ...(includeSubtitle && source.subtitle ? { subtitle: source.subtitle } : {}),
    preview: selectCardPreview(source.preview),
    hasUpscaled,
    labels: labels.filter((label): label is string => Boolean(label)),
  };
}

export function publicResourceCardView(resource: PublicResource): CardViewModel {
  const variantLabel = resource.variants.find((variant) => variant.label !== "默认")?.label;
  return cardView(resource, Boolean(resource.upscaled), resource.badges?.length ? resource.badges : [variantLabel]);
}

export function galleryCardView(resource: GalleryCard): CardViewModel {
  return cardView(resource, resource.hasUpscaled, resource.badges?.length ? resource.badges : [resource.variantLabel]);
}

export function browseCardView(item: BrowseGalleryItem): CardViewModel {
  const labels = [...(item.badges ?? []), item.badge, item.selectedArtworkDifficulty, item.selectedChartDifficulty, item.game === "arcaea" || item.game === "phigros" ? item.pack : undefined];
  return cardView(item, item.hasUpscaled, labels, false);
}
