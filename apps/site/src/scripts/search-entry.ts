const searchDataUrl = "data/search-index.json";
let searchWarmup: Promise<unknown> | undefined;

for (const form of document.querySelectorAll<HTMLFormElement>("[data-search-entry]")) {
  const input = form.querySelector<HTMLInputElement>("input[name=q]");
  input?.addEventListener("focus", () => {
    searchWarmup ??= fetch(resolveSitePath(searchDataUrl), { credentials: "omit" }).catch(() => undefined);
  }, { once: true });
}

function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? document.querySelector<HTMLElement>("[data-site-base]")?.dataset.siteBaseValue ?? "/";
  return base === "/" ? `/${path.replace(/^\/+/, "")}` : `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}
