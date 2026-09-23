import type { PublicAsset, PublicPreview, PublicSearchImage } from "./types";

/** Card media never falls back to a download rendition. */
export function selectCardPreview(preview: PublicPreview): {
  primary: PublicAsset | null;
  fallback: PublicAsset | null;
  srcset: string;
} {
  const candidates = [preview.small, preview.medium, preview.large].filter((asset): asset is PublicAsset => Boolean(asset));
  const primary = candidates[0] ?? null;
  const fallback = candidates[1] ?? null;
  const srcset = [preview.small, preview.medium]
    .filter((asset): asset is PublicAsset => Boolean(asset))
    .map((asset) => `${asset.url} ${asset.width}w`)
    .join(", ");
  return { primary, fallback, srcset };
}

export function cardImage(asset: PublicAsset | null): PublicSearchImage | null {
  return asset ? { url: asset.url, width: asset.width, height: asset.height } : null;
}
