import { zipSync } from "fflate";
import { DOWNLOAD_CONCURRENCY, MAX_BATCH_BYTES, MAX_BATCH_FILES, uniqueZipFilename } from "../lib/batch";
import type { PublicDownload, PublicResource } from "../lib/types";

const PAGE_SIZE = 48;

const root = document.querySelector<HTMLElement>("[data-gallery-root]");
if (root) void initializeGallery(root);

async function initializeGallery(root: HTMLElement): Promise<void> {
  const grid = root.querySelector<HTMLElement>("[data-gallery-grid]");
  const loadMore = root.querySelector<HTMLButtonElement>("[data-load-more]");
  const count = root.querySelector<HTMLElement>("[data-gallery-count]");
  const filterPanel = root.querySelector<HTMLElement>("[data-filter-panel]");
  const filterToggle = root.querySelector<HTMLButtonElement>("[data-filter-toggle]");
  const difficulty = root.querySelector<HTMLSelectElement>("[data-filter-difficulty]");
  const ai = root.querySelector<HTMLInputElement>("[data-filter-ai]");
  const reset = root.querySelector<HTMLElement>("[data-gallery-reset]");
  if (!grid || !loadMore || !count) return;

  let resources: PublicResource[] = [];
  let visibleCount = PAGE_SIZE;
  const selected = new Set<string>();

  try {
    const response = await fetch(root.dataset.galleryUrl ?? "", { credentials: "omit" });
    if (!response.ok) throw new Error(`gallery data failed with ${response.status}`);
    resources = await response.json() as PublicResource[];
    const params = new URLSearchParams(window.location.search);
    if (difficulty) difficulty.value = params.get("difficulty") ?? "";
    if (ai) ai.checked = params.get("ai") === "1";
    render();
  } catch (error) {
    console.error("Gallery data failed", error);
    count.textContent = "图片加载失败";
    return;
  }

  filterToggle?.addEventListener("click", () => {
    const open = filterPanel?.hasAttribute("hidden") ?? true;
    if (filterPanel) filterPanel.hidden = !open;
    filterToggle.setAttribute("aria-expanded", String(open));
  });
  difficulty?.addEventListener("change", applyFilter);
  ai?.addEventListener("change", applyFilter);
  reset?.addEventListener("click", (event) => {
    event.preventDefault();
    if (difficulty) difficulty.value = "";
    if (ai) ai.checked = false;
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
    updateBatchBar();
    button.setAttribute("aria-pressed", String(selected.has(id)));
    button.closest<HTMLElement>("[data-resource-card]")?.classList.toggle("is-selected", selected.has(id));
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-batch-download]")) {
    button.addEventListener("click", () => void downloadBatch(button.dataset.batchDownload === "upscaled"));
  }

  function currentResources(): PublicResource[] {
    const selectedDifficulty = difficulty?.value ?? "";
    const onlyAi = ai?.checked ?? false;
    return resources.filter((resource) => {
      const hasDifficulty = selectedDifficulty === "" || resource.variants.some((variant) => variant.difficulty === selectedDifficulty);
      const hasAi = !onlyAi || Boolean(resource.upscaled);
      return hasDifficulty && hasAi;
    });
  }

  function applyFilter(): void {
    visibleCount = PAGE_SIZE;
    const url = new URL(window.location.href);
    if (difficulty?.value) url.searchParams.set("difficulty", difficulty.value); else url.searchParams.delete("difficulty");
    if (ai?.checked) url.searchParams.set("ai", "1"); else url.searchParams.delete("ai");
    window.history.replaceState({}, "", url);
    render();
  }

  function render(): void {
    const filtered = currentResources();
    const visible = filtered.slice(0, visibleCount);
    grid!.replaceChildren(...visible.map((resource, index) => createCard(resource, index, selected.has(resource.resourceId))));
    count!.textContent = `显示 ${visible.length.toLocaleString("zh-CN")} / ${filtered.length.toLocaleString("zh-CN")}`;
    loadMore!.hidden = visible.length >= filtered.length;
    updateBatchBar();
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
  if (resource.resourceId) {
    const select = document.createElement("button");
    select.className = "resource-select";
    select.type = "button";
    select.dataset.selectResource = resource.resourceId;
    select.setAttribute("aria-pressed", String(isSelected));
    select.setAttribute("aria-label", `${isSelected ? "取消选择" : "选择"} ${resource.displayTitle}`);
    select.innerHTML = "<span aria-hidden=\"true\">✓</span>";
    article.append(select);
  }

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
    badge.className = "resource-badge is-ai";
    badge.textContent = "AI 超分";
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
  const variant = resource.variants.find((item) => item.label !== "默认");
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
