import { observeImage } from "./viewport-images";
import { reconcileList, setSurfaceVisible } from "./motion";
import { zipSync } from "fflate";
import { DownloadHttpError, reportDownloadFailure } from "../lib/resource-reports-client";
import { DOWNLOAD_CONCURRENCY, MAX_BATCH_BYTES, MAX_BATCH_FILES, readResponseBytesWithinLimit, toggleBatchSelection, uniqueZipFilename, type BatchResource } from "../lib/batch";
import { getBrowserStatsClient } from "../lib/stats-client";
import { sitePath } from "../lib/url";
import type { PublicDownload, PublicSearchImage } from "../lib/types";
import { pageSignal } from "./page-lifecycle";

type BatchTrayOptions = {
  root: HTMLElement;
  grid: HTMLElement;
  getResource: (resourceId: string) => BatchResource | undefined;
  onSelectionChange?: (selectedIds: readonly string[]) => void;
  onDetailLink?: (link: HTMLAnchorElement) => void;
  selectionScope?: string;
  onDownload: (preferUpscaled: boolean, selectedIds: readonly string[], setStatus: (value: string) => void, signal?: AbortSignal) => Promise<void>;
};

export type BatchTrayController = {
  clearSelection(): void;
  isSelected(resourceId: string): boolean;
  selectedIds(): string[];
  syncCards(): void;
  setBusy(busy: boolean): void;
  setStatus(value: string): void;
  isBusy(): boolean;
  downloadIds(ids: readonly string[], preferUpscaled: boolean, setStatus: (value: string) => void, signal: AbortSignal): Promise<void>;
};

