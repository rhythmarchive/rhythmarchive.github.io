import type { PublicAsset, PublicPreview, PublicSearchImage } from "./types";

// Conservative slot widths for the existing preview candidates. Sidebars do
// not change image quality or introduce original/upscaled requests.
export const GALLERY_IMAGE_SIZES = "(max-width: 760px) calc((100vw - 42px) / 2), (max-width: 839px) calc((100vw - 92px) / 3), (max-width: 1040px) calc((100vw - 106px) / 4), (max-width: 1199px) calc((100vw - 120px) / 5), 210px";
export const SIDEBAR_IMAGE_SIZES = "(min-width: 1308px) 210px, (min-width: 1200px) calc((100vw - 354px) / 4), " + GALLERY_IMAGE_SIZES;

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
