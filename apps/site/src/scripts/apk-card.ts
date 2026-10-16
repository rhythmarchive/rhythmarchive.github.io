import { onPageLoad, pageSignal } from "./page-lifecycle";
import { revealContent } from "./motion";
import { formatPublicApkBytes, parsePublicArcaeaApkManifest, type PublicArcaeaApkEntry } from "../lib/apk";
import { GITHUB_RELEASES_URL } from "../lib/site-config";

onPageLoad(() => {
  const card = document.querySelector<HTMLElement>("[data-arcaea-apk-card]");
  const state = card?.querySelector<HTMLElement>("[data-arcaea-apk-state]");
  const manifestUrl = card?.dataset.manifestUrl;

  if (card && state && manifestUrl) void loadManifest(card, state, manifestUrl);
});

async function loadManifest(cardElement: HTMLElement, stateElement: HTMLElement, url: string): Promise<void> {
  const signal = pageSignal();
  try {
    const response = await fetch(url, { credentials: "omit", signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("manifest unavailable");
    const manifest = parsePublicArcaeaApkManifest(await response.json());
    if (!manifest) throw new Error("manifest invalid");
    if (!signal.aborted) renderManifest(cardElement, stateElement, manifest.latest);
  } catch {
    if (signal.aborted) return;
    stateElement.removeAttribute("aria-busy");
    stateElement.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "暂时没拿到安装包信息，可以先去官网下载。";
    const link = document.createElement("a");
    link.className = "text-link";
    link.href = "https://arcaea.lowiro.com/zh";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Arcaea 官网";
    stateElement.append(message, link);
    revealContent(stateElement);
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
  tag.textContent = "最新版本";
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
  actions.append(createExternalLink(GITHUB_RELEASES_URL, "button apk-official-button", "历史版本"));
  actions.append(createDownloadLink(latest.downloads.github, latest.fileName, "button apk-download-button", "下载 APK"));

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

function createExternalLink(href: string, className: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  if (className) link.className = className;
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
