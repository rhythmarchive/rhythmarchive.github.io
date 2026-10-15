import { MAX_BATCH_FILES, resultBatchLimitMessage, type BatchResource } from "../lib/batch";
import type { BatchTrayController } from "./batch-tray";
import { onPageCleanup, pageSignal } from "./page-lifecycle";
import { setSurfaceVisible } from "./motion";

export function setupGalleryDownload(root: HTMLElement, getResults: () => readonly BatchResource[], tray: BatchTrayController, flush: () => void) {
  const trigger = root.querySelector<HTMLButtonElement>("[data-result-download]")!;
  const limit = root.querySelector<HTMLElement>("[data-result-limit]")!;
  const dialog = root.querySelector<HTMLDialogElement>("[data-result-dialog]")!;
  const summary = root.querySelector<HTMLElement>("[data-result-summary]")!;
  const confirm = root.querySelector<HTMLButtonElement>("[data-result-confirm]")!;
  const version = root.querySelector<HTMLSelectElement>("[data-result-version]")!;
  const progress = root.querySelector<HTMLElement>("[data-result-progress]")!;
  const status = root.querySelector<HTMLElement>("[data-result-status]")!;
  const cancel = root.querySelector<HTMLButtonElement>("[data-result-cancel]")!;
  const signal = pageSignal();
  let task: AbortController | undefined;
  let closing = false;
  let overflow = "";
  const update = () => {
    const results = getResults();
    const message = resultBatchLimitMessage(results.length);
    trigger.disabled = Boolean(message) || tray.isBusy();
    trigger.title = message ?? "打包全部匹配结果";
    // The full count already sits beside the button; keep mobile guidance short.
    limit.textContent = results.length === 0 ? "暂无可打包结果" : results.length > MAX_BATCH_FILES ? `超出单次 ${MAX_BATCH_FILES} 项上限，请缩小筛选范围` : `单次最多 ${MAX_BATCH_FILES} 项`;
    summary.textContent = message ?? `将下载当前全部 ${results.length.toLocaleString("zh-CN")} 项结果。`;
    confirm.disabled = Boolean(message) || tray.isBusy();
    const upscale = version.querySelector<HTMLOptionElement>('[value="upscaled"]')!;
    upscale.disabled = !results.some((resource) => resource.hasUpscaled || resource.upscaled);
    if (upscale.disabled) version.value = "original";
  };
  const close = async () => {
    if (!dialog.open || closing) return;
    closing = true;
    const settled = await setSurfaceVisible(dialog, false, "fade");
    if (!settled || signal.aborted) return;
    dialog.close(); dialog.hidden = false; closing = false;
    document.documentElement.style.overflow = overflow;
    if (!trigger.disabled) trigger.focus({ preventScroll: true });
    else root.querySelector<HTMLInputElement>('.gallery-search input')?.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", () => {
    flush(); update();
    if (trigger.disabled || dialog.open || closing) return;
    version.value = "original";
    root.querySelector<HTMLElement>("[data-result-upscale-note]")!.hidden = true;
    overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal(); void setSurfaceVisible(dialog, true, "fade");
    confirm.focus({ preventScroll: true });
  });
  version.addEventListener("change", () => { root.querySelector<HTMLElement>("[data-result-upscale-note]")!.hidden = version.value !== "upscaled"; });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void close(); });
  for (const button of dialog.querySelectorAll("[data-result-close]")) button.addEventListener("click", () => void close());
  cancel.addEventListener("click", () => { task?.abort(); });
  confirm.addEventListener("click", async () => {
    flush(); update();
    if (confirm.disabled) return;
    // Snapshot the entire matching set, including its selected artwork IDs.
    const ids = getResults().map((resource) => resource.resourceId);
    const controller = new AbortController(); task = controller;
    progress.hidden = false; cancel.hidden = false;
    const setStatus = (value: string) => { if (!signal.aborted) status.textContent = `本次 ${ids.length} 项 · ${value}`; };
    const pending = tray.downloadIds(ids, version.value === "upscaled", setStatus, controller.signal);
    void close();
    try { await pending; } catch { setStatus(controller.signal.aborted ? "下载已取消" : "下载失败，请重试"); }
    finally {
      if (!signal.aborted && task === controller) { task = undefined; cancel.hidden = true; update(); }
    }
  });
  root.addEventListener("batch:busy-change", update, { signal });
  onPageCleanup(() => { task?.abort(); if (dialog.open) document.documentElement.style.overflow = overflow; void setSurfaceVisible(dialog, false, "instant"); dialog.close(); });
  update();
  return { update };
}
