import { onPageLoad } from "./page-lifecycle";
import type { PublicDownload } from "../lib/types";
import { prepareImage } from "./viewport-images";

onPageLoad(() => {
  const root = document.querySelector<HTMLElement>("[data-story-composition]");
  if (root) {
    const variants = JSON.parse(root.dataset.variants ?? "[]") as Array<{ id: string; label: string; alt: string; original: PublicDownload; preview: string; overlay: boolean }>;
    const layer = root.querySelector<HTMLImageElement>("[data-cg-layer]")!;
    const base = root.querySelector<HTMLImageElement>("[data-cg-base]")!;
    const frames = root.querySelector<HTMLElement>("[data-cg-frames]")!;
    const background = root.querySelector<HTMLInputElement>("[data-cg-background]")!;
    const backgroundLabel = root.querySelector<HTMLElement>("[data-cg-background-label]")!;
    let selected = Math.max(0, variants.findIndex((variant) => variant.id === root.dataset.initialVariant));
    let originalRequested = false;
    const buttons = variants.map((variant, index) => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = variant.label;
      button.addEventListener("click", () => { if (selected === index) return; selected = index; originalRequested = true; render(); });
      return button;
    });
    function render() {
      const variant = variants[selected]!;
      const url = originalRequested ? variant.original.url : variant.preview;
      if (layer.getAttribute("src") !== url) { layer.src = url; prepareImage(layer); }
      layer.alt = variant.alt;
      backgroundLabel.hidden = !variant.overlay;
      base.hidden = !variant.overlay || !background.checked || !originalRequested;
      if (!base.hidden) {
        if (base.getAttribute("src") !== root!.dataset.backgroundUrl) { base.src = root!.dataset.backgroundUrl!; prepareImage(base); }
      } else base.removeAttribute("src");
      buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === selected)));
      root!.closest("[data-detail-root]")?.querySelectorAll<HTMLElement>("[data-download-panel]").forEach(panel => { panel.hidden = panel.dataset.downloadVariant !== variant.id; });
    }
    frames.append(...buttons);
    background.addEventListener("change", () => { originalRequested = true; render(); });
    render();
  }
});
