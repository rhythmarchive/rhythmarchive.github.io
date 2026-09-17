import { zipSync } from "fflate";
import { DOWNLOAD_CONCURRENCY, MAX_BATCH_BYTES, MAX_BATCH_FILES, toggleBatchSelection, uniqueZipFilename, type BatchResource } from "../lib/batch";
import { getBrowserStatsClient } from "../lib/stats-client";
import type { PublicDownload, PublicPreview } from "../lib/types";

type BatchTrayOptions = {
  root: HTMLElement;
  grid: HTMLElement;
  getResource: (resourceId: string) => BatchResource | undefined;
  onSelectionChange?: (selectedIds: readonly string[]) => void;
  onDownload: (preferUpscaled: boolean, selectedIds: readonly string[], setStatus: (value: string) => void) => Promise<void>;
};

export type BatchTrayController = {
  isSelected(resourceId: string): boolean;
  selectedIds(): string[];
  syncCards(): void;
  setBusy(busy: boolean): void;
  setStatus(value: string): void;
};

export function createBatchTray(options: BatchTrayOptions): BatchTrayController {
  const tray = options.root.querySelector<HTMLElement>("[data-batch-tray]");
  const panel = options.root.querySelector<HTMLElement>("[data-batch-selected-panel]");
  const viewButton = options.root.querySelector<HTMLButtonElement>("[data-batch-view]");
  const closeButton = options.root.querySelector<HTMLButtonElement>("[data-batch-close]");
  const list = options.root.querySelector<HTMLElement>("[data-batch-selected-list]");
  const thumbs = options.root.querySelector<HTMLElement>("[data-batch-thumbs]");
  const count = options.root.querySelector<HTMLElement>("[data-batch-count]");
  const status = options.root.querySelector<HTMLElement>("[data-batch-status]");
  const selected = new Set<string>();
  let panelOpen = false;
  let lastTrigger: HTMLButtonElement | null = null;
  let busy = false;

  if (!tray || !panel || !list || !thumbs || !count) {
    return {
      isSelected: () => false,
      selectedIds: () => [],
      syncCards: () => undefined,
      setBusy: () => undefined,
      setStatus: () => undefined,
    };
  }

  const controller: BatchTrayController = {
    isSelected: (resourceId) => selected.has(resourceId),
    selectedIds: () => [...selected],
    syncCards,
    setBusy,
    setStatus: (value) => { if (status) status.textContent = value; },
  };

  options.grid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-select-resource]");
    const resourceId = button?.dataset.selectResource;
    if (!button || !resourceId) return;
    event.preventDefault();
    event.stopPropagation();
    toggle(resourceId);
  });

  tray.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const clear = target.closest<HTMLButtonElement>("[data-batch-clear]");
    if (clear) {
      event.preventDefault();
      clearSelection();
      return;
    }
    const view = target.closest<HTMLButtonElement>("[data-batch-view]");
    if (view) {
      event.preventDefault();
      if (panelOpen) closePanel(true); else openPanel(view);
      return;
    }
    const close = target.closest<HTMLButtonElement>("[data-batch-close]");
    if (close) {
      event.preventDefault();
      closePanel(true);
      return;
    }
    const remove = target.closest<HTMLButtonElement>("[data-batch-remove]");
    const removeId = remove?.dataset.batchRemove;
    if (remove && removeId) {
      event.preventDefault();
      removeSelection(removeId);
      return;
    }
    const download = target.closest<HTMLButtonElement>("[data-batch-download]");
    if (download) {
      event.preventDefault();
      void startDownload(download.dataset.batchDownload === "upscaled");
    }
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel(true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusable(panel);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  renderTray();
  return controller;

  function toggle(resourceId: string): void {
    const result = toggleBatchSelection([...selected], resourceId, MAX_BATCH_FILES);
    if (result.limited) {
      controller.setStatus("最多选择 " + MAX_BATCH_FILES + " 项。");
      return;
    }
    selected.clear();
    for (const id of result.selected) selected.add(id);
    controller.setStatus("");
    renderTray();
    options.onSelectionChange?.([...selected]);
  }

  function removeSelection(resourceId: string): void {
    if (busy || !selected.delete(resourceId)) return;
    controller.setStatus("");
    renderTray();
    options.onSelectionChange?.([...selected]);
  }

  function clearSelection(): void {
    if (busy) return;
    selected.clear();
    controller.setStatus("");
    closePanel(false);
    renderTray();
    options.onSelectionChange?.([]);
  }

  function openPanel(trigger: HTMLButtonElement): void {
    if (selected.size === 0 || busy) return;
    lastTrigger = trigger;
    panelOpen = true;
    panel!.hidden = false;
    viewButton?.setAttribute("aria-expanded", "true");
    closeButton?.focus();
  }

  function closePanel(returnFocus: boolean): void {
    panelOpen = false;
    panel!.hidden = true;
    viewButton?.setAttribute("aria-expanded", "false");
    const trigger = lastTrigger;
    lastTrigger = null;
    if (returnFocus && trigger?.isConnected) trigger.focus();
  }

  function renderTray(): void {
    tray!.hidden = selected.size === 0;
    options.root.classList.toggle("has-selection", selected.size > 0);
    count!.textContent = "已选择 " + selected.size.toLocaleString("zh-CN") + " / " + MAX_BATCH_FILES + " 项";
    renderThumbnails();
    renderSelectedList();
    syncCards();
    if (selected.size === 0 && panelOpen) closePanel(false);
  }

  function renderThumbnails(): void {
    const resources = [...selected]
      .map((resourceId) => options.getResource(resourceId))
      .filter((resource): resource is BatchResource => Boolean(resource));
    const visible = resources.slice(0, 4);
    thumbs!.replaceChildren(...visible.map((resource) => createThumbnail(resource)));
    const remaining = selected.size - visible.length;
    if (remaining > 0) {
      const more = document.createElement("span");
      more.className = "batch-tray-thumb-more";
      more.textContent = "+" + remaining;
      thumbs!.append(more);
    }
  }

  function renderSelectedList(): void {
    const resources = [...selected]
      .map((resourceId) => ({ resourceId, resource: options.getResource(resourceId) }))
      .filter((entry): entry is { resourceId: string; resource: BatchResource } => Boolean(entry.resource));
    list!.replaceChildren(...resources.map(({ resourceId, resource }) => {
      const row = document.createElement("div");
      row.className = "batch-selected-item";
      const link = document.createElement("a");
      link.className = "batch-selected-link";
      link.href = resolveSitePath(options.root, resource.route);
      const image = createThumbnail(resource, "batch-selected-image");
      image.alt = "";
      const title = document.createElement("span");
      title.textContent = resource.displayTitle;
      link.append(image, title);
      const remove = document.createElement("button");
      remove.className = "batch-selected-remove";
      remove.type = "button";
      remove.dataset.batchRemove = resourceId;
      remove.setAttribute("aria-label", "取消选择 " + resource.displayTitle);
      remove.textContent = "×";
      row.append(link, remove);
      return row;
    }));
  }

  function syncCards(): void {
    for (const button of options.grid.querySelectorAll<HTMLButtonElement>("[data-select-resource]")) {
      const resourceId = button.dataset.selectResource;
      if (!resourceId) continue;
      const selectedState = selected.has(resourceId);
      const title = button.closest<HTMLElement>("[data-resource-card]")?.querySelector("h3")?.textContent?.trim() || "资源";
      button.setAttribute("aria-pressed", String(selectedState));
      button.setAttribute("aria-label", (selectedState ? "取消选择 " : "选择 ") + title);
      button.closest<HTMLElement>("[data-resource-card]")?.classList.toggle("is-selected", selectedState);
    }
  }

  function setBusy(value: boolean): void {
    busy = value;
    for (const button of tray!.querySelectorAll<HTMLButtonElement>("[data-batch-download], [data-batch-clear], [data-batch-view], [data-batch-close], [data-batch-remove]")) button.disabled = value;
  }

  async function startDownload(preferUpscaled: boolean): Promise<void> {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      await options.onDownload(preferUpscaled, [...selected], controller.setStatus);
    } finally {
      setBusy(false);
    }
  }
}

