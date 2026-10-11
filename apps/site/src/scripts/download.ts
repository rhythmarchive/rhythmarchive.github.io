import { getBrowserStatsClient } from "../lib/stats-client";
import { DownloadHttpError, reportDownloadFailure } from "../lib/resource-reports-client";

export async function downloadRendition(button: HTMLButtonElement): Promise<void> {
  const url = button.dataset.downloadUrl;
  const filename = button.dataset.downloadFilename;
  const panel = button.closest<HTMLElement>("[data-download-panel]");
  const status = panel?.querySelector<HTMLElement>("[data-download-status]");
  if (!url || !filename || button.disabled) return;
  const resourceId = button.dataset.resourceId ?? button.closest<HTMLElement>("[data-detail-root]")?.dataset.resourceId;

  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "<span>下载中…</span>";
  if (status) status.textContent = "下载中…";
  let canOpenDirectly = true;
  let fetched = false;
  try {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "strict-origin-when-cross-origin" });
    if (!response.ok) {
      canOpenDirectly = false;
      throw new DownloadHttpError(response.status);
    }
    const blob = await response.blob();
    fetched = true;
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, filename);
    if (resourceId) void getBrowserStatsClient().trackResourceDownload(resourceId);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    if (status) status.textContent = "";
  } catch (error) {
    if (resourceId && !fetched) reportDownloadFailure(resourceId, error);
    console.error("Resource download failed", error);
    if (canOpenDirectly) triggerDirectDownload(url, filename);
    if (status) status.textContent = canOpenDirectly
      ? "下载失败，已尝试打开文件链接。如未开始下载，请重试。"
      : "下载失败，请稍后重试。";
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
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

function triggerDirectDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.referrerPolicy = "strict-origin-when-cross-origin";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
