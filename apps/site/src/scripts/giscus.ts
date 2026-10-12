import { onPageLoad, pageSignal, onPageCleanup } from "./page-lifecycle";
onPageLoad(() => {
  (() => {
      const root = document.querySelector("[data-giscus-shell]");
      if (!(root instanceof HTMLElement)) return;
      const container = root.querySelector("[data-giscus-container]");
      const fallback = root.querySelector("[data-giscus-fallback]");
      if (!(container instanceof HTMLElement) || !(fallback instanceof HTMLElement)) return;

      const currentTheme = () => {
        const theme = document.documentElement.dataset.theme || "system";
        return theme === "light" || theme === "dark" ? theme : "preferred_color_scheme";
      };

      const config = {
        repo: root.dataset.giscusRepo,
        repoId: root.dataset.giscusRepoId,
        category: root.dataset.giscusCategory,
        categoryId: root.dataset.giscusCategoryId,
        mapping: root.dataset.giscusMapping,
        strict: root.dataset.giscusStrict,
        reactionsEnabled: root.dataset.giscusReactionsEnabled,
        emitMetadata: root.dataset.giscusEmitMetadata,
        inputPosition: root.dataset.giscusInputPosition,
        lang: root.dataset.giscusLang,
        theme: currentTheme(),
      };

      const syncTheme = () => {
        const iframe = root.querySelector("iframe.giscus-frame");
        if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) return;
        if (!iframe.dataset.themeSyncBound) {
          iframe.dataset.themeSyncBound = "true";
          iframe.addEventListener("load", syncTheme, { once: true });
        }
        iframe.contentWindow.postMessage({ giscus: { setConfig: { theme: currentTheme() } } }, "https://giscus.app");
      };

      const showFallback = () => {
        fallback.hidden = false;
        root.dataset.giscusState = "error";
      };

      const script = document.createElement("script");
      script.src = "https://giscus.app/client.js";
      script.async = true;
      script.crossOrigin = "anonymous";
      for (const [key, value] of Object.entries(config)) {
        if (value !== undefined) script.setAttribute(`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
      }
      script.addEventListener("error", showFallback, { once: true });
      container.append(script);

      const observer = new MutationObserver(syncTheme);
      observer.observe(root, { childList: true, subtree: true });
    const timers = new Set<number>();
    const scheduleTheme = (delay: number) => {
      const timer = window.setTimeout(() => { timers.delete(timer); syncTheme(); }, delay);
      timers.add(timer);
    };
      const syncThemeAfterChange = () => {
        syncTheme();
      scheduleTheme(80);
      scheduleTheme(500);
      };
      window.addEventListener("rhythm-theme-change", syncThemeAfterChange, { signal: pageSignal() });
    onPageCleanup(() => { observer.disconnect(); for (const timer of timers) window.clearTimeout(timer); });
    scheduleTheme(0);
    scheduleTheme(1200);
    })();
});