export function createBatchTray(options: BatchTrayOptions): BatchTrayController {
  const signal = pageSignal();
  const tray = options.root.querySelector<HTMLElement>("[data-batch-tray]");
  const panel = options.root.querySelector<HTMLElement>("[data-batch-selected-panel]");
  const viewButton = options.root.querySelector<HTMLButtonElement>("[data-batch-view]");
  const closeButton = options.root.querySelector<HTMLButtonElement>("[data-batch-close]");
  const list = options.root.querySelector<HTMLElement>("[data-batch-selected-list]");
  const thumbs = options.root.querySelector<HTMLElement>("[data-batch-thumbs]");
  const count = options.root.querySelector<HTMLElement>("[data-batch-count]");
  const status = options.root.querySelector<HTMLElement>("[data-batch-status]");
  const selected = new Set<string>();
  const selectionKey = options.selectionScope ? "rhythm-archive-selection:" + options.selectionScope : undefined;
  try {
    const saved: unknown = JSON.parse(selectionKey ? sessionStorage.getItem(selectionKey) ?? "[]" : "[]");
    if (Array.isArray(saved)) for (const id of saved.slice(0, MAX_BATCH_FILES)) {
      if (typeof id === "string" && options.getResource(id)) selected.add(id);
    }
  } catch { /* In-memory selection still works without storage. */ }
  let panelOpen = false;
  let lastTrigger: HTMLButtonElement | null = null;
  let busy = false;

  if (!tray || !panel || !list || !thumbs || !count) {
    return {
      clearSelection: () => undefined,
      isSelected: () => false,
      selectedIds: () => [],
      syncCards: () => undefined,
      setBusy: () => undefined,
      setStatus: () => undefined,
      isBusy: () => false,
      downloadIds: async () => undefined,
    };
  }

  const controller: BatchTrayController = {
    clearSelection,
    isSelected: (resourceId) => selected.has(resourceId),
    selectedIds: () => [...selected],
    syncCards,
    setBusy,
    setStatus: (value) => { if (status) status.textContent = value; },
    isBusy: () => busy,
    downloadIds: (ids, preferUpscaled, setStatus, taskSignal) => startDownload(preferUpscaled, ids, setStatus, taskSignal),
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
  list.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(".batch-selected-link") : null;
    if (link && !event.defaultPrevented) options.onDetailLink?.(link);
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
    if (busy) return;
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
    const buttons = [...list!.querySelectorAll<HTMLButtonElement>("[data-batch-remove]")];
    const focusedIndex = buttons.findIndex((button) => button === document.activeElement && button.dataset.batchRemove === resourceId);
    if (busy || !selected.delete(resourceId)) return;
    controller.setStatus("");
    renderTray();
    if (focusedIndex >= 0) {
      const remaining = [...list!.querySelectorAll<HTMLButtonElement>(":scope > :not([data-motion-ghost]) [data-batch-remove]")];
      (remaining[Math.min(focusedIndex, remaining.length - 1)] ?? options.grid.querySelector<HTMLButtonElement>("[data-select-resource]") ?? options.root.querySelector<HTMLInputElement>('input[type="search"]'))?.focus({ preventScroll: true });
    }
    options.onSelectionChange?.([...selected]);
  }

  function clearSelection(): void {
    if (busy) return;
    const restoreFocus = tray!.contains(document.activeElement);
    selected.clear();
    controller.setStatus("");
    closePanel(false);
    renderTray();
    if (restoreFocus) (options.grid.querySelector<HTMLButtonElement>("[data-select-resource]") ?? options.root.querySelector<HTMLInputElement>('input[type="search"]'))?.focus({ preventScroll: true });
    options.onSelectionChange?.([]);
  }

  function openPanel(trigger: HTMLButtonElement): void {
    if (selected.size === 0 || busy) return;
    lastTrigger = trigger;
    panelOpen = true;
    void setSurfaceVisible(panel!, true);
    viewButton?.setAttribute("aria-expanded", "true");
    renderSelectedList();
    closeButton?.focus();
  }

  function closePanel(returnFocus: boolean): void {
    panelOpen = false;
    // The list stays painted through the exit; it is emptied only once hidden.
    void setSurfaceVisible(panel!, false).then((settled) => { if (settled && !panelOpen) list!.replaceChildren(); });
    viewButton?.setAttribute("aria-expanded", "false");
    const trigger = lastTrigger;
    lastTrigger = null;
    if (returnFocus && trigger?.isConnected) trigger.focus();
  }

  function renderTray(): void {
    try {
      if (selectionKey) {
        if (selected.size) sessionStorage.setItem(selectionKey, JSON.stringify([...selected]));
        else sessionStorage.removeItem(selectionKey);
      }
    } catch { /* Selection remains usable in this page. */ }
    void setSurfaceVisible(tray!, selected.size > 0);
    const upscaledButton = tray!.querySelector<HTMLButtonElement>('[data-batch-download="upscaled"]');
    if (upscaledButton) upscaledButton.hidden = ![...selected].some((resourceId) => Boolean(options.getResource(resourceId)?.upscaled || options.getResource(resourceId)?.hasUpscaled));
    options.root.classList.toggle("has-selection", selected.size > 0);
    count!.textContent = "已选择 " + selected.size.toLocaleString("zh-CN") + " / " + MAX_BATCH_FILES + " 项";
    renderThumbnails();
    if (panelOpen || selected.size === 0) renderSelectedList();
    syncCards();
    if (selected.size === 0 && panelOpen) closePanel(true);
  }

  function renderThumbnails(): void {
    const resources = [...selected]
      .map((resourceId) => options.getResource(resourceId))
      .filter((resource): resource is BatchResource => Boolean(resource));
    const visible = resources.slice(0, 4);
    const existing = new Map([...thumbs!.querySelectorAll<HTMLImageElement>("img[data-resource-id]:not([data-motion-ghost])")].map((image) => [image.dataset.resourceId, image]));
    const next: HTMLElement[] = visible.map((resource) => existing.get(resource.resourceId) ?? createThumbnail(resource));
    const remaining = selected.size - visible.length;
    if (remaining > 0) {
      const more = thumbs!.querySelector<HTMLSpanElement>(".batch-tray-thumb-more:not([data-motion-ghost])") ?? document.createElement("span");
      more.className = "batch-tray-thumb-more";
      more.textContent = "+" + remaining;
      next.push(more);
    }
    reconcileList(thumbs!, next, (node) => node.dataset.resourceId ?? "more");
  }

  function renderSelectedList(): void {
    const resources = [...selected]
      .map((resourceId) => ({ resourceId, resource: options.getResource(resourceId) }))
      .filter((entry): entry is { resourceId: string; resource: BatchResource } => Boolean(entry.resource));
    const rows = new Map([...list!.children].filter((row) => !row.hasAttribute("data-motion-ghost")).map((row) => [(row as HTMLElement).dataset.resourceId, row]));
    const next = resources.map(({ resourceId, resource }) => {
      const existing = rows.get(resourceId);
      if (existing) return existing;
      const row = document.createElement("div");
      row.className = "batch-selected-item";
      row.dataset.resourceId = resourceId;
      const link = document.createElement("a");
      link.className = "batch-selected-link";
      link.dataset.resourceId = resourceId;
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
      remove.disabled = busy;
      row.append(link, remove);
      return row;
    });
    reconcileList(list!, next as HTMLElement[], (row) => row.dataset.resourceId);
  }

  function syncCards(): void {
    for (const button of options.grid.querySelectorAll<HTMLButtonElement>("[data-select-resource]")) {
      const resourceId = button.dataset.selectResource;
      if (!resourceId) continue;
      const selectedState = selected.has(resourceId);
      const title = button.closest<HTMLElement>("[data-resource-card]")?.querySelector("h3")?.textContent?.trim() || "资源";
      button.setAttribute("aria-pressed", String(selectedState));
      button.disabled = busy;
      button.setAttribute("aria-label", (selectedState ? "取消选择 " : "选择 ") + title);
      button.closest<HTMLElement>("[data-resource-card]")?.classList.toggle("is-selected", selectedState);
    }
  }

  function setBusy(value: boolean): void {
    busy = value;
    for (const button of tray!.querySelectorAll<HTMLButtonElement>("[data-batch-download], [data-batch-clear], [data-batch-view], [data-batch-remove]")) button.disabled = value;
    syncCards();
    options.root.dispatchEvent(new Event("batch:busy-change"));
  }

  async function startDownload(preferUpscaled: boolean, ids: readonly string[] = [...selected], setStatus = controller.setStatus, taskSignal?: AbortSignal): Promise<void> {
    if (busy) return;
    const snapshot = Object.freeze([...new Set(ids)]);
    if (snapshot.length === 0 || snapshot.length > MAX_BATCH_FILES) {
      setStatus(snapshot.length ? `最多选择 ${MAX_BATCH_FILES} 项，请减少选择。` : "没有符合条件的资源。");
      return;
    }
    setBusy(true);
    setStatus("正在读取下载信息…");
    try {
      await options.onDownload(preferUpscaled, snapshot, setStatus, taskSignal);
    } finally {
      if (!signal.aborted && options.root.isConnected) setBusy(false);
    }
  }
}

