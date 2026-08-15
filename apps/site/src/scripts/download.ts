export async function downloadRendition(button: HTMLButtonElement): Promise<void> {
  const url = button.dataset.downloadUrl;
  const filename = button.dataset.downloadFilename;
  const panel = button.closest<HTMLElement>("[data-download-panel]");
  const status = panel?.querySelector<HTMLElement>("[data-download-status]");
  if (!url || !filename) return;

  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "<span>下载中…</span>";
  if (status) status.textContent = "下载中…";
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`download failed with ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, filename);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    if (status) status.textContent = "";
  } catch (error) {
    console.error("Resource download failed", error);
    if (status) status.textContent = "下载失败，请重试";
    triggerDirectDownload(url, filename);
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
  anchor.rel = "noopener noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
