import { rankSearchEntries } from "../lib/search";
import { cardMediaRatio } from "../lib/media-config";
import type { PublicResource, PublicSearchEntry } from "../lib/types";

const root = document.querySelector<HTMLElement>("[data-search-page]");
if (root) void initializeSearch(root);

async function initializeSearch(root: HTMLElement): Promise<void> {
  const input = root.previousElementSibling?.querySelector<HTMLInputElement>("input[name=q]") ?? document.querySelector<HTMLInputElement>(".search-page input[name=q]");
  const results = root.querySelector<HTMLElement>("[data-search-results]");
  const status = root.querySelector<HTMLElement>("[data-search-status]");
  if (!input || !results || !status) return;

  const queryFromUrl = new URLSearchParams(window.location.search).get("q");
  if (queryFromUrl !== null) input.value = queryFromUrl;

  let entries: PublicSearchEntry[] = [];
  let resourceMap = new Map<string, PublicResource>();
  let resourcesPromise: Promise<void> | undefined;

  try {
    const response = await fetch(resolveSitePath("data/search-index.json"), { credentials: "omit" });
    if (!response.ok) throw new Error(`search index failed with ${response.status}`);
    entries = await response.json() as PublicSearchEntry[];
  } catch (error) {
    console.error("Search index failed", error);
    status.textContent = "搜索暂时不可用";
    return;
  }

  const run = async () => {
    const query = input.value;
    const ranked = rankSearchEntries(entries, query);
    if (!query.trim()) {
      root.closest(".search-page")?.classList.remove("has-search-query");
      root.previousElementSibling?.classList.remove("is-results");
      results.replaceChildren();
      status.textContent = "输入关键词搜索资源";
      return;
    }
    root.closest(".search-page")?.classList.add("has-search-query");
    root.previousElementSibling?.classList.add("is-results");
    if (ranked.length === 0) {
      results.replaceChildren();
      status.textContent = "没有找到相关资源。";
      return;
    }
    resourcesPromise ??= loadResources();
    await resourcesPromise;
    const matches = ranked.map((entry) => resourceMap.get(entry.resourceId)).filter((resource): resource is PublicResource => Boolean(resource));
    results.replaceChildren(...matches.map((resource) => createResultCard(resource)));
    status.textContent = `找到 ${matches.length.toLocaleString("zh-CN")} 项资源`;
  };

  input.addEventListener("input", () => void run());
  void run();

  async function loadResources(): Promise<void> {
    const response = await fetch(resolveSitePath("data/resources.json"), { credentials: "omit" });
    if (!response.ok) throw new Error(`public resources failed with ${response.status}`);
    const resources = await response.json() as PublicResource[];
    resourceMap = new Map(resources.map((resource) => [resource.resourceId, resource]));
  }
}

function createResultCard(resource: PublicResource): HTMLElement {
  const article = document.createElement("article");
  article.className = "resource-card";
  article.dataset.resourceCard = "";
  article.dataset.game = resource.game;
  article.dataset.resourceType = resource.resourceType;
  article.dataset.mediaRatio = cardMediaRatio(resource.game, resource.resourceType);
  const anchor = document.createElement("a");
  anchor.className = "resource-card-link";
  anchor.href = resolveSitePath(resource.route);
  const media = document.createElement("div");
  media.className = "resource-card-media";
  const image = resource.preview.small ?? resource.preview.medium ?? resource.preview.large;
  if (image) {
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = resource.displayTitle;
    img.width = image.width;
    img.height = image.height;
    img.loading = "lazy";
    img.decoding = "async";
    if (resource.original?.url) {
      img.dataset.fallbackSrc = resource.original.url;
      if (resource.original.width) img.dataset.fallbackWidth = String(resource.original.width);
      if (resource.original.height) img.dataset.fallbackHeight = String(resource.original.height);
    }
    media.append(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "resource-card-placeholder";
    placeholder.textContent = "图片暂不可用";
    media.append(placeholder);
  }
  if (resource.upscaled) {
    const badge = document.createElement("span");
    badge.className = "resource-badge is-upscaled";
    badge.textContent = "含超分版";
    media.append(badge);
  }
  const body = document.createElement("div");
  body.className = "resource-card-body";
  const title = document.createElement("h3");
  title.textContent = resource.displayTitle;
  body.append(title);
  if (resource.artist) {
    const artist = document.createElement("p");
    artist.textContent = resource.artist;
    body.append(artist);
  }
  anchor.append(media, body);
  article.append(anchor);
  return article;
}

function resolveSitePath(path: string): string {
  const base = document.documentElement.dataset.basePath ?? "/";
  const clean = path.startsWith("/") ? path : `/${path}`;
  return base === "/" ? clean : `${base.replace(/\/+$/u, "")}${clean}`;
}
