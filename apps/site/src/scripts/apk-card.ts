import { getBrowserStatsClient } from "../lib/stats-client";
import { onPageLoad, pageSignal } from "./page-lifecycle";
import { revealContent } from "./motion";
import { apkDownloadLinks, formatPublicApkBytes, parsePublicArcaeaApkManifest, type PublicArcaeaApkEntry } from "../lib/apk";

onPageLoad(() => {
  const card = document.querySelector<HTMLElement>("[data-arcaea-apk-card]");
  const state = card?.querySelector<HTMLElement>("[data-arcaea-apk-state]");
  const manifestUrl = card?.dataset.manifestUrl;

  if (card && state && manifestUrl) void loadManifest(card, state, manifestUrl);
});

async function loadManifest(cardElement: HTMLElement, stateElement: HTMLElement, url: string): Promise<void> {
  const signal = pageSignal();
  try {
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.any([signal,AbortSignal.timeout(10000)]), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("manifest unavailable");
    const manifest = parsePublicArcaeaApkManifest(await response.json(), { publicBaseUrl: import.meta.env.PUBLIC_ARCAEA_R2_BASE_URL });
    if (!manifest?.latest.downloads.r2) throw new Error("manifest invalid");
    if (!signal.aborted) renderManifest(cardElement, stateElement, manifest.latest);
  } catch {
    if (signal.aborted) return;
    stateElement.removeAttribute("aria-busy");
    const retry = document.createElement("button");
    retry.className = "button apk-download-button";
    retry.textContent = "重新获取版本";
    retry.onclick = () => { retry.disabled = true; void loadManifest(cardElement, stateElement, url); };
    stateElement.replaceChildren("版本信息暂时无法获取。", retry);
  }
}

function renderManifest(cardElement: HTMLElement, stateElement: HTMLElement, latest: PublicArcaeaApkEntry): void {
  stateElement.removeAttribute("aria-busy");
  cardElement.classList.add("is-ready");
  stateElement.replaceChildren();

  const main = document.createElement("div");
  main.className = "apk-card-main";
  const identity = document.createElement("div");
  identity.className = "apk-card-identity";
  const product = document.createElement("span");
  product.className = "apk-card-product";
  product.textContent = "Arcaea · Android";
  const version = document.createElement("strong");
  version.textContent = latest.version;
  const tag = document.createElement("span");
  tag.className = "apk-version-tag";
  tag.textContent = "收录版本";
  identity.append(product, version, tag);

  const metadata = document.createElement("dl");
  metadata.className = "apk-card-meta";
  metadata.append(
    createMetaItem("文件大小", formatPublicApkBytes(latest.fileSize)),
    createMetaItem("更新时间", formatDate(latest.publishedAt)),
  );
  main.append(identity, metadata);

  const actions = document.createElement("div");
  actions.className = "apk-download-actions";
  for (const source of apkDownloadLinks(latest)) {
    const link = createDownloadLink(source.href, latest.fileName, source.primary ? "button apk-download-button" : "button apk-official-button", source.label);
    link.addEventListener("click", () => { void getBrowserStatsClient().trackApkDownload(source.href === latest.downloads.r2 ? "r2" : "github"); });
    actions.append(link);
  }

  stateElement.append(main, actions);
  revealContent(stateElement);
  // The hero entry points here; it shows the version once this one request has it.
  const entryVersion = document.querySelector<HTMLElement>("[data-apk-entry-version]");
  if (entryVersion) {
    entryVersion.textContent = latest.version;
    entryVersion.hidden = false;
  }
}

function createMetaItem(label: string, value: string): HTMLDivElement {
  const item = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  item.append(term, description);
  return item;
}

function createDownloadLink(href: string, fileName: string, className: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  if (className) link.className = className;
  link.href = href;
  link.setAttribute("download", fileName);
  link.textContent = label;
  return link;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