export async function downloadSelectedBatch(options: {
  selectedIds: readonly string[];
  getResource: (resourceId: string) => BatchResource | undefined;
  preferUpscaled: boolean;
  filename: string;
  setStatus: (value: string) => void;
}): Promise<void> {
  if (options.selectedIds.length === 0) return;
  if (options.selectedIds.length > MAX_BATCH_FILES) {
    options.setStatus("一次选择的文件较多，请减少后再下载。");
    return;
  }
  const resolved = options.selectedIds.map((resourceId) => {
    const resource = options.getResource(resourceId);
    return resource ? { resource, download: chooseDownload(resource, options.preferUpscaled) } : undefined;
  });
  if (resolved.some((item) => !item?.download)) {
    options.setStatus("下载失败，请重试");
    return;
  }
  const items = resolved as Array<{ resource: BatchResource; download: PublicDownload }>;
  const totalBytes = items.reduce((sum, item) => sum + item.download.sizeBytes, 0);
  if (totalBytes > MAX_BATCH_BYTES) {
    options.setStatus("一次选择的文件较多，请减少后再下载。");
    return;
  }

  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  let completed = 0;
  options.setStatus("正在准备 0 / " + items.length);
  try {
    await runWithConcurrency(items, DOWNLOAD_CONCURRENCY, async ({ download }) => {
      const response = await fetch(download.url, { credentials: "omit" });
      if (!response.ok) throw new Error("download failed with " + response.status);
      entries[uniqueZipFilename(usedNames, download.downloadFilename)] = new Uint8Array(await response.arrayBuffer());
      completed += 1;
      options.setStatus("正在准备 " + completed + " / " + items.length);
    });
    const archive = zipSync(entries, { level: 0 });
    const objectUrl = URL.createObjectURL(new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }));
    triggerDownload(objectUrl, options.filename);
    const statsClient = getBrowserStatsClient();
    for (const item of items) void statsClient.trackResourceDownload(item.resource.resourceId);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    options.setStatus("");
  } catch (error) {
    console.error("Batch download failed", error);
    options.setStatus("下载失败，请重试");
  }
}

