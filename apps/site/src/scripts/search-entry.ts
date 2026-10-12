import { loadStaticData } from "./static-data";
import { onPageLoad } from "./page-lifecycle";
import { sitePath } from "../lib/url";

const searchDataUrl = "data/search-index.json";

onPageLoad(() => {
  for (const form of document.querySelectorAll<HTMLFormElement>("[data-search-entry]")) {
    const input = form.querySelector<HTMLInputElement>("input[name=q]");
    input?.addEventListener("focus", () => {
      void loadStaticData(resolveSitePath(searchDataUrl)).catch(() => undefined);
    }, { once: true });
  }
});

function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? document.querySelector<HTMLElement>("[data-site-base]")?.dataset.siteBaseValue ?? "/";
  return sitePath(path, base);
}