export async function downloadSelectedBatchFromManifest(options: {
  selectedIds: readonly string[];
  getResource: (resourceId: string) => BatchResource | undefined;
  manifestUrl: string | string[];
  preferUpscaled: boolean;
  filename: string;
  setStatus: (value: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const page = pageSignal();
  const signal = options.signal ? AbortSignal.any([page, options.signal]) : page;
  if (options.selectedIds.length === 0 || options.selectedIds.length > MAX_BATCH_FILES) {
    options.setStatus(options.selectedIds.length ? `最多选择 ${MAX_BATCH_FILES} 项，请减少选择。` : "没有符合条件的资源。");
    return;
  }
  try {
    signal.throwIfAborted();
    const urls = typeof options.manifestUrl === "string" ? [options.manifestUrl] : options.manifestUrl;
    const manifests = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url, { credentials: "omit", signal });
      if (!response.ok) throw new Error(`batch manifest failed with ${response.status}`);
      return await response.json() as Record<string, Pick<BatchResource, "original" | "upscaled">>;
    }));
    signal.throwIfAborted();
    const downloads = Object.assign({}, ...manifests) as Record<string, Pick<BatchResource, "original" | "upscaled">>;
    await downloadSelectedBatch({
      ...options,
      getResource: (resourceId) => {
        const card = options.getResource(resourceId);
        return card ? { ...card, ...downloads[resourceId] } : undefined;
      },
    });
  } catch (error) {
    if (signal.aborted) { if (!page.aborted) options.setStatus("下载已取消"); return; }
    console.error("Batch manifest failed", error);
    options.setStatus("下载失败，请重试");
  }
}

