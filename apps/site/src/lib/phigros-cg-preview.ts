import type { PublicResource } from "./types";
import { PREVIEW_MEDIA_ORIGIN } from "./phigros-media-preview";

/** Development fixtures only; formal Catalog identities are assigned at publication. */
export function phigrosCgPreviewResources(): PublicResource[] {
  return ([
    { scene: "secret", title: "秘密剧情 · 鸠与 Gino", file: "CollectionHeader.png", bytes: 2416232 },
    { scene: "deduction", title: "推演 · 重逢", file: "1.png", bytes: 797121 },
  ] as const).map((entry) => {
    const preview = {
      small: { url: `${PREVIEW_MEDIA_ORIGIN}/cg-thumbs/${entry.scene}-320.webp`, width: 320, height: 180, mime: "image/webp" },
      medium: { url: `${PREVIEW_MEDIA_ORIGIN}/cg-thumbs/${entry.scene}-640.webp`, width: 640, height: 360, mime: "image/webp" },
      large: null,
    };
    const original = { url: `${PREVIEW_MEDIA_ORIGIN}/cg/${entry.file}`, downloadFilename: entry.file, mime: "image/png", sizeBytes: entry.bytes, width: 2048, height: 1152 };
    return {
      resourceId: `preview-phigros-cg-${entry.scene}`, route: `/preview/phigros-cg/${entry.scene}/`,
      game: "phigros", resourceType: "story-cg", category: "story-cg", categoryLabel: "剧情 CG",
      displayTitle: entry.title, metadata: {}, preview, original,
      variants: [{ variantId: `preview-phigros-cg-${entry.scene}-original`, label: "默认", preview, original }],
    };
  });
}
