import { zipSync } from "fflate";
import { DOWNLOAD_CONCURRENCY, MAX_BATCH_BYTES, MAX_BATCH_FILES, uniqueZipFilename } from "../lib/batch";
import { cardMediaFit, cardMediaRatio } from "../lib/media-config";
import { normalizeSearchText } from "../lib/search";
import type { PublicDownload, PublicResource } from "../lib/types";

const PAGE_SIZE = 48;

const root = document.querySelector<HTMLElement>("[data-gallery-root]");
if (root) void initializeGallery(root);

async function initializeGallery(root: HTMLElement): Promise<void> {
  const grid = root.querySelector<HTMLElement>("[data-gallery-grid]");
  const loadMore = root.querySelector<HTMLButtonElement>("[data-load-more]");
  const count = root.querySelector<HTMLElement>("[data-gallery-count]");
  const search = root.querySelector<HTMLInputElement>("[data-gallery-search]");
  const sort = root.querySelector<HTMLSelectElement>("[data-gallery-sort]");
  const facets = [...root.querySelectorAll<HTMLSelectElement>("[data-gallery-facet]")];
  const reset = root.querySelector<HTMLButtonElement>("[data-gallery-reset]");
  const active = root.querySelector<HTMLElement>("[data-gallery-active]");
  const activeChips = root.querySelector<HTMLElement>("[data-gallery-active-chips]");
  if (!grid || !loadMore || !count) return;

  let resources: PublicResource[] = [];
  let visibleCount = PAGE_SIZE;
  const selected = new Set<string>();

  try {
    const response = await fetch(root.dataset.galleryUrl ?? "", { credentials: "omit" });
    if (!response.ok) throw new Error(`gallery data failed with ${response.status}`);
    resources = await response.json() as PublicResource[];
    const params = new URLSearchParams(window.location.search);
    if (search) search.value = params.get("q") ?? "";
    if (sort) sort.value = params.get("sort") ?? sort.options[0]?.value ?? "default";
    for (const facet of facets) facet.value = params.get(`facet-${facet.dataset.galleryFacet ?? ""}`) ?? "";
    render();
  } catch (error) {
    console.error("Gallery data failed", error);
    count.textContent = "图片加载失败";
    return;
  }

  search?.addEventListener("input", applyFilter);
  sort?.addEventListener("change", applyFilter);
  facets.forEach((facet) => facet.addEventListener("change", applyFilter));
  reset?.addEventListener("click", (event) => {
    event.preventDefault();
    if (search) search.value = "";
    if (sort) sort.value = sort.options[0]?.value ?? "default";
    for (const facet of facets) facet.value = "";
    applyFilter();
  });
  loadMore.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    render();
  });
  grid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-select-resource]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = button.dataset.selectResource;
    if (!id) return;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    root.classList.toggle("has-selection", selected.size > 0);
    updateBatchBar();
    button.setAttribute("aria-pressed", String(selected.has(id)));
    button.setAttribute("aria-label", `${selected.has(id) ? "取消选择" : "选择"} ${button.closest<HTMLElement>("[data-resource-card]")?.querySelector("h3")?.textContent ?? "资源"}`);
    button.closest<HTMLElement>("[data-resource-card]")?.classList.toggle("is-selected", selected.has(id));
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-batch-download]")) {
    button.addEventListener("click", () => void downloadBatch(button.dataset.batchDownload === "upscaled"));
  }

  function currentResources(): PublicResource[] {
    const query = normalizeSearchText(search?.value ?? "");
    const sortValue = sort?.value ?? "default";
    const filtered = resources.filter((resource) => {
      const text = [resource.displayTitle, resource.artist, resource.subtitle, ...(resource.badges ?? []), ...(resource.searchTerms ?? []), ...Object.values(resource.facets ?? {}).flat(), ...Object.values(resource.metadata).map(String)].filter(Boolean).join(" ");
      if (query && !normalizeSearchText(text).includes(query)) return false;
      return facets.every((facet) => {
        const value = facet.value;
        return !value || (resource.facets?.[facet.dataset.galleryFacet ?? ""] ?? []).includes(value);
      });
    });
    if (sortValue === "default") return filtered;
    return [...filtered].sort((left, right) => {
      if (sortValue === "artist-asc") return normalizeSearchText(left.artist ?? "").localeCompare(normalizeSearchText(right.artist ?? ""), "zh-CN") || normalizeSearchText(left.displayTitle).localeCompare(normalizeSearchText(right.displayTitle), "zh-CN");
      const compared = normalizeSearchText(left.displayTitle).localeCompare(normalizeSearchText(right.displayTitle), "zh-CN");
      return sortValue === "title-desc" ? -compared : compared;
    });
  }

  function applyFilter(): void {
    visibleCount = PAGE_SIZE;
    const url = new URL(window.location.href);
    if (search?.value) url.searchParams.set("q", search.value); else url.searchParams.delete("q");
    if (sort?.value && sort.value !== sort.options[0]?.value) url.searchParams.set("sort", sort.value); else url.searchParams.delete("sort");
    for (const facet of facets) {
      const key = `facet-${facet.dataset.galleryFacet ?? ""}`;
      if (facet.value) url.searchParams.set(key, facet.value); else url.searchParams.delete(key);
    }
    window.history.replaceState({}, "", url);
    render();
  }

  function render(): void {
    const filtered = currentResources();
    const visible = filtered.slice(0, visibleCount);
    grid!.replaceChildren(...visible.map((resource, index) => createCard(resource, index, selected.has(resource.resourceId))));
    count!.textContent = `${filtered.length.toLocaleString("zh-CN")} 项资源`;
    loadMore!.hidden = visible.length >= filtered.length;
    updateActiveFilters();
    updateBatchBar();
  }

  function updateActiveFilters(): void {
    if (!active || !activeChips) return;
    const labels: string[] = [];
    if (search?.value) labels.push(`搜索：${search.value}`);
    for (const facet of facets) {
      if (!facet.value) continue;
      labels.push(facet.options[facet.selectedIndex]?.textContent ?? facet.value);
    }
    activeChips.replaceChildren(...labels.map((label) => {
      const chip = document.createElement("span");
      chip.className = "active-filter-chip";
      chip.textContent = label;
      return chip;
    }));
    active.hidden = labels.length === 0;
  }

  function updateBatchBar(): void {
    const bar = root.querySelector<HTMLElement>("[data-batch-bar]");
    const countNode = root.querySelector<HTMLElement>("[data-batch-count]");
    if (!bar || !countNode) return;
    bar.hidden = selected.size === 0;
    countNode.textContent = `已选择 ${selected.size.toLocaleString("zh-CN")} 项`;
  }

  async function downloadBatch(preferUpscaled: boolean): Promise<void> {
    const batch = resources.filter((resource) => selected.has(resource.resourceId));
    const status = root.querySelector<HTMLElement>("[data-batch-status]");
    if (batch.length === 0) return;
    if (batch.length > MAX_BATCH_FILES) {
      if (status) status.textContent = "一次选择的文件较多，请减少后再下载。";
      return;
    }
    const items = batch.map((resource) => ({ resource, download: chooseDownload(resource, preferUpscaled) }));
    if (items.some((item) => !item.download)) {
      if (status) status.textContent = "下载失败，请重试";
      return;
    }
    const totalBytes = items.reduce((sum, item) => sum + (item.download?.sizeBytes ?? 0), 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      if (status) status.textContent = "一次选择的文件较多，请减少后再下载。";
      return;
    }
    const entries: Record<string, Uint8Array> = {};
    const usedNames = new Set<string>();
    let completed = 0;
    if (status) status.textContent = `正在准备 0 / ${items.length}`;
    try {
      await runWithConcurrency(items, DOWNLOAD_CONCURRENCY, async ({ download }) => {
        const response = await fetch(download!.url, { credentials: "omit" });
        if (!response.ok) throw new Error(`download failed with ${response.status}`);
        entries[uniqueZipFilename(usedNames, download!.downloadFilename)] = new Uint8Array(await response.arrayBuffer());
        completed += 1;
        if (status) status.textContent = `正在准备 ${completed} / ${items.length}`;
      });
      const archive = zipSync(entries, { level: 0 });
      const blob = new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `rhythm-archive-${root.dataset.game ?? "resources"}.zip`);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (status) status.textContent = "";
    } catch (error) {
      console.error("Batch download failed", error);
      if (status) status.textContent = "下载失败，请重试";
    }
  }
}

