import type { PublicDownload } from "../lib/types";
import { downloadRendition } from "./download";

const root = document.querySelector<HTMLElement>("[data-story-composition]");
if (root) {
  const variants = JSON.parse(root.dataset.variants ?? "[]") as Array<{ id: string; label: string; original: PublicDownload; preview: string; overlay: boolean }>;
  const layer = root.querySelector<HTMLImageElement>("[data-cg-layer]")!;
  const base = root.querySelector<HTMLImageElement>("[data-cg-base]")!;
  const frames = root.querySelector<HTMLElement>("[data-cg-frames]")!;
  const background = root.querySelector<HTMLInputElement>("[data-cg-background]")!;
  const backgroundLabel = root.querySelector<HTMLElement>("[data-cg-background-label]")!;
  const download = root.querySelector<HTMLButtonElement>("[data-cg-download]")!;
  let selected = 0;
  let originalRequested = false;
  const buttons = variants.map((variant, index) => {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = variant.label;
    button.addEventListener("click", () => { selected = index; originalRequested = true; render(); });
    return button;
  });
  function render() {
    const variant = variants[selected]!;
    layer.src = originalRequested ? variant.original.url : variant.preview;
    layer.alt = variant.label;
    backgroundLabel.hidden = !variant.overlay;
    base.hidden = !variant.overlay || !background.checked || !originalRequested;
    if (!base.hidden) base.src = root!.dataset.backgroundUrl!;
    else base.removeAttribute("src");
    download.dataset.downloadUrl = variant.original.url;
    download.dataset.downloadFilename = variant.original.downloadFilename;
    buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === selected)));
    root!.closest("[data-detail-root]")?.querySelectorAll<HTMLElement>("[data-download-panel]").forEach(panel => { panel.hidden = panel.dataset.downloadVariant !== variant.id; });
  }
  frames.append(...buttons);
  background.addEventListener("change", () => { originalRequested = true; render(); });
  download.addEventListener("click", () => void downloadRendition(download));
  render();
}
