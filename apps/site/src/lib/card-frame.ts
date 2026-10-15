import type { PublicPreview } from "./types";

// Card grids share one frame per list so rows line up. Inside the frame an image
// may be cropped by up to CARD_CROP_TOLERANCE on its long side (the same factor
// is in global.css); beyond that it keeps its shape on a mat. The list frame is
// the one whose typical image fills the most of it (geometric mean of the filled
// share), which keeps uniform categories full-bleed and avoids slivers in mixed ones.
export const CARD_FRAMES = { tall: 3 / 4, square: 1, landscape: 4 / 3, wide: 16 / 9 } as const;
export const CARD_CROP_TOLERANCE = 1.18;
export type CardFrame = keyof typeof CARD_FRAMES;

type Dimensions = { width?: number | undefined; height?: number | undefined } | null | undefined;

export function imageRatio(image: Dimensions): number | undefined {
  const width = image?.width, height = image?.height;
  return width && height && width > 0 && height > 0 ? width / height : undefined;
}

/** Share of the frame an image of this ratio covers after the allowed crop. */
export function frameFill(ratio: number, frame: number): number {
  return Math.min(1, CARD_CROP_TOLERANCE * (ratio >= frame ? frame / ratio : ratio / frame));
}

export function cardFrameFor(images: Iterable<Dimensions>, fallback: CardFrame = "landscape"): CardFrame {
  const ratios: number[] = [];
  for (const image of images) {
    const ratio = imageRatio(image);
    if (ratio) ratios.push(ratio);
  }
  if (ratios.length === 0) return fallback;
  let best = fallback, bestScore = Number.NEGATIVE_INFINITY;
  for (const [frame, value] of Object.entries(CARD_FRAMES) as Array<[CardFrame, number]>) {
    let score = 0;
    for (const ratio of ratios) score += Math.log(frameFill(ratio, value));
    if (score > bestScore + 1e-9) { best = frame; bestScore = score; }
  }
  return best;
}

/** Frame for build-time card lists, from the same preview the card displays. */
export function cardFrameForPreviews(previews: Iterable<PublicPreview>): CardFrame {
  return cardFrameFor([...previews].map((preview) => preview.small ?? preview.medium ?? preview.large));
}

/** Inline style value for one card's image ratio; omitted when dimensions are unknown. */
export function cardRatioStyle(image: Dimensions): string | undefined {
  const ratio = imageRatio(image);
  return ratio ? `--r:${Number(ratio.toFixed(4))}` : undefined;
}
