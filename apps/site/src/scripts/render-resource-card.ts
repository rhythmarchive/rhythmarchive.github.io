import { observeImage } from "./viewport-images";
import type { CardViewModel } from "../lib/card-view-model";
import { appendResourceViews } from "../lib/stats-client";
import { sitePath } from "../lib/url";

type CardRenderOptions = {
  basePath: string;
  index: number;
  isSelected: boolean;
  browse?: boolean;
  selectable?: boolean;
};

export function renderResourceCard(view: CardViewModel, options: CardRenderOptions): HTMLElement {
  const article = document.createElement("article");
  article.className = `resource-card${options.isSelected ? " is-selected" : ""}`;
  if (options.browse) article.dataset.browseCard = "";
  article.dataset.resourceCard = "";
  article.dataset.resourceId = view.resourceId;
  article.dataset.game = view.game;
  article.dataset.resourceType = view.resourceType;

  const select = document.createElement("button");
  select.className = "resource-select";
  select.type = "button";
  select.dataset.selectResource = view.resourceId;
  select.setAttribute("aria-pressed", String(options.isSelected));
  select.setAttribute("aria-label", `${options.isSelected ? "取消选择" : "选择"} ${view.displayTitle}`);
  const check = document.createElement("span");
  check.setAttribute("aria-hidden", "true");
  check.textContent = "✓";
  select.append(check);
  if (options.selectable !== false) article.append(select);

  const anchor = document.createElement("a");
  anchor.className = "resource-card-link";
  anchor.href = sitePath(view.route, options.basePath);
  const media = document.createElement("div");
  media.className = "resource-card-media";
  const { primary, fallback, srcset } = view.preview;
  if (primary) {
    const image = document.createElement("img");
    image.dataset.viewportSrc = primary.url;
    image.alt = view.displayTitle;
    const width = primary.width ?? fallback?.width;
    const height = primary.height ?? fallback?.height;
    if (width) image.width = width;
    if (height) image.height = height;
    image.loading = options.index < 6 ? "eager" : "lazy";
    image.decoding = "async";
    if (srcset) image.dataset.viewportSrcset = srcset;
    if (fallback?.url) {
      image.dataset.fallbackSrc = fallback.url;
      if (fallback.width) image.dataset.fallbackWidth = String(fallback.width);
      if (fallback.height) image.dataset.fallbackHeight = String(fallback.height);
    }
    image.sizes = "(max-width: 640px) 50vw, (max-width: 1280px) 20vw, 210px";
    observeImage(image);
    media.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "resource-card-placeholder";
    placeholder.textContent = "图片暂不可用";
    media.append(placeholder);
  }
  if (view.hasUpscaled) {
    const badge = document.createElement("span");
    badge.className = "resource-badge is-upscaled";
    badge.textContent = "含超分版";
    media.append(badge);
  }

  const body = document.createElement("div");
  body.className = "resource-card-body";
  const title = document.createElement("h3");
  title.textContent = view.displayTitle;
  body.append(title);
  if (view.artist) {
    const artist = document.createElement("p");
    artist.textContent = view.artist;
    body.append(artist);
  }
  if (view.subtitle) {
    const subtitle = document.createElement("p");
    subtitle.className = "resource-card-subtitle";
    subtitle.textContent = view.subtitle;
    body.append(subtitle);
  }
  for (const label of view.labels) {
    const badge = document.createElement("span");
    badge.className = "resource-card-variant";
    badge.textContent = label;
    body.append(badge);
  }
  appendResourceViews(body);
  anchor.append(media, body);
  article.append(anchor);
  return article;
}