function createCard(resource: PublicResource, index: number, isSelected: boolean): HTMLElement {
  const article = document.createElement("article");
  article.className = `resource-card${isSelected ? " is-selected" : ""}`;
  article.dataset.resourceCard = "";
  article.dataset.resourceId = resource.resourceId;
  article.dataset.game = resource.game;
  article.dataset.resourceType = resource.resourceType;
  article.dataset.mediaRatio = cardMediaRatio(resource.game, resource.resourceType);
  article.dataset.mediaFit = cardMediaFit(resource.game, resource.resourceType);
  const select = document.createElement("button");
  select.className = "resource-select";
  select.type = "button";
  select.dataset.selectResource = resource.resourceId;
  select.setAttribute("aria-pressed", String(isSelected));
  select.setAttribute("aria-label", `${isSelected ? "取消选择" : "选择"} ${resource.displayTitle}`);
  select.innerHTML = "<span aria-hidden=\"true\">✓</span>";
  article.append(select);

  const anchor = document.createElement("a");
  anchor.className = "resource-card-link";
  anchor.href = resolveSitePath(resource.route);
  const media = document.createElement("div");
  media.className = "resource-card-media";
  const image = resource.preview.small ?? resource.preview.medium ?? resource.preview.large;
  if (image) {
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = resource.displayTitle;
    img.width = image.width;
    img.height = image.height;
    img.loading = index < 6 ? "eager" : "lazy";
    img.decoding = "async";
    const srcset = [resource.preview.small ? `${resource.preview.small.url} 320w` : "", resource.preview.medium ? `${resource.preview.medium.url} 640w` : ""].filter(Boolean).join(", ");
    if (srcset) img.setAttribute("srcset", srcset);
    img.sizes = "(max-width: 640px) 50vw, (max-width: 1280px) 20vw, 210px";
    media.append(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "resource-card-placeholder";
    placeholder.textContent = "图片暂不可用";
    media.append(placeholder);
  }
  if (resource.upscaled) {
    const badge = document.createElement("span");
    badge.className = "resource-badge is-upscaled";
    badge.textContent = "含超分版";
    media.append(badge);
  }
  const body = document.createElement("div");
  body.className = "resource-card-body";
  const title = document.createElement("h3");
  title.textContent = resource.displayTitle;
  body.append(title);
  if (resource.artist) {
    const artist = document.createElement("p");
    artist.textContent = resource.artist;
    body.append(artist);
  }
  if (resource.subtitle) {
    const subtitle = document.createElement("p");
    subtitle.className = "resource-card-subtitle";
    subtitle.textContent = resource.subtitle;
    body.append(subtitle);
  }
  for (const badge of resource.badges ?? []) {
    const label = document.createElement("span");
    label.className = "resource-card-variant";
    label.textContent = badge;
    body.append(label);
  }
  const variant = resource.badges?.length ? undefined : resource.variants.find((item) => item.label !== "默认");
  if (variant) {
    const label = document.createElement("span");
    label.className = "resource-card-variant";
    label.textContent = variant.label;
    body.append(label);
  }
  anchor.append(media, body);
  article.append(anchor);
  return article;
}

function chooseDownload(resource: PublicResource, preferUpscaled: boolean): PublicDownload | undefined {
  return preferUpscaled ? resource.upscaled ?? resource.original : resource.original;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function resolveSitePath(path: string): string {
  const base = document.querySelector<HTMLElement>("[data-gallery-root]")?.dataset.basePath ?? "/";
  const clean = path.startsWith("/") ? path : `/${path}`;
  return base === "/" ? clean : `${base.replace(/\/+$/u, "")}${clean}`;
}
