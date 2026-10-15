import { onPageLoad, pageSignal, onPageCleanup } from "./page-lifecycle";
import { navigate } from "astro:transitions/client";
import { loadSelectedDetailImages, prepareImage } from "./viewport-images";
import { downloadRendition } from "./download";
import { setupDetailNavigation } from "./list-navigation";
import { setupDetailLibrary } from "./detail-library";
import { animateLightboxImage, revealContent, setSurfaceVisible } from "./motion";
import { getBrowserStatsClient, updateResourceStatsInDom } from "../lib/stats-client";

onPageLoad(() => {
  const root = document.querySelector<HTMLElement>("[data-detail-root]");
  if (root) {
    const signal = pageSignal();
    onPageCleanup(() => document.body.classList.remove("detail-lightbox-open"));
    setupDetailNavigation(root);
    setupDetailLibrary(root);
    const resourceId = root.dataset.resourceId;
    const statsClient = getBrowserStatsClient();
    if (resourceId) {
      void statsClient.trackResourceDetail(resourceId).then((stats) => {
        if (signal.aborted || !stats) return;
        const node = root.querySelector<HTMLElement>("[data-detail-resource-stats]");
        const value = root.querySelector<HTMLElement>("[data-detail-resource-views]");
        if (!node || !value) return;
        value.textContent = stats.views.toLocaleString("zh-CN");
        node.removeAttribute("data-stats-pending");
        node.removeAttribute("aria-hidden");
      });
    }
    void updateResourceStatsInDom(root);
    const lightbox = root.querySelector<HTMLElement>("[data-detail-lightbox]");
    const lightboxImage = root.querySelector<HTMLImageElement>("[data-lightbox-image]");
    const lightboxCloseButton = root.querySelector<HTMLButtonElement>(".detail-lightbox-close");
    const compositionStage = root.querySelector<HTMLElement>("[data-cg-stage]");
    const compositionParent = compositionStage?.parentElement;
    let lastLightboxTrigger: HTMLButtonElement | null = null;

    const closeLightbox = (): void => {
      if (!lightbox || lightbox.hidden || lightbox.inert) return;
      const trigger = lastLightboxTrigger;
      if (lightboxImage && trigger && !compositionStage) animateLightboxImage(lightboxImage, trigger, false);
      void setSurfaceVisible(lightbox, false, "fade").then((closed) => {
        if (!closed || !lightbox.hidden || signal.aborted) return;
        lightboxImage?.removeAttribute("src");
        if (compositionStage && compositionParent) compositionParent.prepend(compositionStage);
        document.body.classList.remove("detail-lightbox-open");
        trigger?.focus({ preventScroll: true });
        lastLightboxTrigger = null;
      });
      history.replaceState({ ...history.state, detailViewer: false }, "");
    };

    const openLightbox = (trigger: HTMLButtonElement, animate = true): void => {
      const url = trigger.dataset.lightboxPreviewUrl;
      if (!lightbox || !lightboxImage || !url) return;
      lastLightboxTrigger = trigger;
      if (compositionStage && trigger.hasAttribute("data-lightbox-composition")) {
        lightboxImage.hidden = true;
        lightboxImage.parentElement?.prepend(compositionStage);
      } else {
        lightboxImage.hidden = false;
        lightboxImage.src = url;
        prepareImage(lightboxImage);
      }
      lightboxImage.alt = trigger.dataset.lightboxPreviewAlt ?? "资源大图";
      const width = Number(trigger.dataset.lightboxPreviewWidth);
      const height = Number(trigger.dataset.lightboxPreviewHeight);
      if (Number.isFinite(width) && width > 0) lightboxImage.width = width;
      if (Number.isFinite(height) && height > 0) lightboxImage.height = height;
      if (animate) {
        void setSurfaceVisible(lightbox, true, "fade");
        if (!compositionStage) animateLightboxImage(lightboxImage, trigger, true);
      } else {
        lightbox.hidden = false;
        lightbox.inert = false;
      }
      document.body.classList.add("detail-lightbox-open");
      history.replaceState({ ...history.state, detailViewer: true }, "");
      lightboxCloseButton?.focus();
    };

    const variantButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-variant-select]"));
    const selectVariant = (button: HTMLButtonElement): void => {
      const variantId = button.dataset.variantSelect;
      if (!variantId || button.getAttribute("aria-selected") === "true") return;
      closeLightbox();
      for (const panel of root.querySelectorAll<HTMLElement>("[data-variant-panel]")) panel.hidden = panel.dataset.variantPanel !== variantId;
      for (const panel of root.querySelectorAll<HTMLElement>("[data-download-variant]")) panel.hidden = panel.dataset.downloadVariant !== variantId;
      for (const item of variantButtons) {
        const active = item.dataset.variantSelect === variantId;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
        item.tabIndex = active ? 0 : -1;
      }
      loadSelectedDetailImages(root);
      const preview = root.querySelector<HTMLElement>('[data-variant-panel]:not([hidden])');
      if (preview) revealContent(preview);
      const currentLabel = root.querySelector<HTMLElement>("[data-variant-current]");
      if (currentLabel) currentLabel.textContent = button.dataset.variantLabel ?? "";
    };
    for (const [index, button] of variantButtons.entries()) {
      button.addEventListener("click", () => selectVariant(button));
      button.addEventListener("keydown", (event) => {
        let nextIndex: number;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % variantButtons.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + variantButtons.length) % variantButtons.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = variantButtons.length - 1;
        else return;
        event.preventDefault();
        const next = variantButtons[nextIndex];
        if (!next) return;
        selectVariant(next);
        next.focus();
      });
    }

    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-detail-source-select]")) {
      button.addEventListener("click", () => {
        const source = button.dataset.detailSourceSelect;
        const panelRoot = button.closest<HTMLElement>("[data-variant-panel]");
        if (!source || !panelRoot || button.getAttribute("aria-selected") === "true") return;
        closeLightbox();
        for (const panel of panelRoot.querySelectorAll<HTMLElement>("[data-detail-source-panel]")) panel.hidden = panel.dataset.detailSourcePanel !== source;
        loadSelectedDetailImages(root);
        const preview = panelRoot.querySelector<HTMLElement>('[data-detail-source-panel]:not([hidden])');
        if (preview) revealContent(preview);
        for (const item of panelRoot.querySelectorAll<HTMLButtonElement>("[data-detail-source-select]")) {
          const active = item.dataset.detailSourceSelect === source;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-selected", String(active));
          item.tabIndex = active ? 0 : -1;
        }
      });
      button.tabIndex = button.getAttribute("aria-selected") === "true" ? 0 : -1;
      button.addEventListener("keydown", (event) => {
        const buttons = [...button.closest<HTMLElement>("[data-variant-panel]")!.querySelectorAll<HTMLButtonElement>("[data-detail-source-select]")];
        const index = buttons.indexOf(button);
        const next = event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); buttons[next]?.click(); buttons[next]?.focus();
      });
    }

    for (const trigger of root.querySelectorAll<HTMLButtonElement>("[data-lightbox-open]")) {
      trigger.addEventListener("click", () => openLightbox(trigger));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-lightbox-close]")) {
      button.addEventListener("click", closeLightbox);
    }
    const stepDetail = (direction: "previous" | "next", viewer: boolean) => {
      const link = root.querySelector<HTMLAnchorElement>(`[data-detail-${direction}]`);
      if (!link?.hasAttribute("href")) return;
      void navigate(link.href, { history: "replace", state: { detailViewer: viewer }, info: { detailViewer: viewer } });
    };
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-lightbox-step]")) {
      const direction = button.dataset.lightboxStep === "previous" ? "previous" : "next";
      button.disabled = !root.querySelector(`[data-detail-${direction}][href]`);
      button.addEventListener("click", () => stepDetail(direction, true));
    }
    // Mobile browsers can suppress the compatibility click immediately after a
    // swipe. Activate an actual tap on viewer controls at touchend, suppressing
    // the later synthetic click so one tap still causes exactly one action.
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-lightbox-step], [data-lightbox-close]")) {
      let start: { x: number; y: number } | undefined;
      button.addEventListener("touchstart", (event) => {
        const touch = event.touches.length === 1 ? event.touches[0] : undefined;
        start = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
      }, { passive: true });
      button.addEventListener("touchend", (event) => {
        const touch = event.changedTouches[0];
        if (start && touch && !button.disabled && Math.abs(touch.clientX - start.x) < 12 && Math.abs(touch.clientY - start.y) < 12) {
          event.preventDefault();
          button.click();
        }
        start = undefined;
      }, { passive: false });
      button.addEventListener("touchcancel", () => { start = undefined; }, { passive: true });
    }
    const viewerNavigation = root.querySelector<HTMLElement>("[data-lightbox-navigation]");
    if (viewerNavigation) viewerNavigation.hidden = root.querySelector<HTMLElement>("[data-detail-navigation]")?.hidden !== false;
    let touchStart: { x: number; y: number } | undefined;
    const swipeTarget = compositionStage ?? lightboxImage;
    swipeTarget?.addEventListener("touchstart", (event) => {
      if (!lightbox || lightbox.hidden || lightbox.inert) return;
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      touchStart = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
    }, { passive: true });
    swipeTarget?.addEventListener("touchend", (event) => {
      if (!lightbox || lightbox.hidden || lightbox.inert) { touchStart = undefined; return; }
      const touch = event.changedTouches[0];
      if (touchStart && touch) {
        const x = touch.clientX - touchStart.x;
        const y = touch.clientY - touchStart.y;
        if (Math.abs(x) >= 60 && Math.abs(x) > Math.abs(y) * 1.5 && (window.visualViewport?.scale ?? 1) <= 1) stepDetail(x > 0 ? "previous" : "next", true);
      }
      touchStart = undefined;
    }, { passive: true });
    swipeTarget?.addEventListener("touchcancel", () => { touchStart = undefined; }, { passive: true });
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey && event.key !== "Tab" || event.repeat) return;
      // Native modals and an exiting viewer retain ownership of keyboard input.
      if (document.querySelector('dialog[open], .site-nav[data-mobile-open="true"], .nav-game-library[open]') || lightbox && !lightbox.hidden && lightbox.inert) return;
      const viewer = Boolean(lightbox && !lightbox.hidden && !lightbox.inert);
      const editing = event.target instanceof Element && event.target.closest('input, textarea, select, [role="tab"], [contenteditable]:not([contenteditable="false"])');
      if (!editing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        stepDetail(event.key === "ArrowLeft" ? "previous" : "next", viewer);
        return;
      }
      if (!viewer || !lightbox) return;
      if (event.key === "Escape") {
        closeLightbox();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(lightbox.querySelectorAll<HTMLButtonElement>("button:not([disabled])")).filter((button) => !button.closest("[hidden]"));
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
    }, { signal });

    if (history.state?.detailViewer) {
      const trigger = [...root.querySelectorAll<HTMLButtonElement>("[data-lightbox-open]")].find((button) => !button.closest("[hidden]"));
      if (trigger) openLightbox(trigger, false);
    }

    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-download-kind]")) {
      button.addEventListener("click", () => void downloadRendition(button));
    }
  }
});
