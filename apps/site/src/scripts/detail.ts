import { downloadRendition } from "./download";

const root = document.querySelector<HTMLElement>("[data-detail-root]");
if (root) {
  const lightbox = root.querySelector<HTMLElement>("[data-detail-lightbox]");
  const lightboxImage = root.querySelector<HTMLImageElement>("[data-lightbox-image]");
  const lightboxCloseButton = root.querySelector<HTMLButtonElement>(".detail-lightbox-close");
  let lastLightboxTrigger: HTMLButtonElement | null = null;

  const closeLightbox = (): void => {
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    lightboxImage?.removeAttribute("src");
    document.body.classList.remove("detail-lightbox-open");
    lastLightboxTrigger?.focus();
    lastLightboxTrigger = null;
  };

  const openLightbox = (trigger: HTMLButtonElement): void => {
    const url = trigger.dataset.lightboxPreviewUrl;
    if (!lightbox || !lightboxImage || !url) return;
    lastLightboxTrigger = trigger;
    lightboxImage.src = url;
    lightboxImage.alt = trigger.dataset.lightboxPreviewAlt ?? "资源大图";
    const width = Number(trigger.dataset.lightboxPreviewWidth);
    const height = Number(trigger.dataset.lightboxPreviewHeight);
    if (Number.isFinite(width) && width > 0) lightboxImage.width = width;
    if (Number.isFinite(height) && height > 0) lightboxImage.height = height;
    lightbox.hidden = false;
    document.body.classList.add("detail-lightbox-open");
    lightboxCloseButton?.focus();
  };

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-variant-select]")) {
    button.addEventListener("click", () => {
      const variantId = button.dataset.variantSelect;
      if (!variantId) return;
      closeLightbox();
      for (const panel of root.querySelectorAll<HTMLElement>("[data-variant-panel]")) panel.hidden = panel.dataset.variantPanel !== variantId;
      for (const panel of root.querySelectorAll<HTMLElement>("[data-download-variant]")) panel.hidden = panel.dataset.downloadVariant !== variantId;
      for (const item of root.querySelectorAll<HTMLButtonElement>("[data-variant-select]")) {
        const active = item.dataset.variantSelect === variantId;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      }
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-detail-source-select]")) {
    button.addEventListener("click", () => {
      const source = button.dataset.detailSourceSelect;
      const panelRoot = button.closest<HTMLElement>("[data-variant-panel]");
      if (!source || !panelRoot) return;
      closeLightbox();
      for (const panel of panelRoot.querySelectorAll<HTMLElement>("[data-detail-source-panel]")) panel.hidden = panel.dataset.detailSourcePanel !== source;
      for (const item of panelRoot.querySelectorAll<HTMLButtonElement>("[data-detail-source-select]")) {
        const active = item.dataset.detailSourceSelect === source;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      }
    });
  }

  for (const trigger of root.querySelectorAll<HTMLButtonElement>("[data-lightbox-open]")) {
    trigger.addEventListener("click", () => openLightbox(trigger));
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-lightbox-close]")) {
    button.addEventListener("click", closeLightbox);
  }
  document.addEventListener("keydown", (event) => {
    if (!lightbox || lightbox.hidden) return;
    if (event.key === "Escape") {
      closeLightbox();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(lightbox.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const activeInside = lightbox.contains(document.activeElement);
    if (event.shiftKey && (!activeInside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-download-kind]")) {
    button.addEventListener("click", () => void downloadRendition(button));
  }
}