export async function downloadSelectedBatch(options: {
  selectedIds: readonly string[];
  getResource: (resourceId: string) => BatchResource | undefined;
  preferUpscaled: boolean;
  filename: string;
  setStatus: (value: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (options.selectedIds.length === 0) return;
  if (options.selectedIds.length > MAX_BATCH_FILES) {
    options.setStatus("最多选择 " + MAX_BATCH_FILES + " 项，请减少选择。");
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
    options.setStatus("所选文件总大小超过 " + MAX_BATCH_BYTES / (1024 * 1024) + " MiB，请减少选择。");
    return;
  }

  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  let downloadedBytes = 0;
  let completed = 0;
  const controller = new AbortController();
  const page = pageSignal();
  const signal = AbortSignal.any([controller.signal, page, ...(options.signal ? [options.signal] : [])]);
  const objects = new Map<string, Promise<Uint8Array>>();
  options.setStatus("正在准备 0 / " + items.length);
  try {
    await runWithConcurrency(items, DOWNLOAD_CONCURRENCY, async ({ download, resource }) => {
      signal.throwIfAborted();
      let bytes = objects.get(download.url);
      if (!bytes) {
        bytes = (async () => {
          const response = await fetch(download.url, { credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin", signal });
          if (!response.ok) throw new DownloadHttpError(response.status);
          return await readResponseBytesWithinLimit(response, MAX_BATCH_BYTES - downloadedBytes, (size) => {
            if (downloadedBytes + size > MAX_BATCH_BYTES) throw new Error("batch download exceeds the maximum size");
            downloadedBytes += size;
          });
        })().catch((error) => {
          if (!signal.aborted) reportDownloadFailure(resource.resourceId, error);
          controller.abort(); throw error;
        });
        objects.set(download.url, bytes);
      }
      entries[uniqueZipFilename(usedNames, download.downloadFilename)] = await bytes;
      completed += 1;
      options.setStatus("正在准备 " + completed + " / " + items.length);
    });
    signal.throwIfAborted();
    options.setStatus("正在整理文件…");
    const archive = zipSync(entries, { level: 0 });
    const objectUrl = URL.createObjectURL(new Blob([archive], { type: "application/zip" }));
    triggerDownload(objectUrl, options.filename);
    const statsClient = getBrowserStatsClient();
    for (const item of items) void statsClient.trackResourceDownload(item.resource.resourceId);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    options.setStatus("已开始下载");
  } catch (error) {
    if (page.aborted) return;
    if (options.signal?.aborted) { options.setStatus("下载已取消"); return; }
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
  image.dataset.resourceId = resource.resourceId;
  const preview = pickPreview(resource.preview);
  if (!preview) {
    image.alt = "";
    return image;
  }
  image.dataset.viewportSrc = preview.primary.url;
  if (preview.primary.width) image.width = preview.primary.width;
  if (preview.primary.height) image.height = preview.primary.height;
  image.alt = resource.displayTitle;
  if (preview.fallback) {
    image.dataset.fallbackSrc = preview.fallback.url;
    if (preview.fallback.width) image.dataset.fallbackWidth = String(preview.fallback.width);
    if (preview.fallback.height) image.dataset.fallbackHeight = String(preview.fallback.height);
  }
  image.loading = "lazy";
  image.decoding = "async";
  observeImage(image);
  return image;
}

function pickPreview(preview: BatchResource["preview"]): { primary: PublicSearchImage; fallback?: PublicSearchImage } | undefined {
  const candidates = [preview.small, preview.medium, preview.large].filter((candidate): candidate is PublicSearchImage => Boolean(candidate));
  const primary = candidates[0];
  if (!primary) return undefined;
  return { primary, ...(candidates[1] ? { fallback: candidates[1] } : {}) };
}

function getFocusable(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
}

function resolveSitePath(root: HTMLElement, route: string): string {
  const base = root.dataset.basePath ?? document.documentElement.dataset.basePath ?? "/";
  return sitePath(route, base);
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
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