function chooseDownload(resource: BatchResource, preferUpscaled: boolean): PublicDownload | undefined {
  return preferUpscaled ? resource.upscaled ?? resource.original : resource.original;
}

function createThumbnail(resource: BatchResource, className = "batch-tray-thumb"): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  const preview = pickPreview(resource.preview);
  if (!preview) {
    image.alt = "";
    return image;
  }
  image.src = preview.primary.url;
  image.width = preview.primary.width;
  image.height = preview.primary.height;
  image.alt = resource.displayTitle;
  if (preview.fallback) {
    image.dataset.fallbackSrc = preview.fallback.url;
    if (preview.fallback.width) image.dataset.fallbackWidth = String(preview.fallback.width);
    if (preview.fallback.height) image.dataset.fallbackHeight = String(preview.fallback.height);
  }
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function pickPreview(preview: PublicPreview): { primary: NonNullable<PublicPreview["small"]>; fallback?: NonNullable<PublicPreview["small"]> } | undefined {
  const candidates = [preview.small, preview.medium, preview.large].filter((candidate): candidate is NonNullable<PublicPreview["small"]> => Boolean(candidate));
  const primary = candidates[0];
  if (!primary) return undefined;
  return { primary, ...(candidates[1] ? { fallback: candidates[1] } : {}) };
}

function getFocusable(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
}

function resolveSitePath(root: HTMLElement, route: string): string {
  const base = root.dataset.basePath ?? document.documentElement.dataset.basePath ?? "/";
  const clean = route.startsWith("/") ? route : "/" + route;
  return base === "/" ? clean : base.replace(/\/+$/u, "") + clean;
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