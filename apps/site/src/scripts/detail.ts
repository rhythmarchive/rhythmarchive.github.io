import { downloadRendition } from "./download";

const root = document.querySelector<HTMLElement>("[data-detail-root]");
if (root) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-variant-select]")) {
    button.addEventListener("click", () => {
      const variantId = button.dataset.variantSelect;
      if (!variantId) return;
      for (const panel of root.querySelectorAll<HTMLElement>("[data-variant-panel]")) panel.hidden = panel.dataset.variantPanel !== variantId;
      for (const panel of root.querySelectorAll<HTMLElement>("[data-download-variant]")) panel.hidden = panel.dataset.downloadVariant !== variantId;
      for (const item of root.querySelectorAll<HTMLButtonElement>("[data-variant-select]")) {
        const active = item.dataset.variantSelect === variantId;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      }
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-download-kind]")) {
    button.addEventListener("click", () => void downloadRendition(button));
  }
}
