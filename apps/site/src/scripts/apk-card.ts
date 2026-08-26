import { formatPublicApkBytes, parsePublicArcaeaApkManifest, type PublicArcaeaApkEntry } from "../lib/apk";

const card = document.querySelector<HTMLElement>("[data-arcaea-apk-card]");
const state = card?.querySelector<HTMLElement>("[data-arcaea-apk-state]");
const manifestUrl = card?.dataset.manifestUrl;

if (card && state && manifestUrl) void loadManifest(card, state, manifestUrl);

async function loadManifest(cardElement: HTMLElement, stateElement: HTMLElement, url: string): Promise<void> {
  try {
    const response = await fetch(url, { credentials: "omit", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("manifest unavailable");
    const manifest = parsePublicArcaeaApkManifest(await response.json());
    if (!manifest) throw new Error("manifest invalid");
    renderManifest(cardElement, stateElement, manifest.latest, manifest.previous);
  } catch {
    stateElement.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "暂时无法获取 APK 下载信息";
    const link = document.createElement("a");
    link.className = "text-link";
    link.href = "https://arcaea.lowiro.com/zh";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "访问 Arcaea 官网";
    stateElement.append(message, link);
  }
}

function renderManifest(cardElement: HTMLElement, stateElement: HTMLElement, latest: PublicArcaeaApkEntry, previous: PublicArcaeaApkEntry | null): void {
  cardElement.classList.add("is-ready");
  stateElement.replaceChildren();

  const main = document.createElement("div");
  main.className = "apk-card-main";
  const identity = document.createElement("div");
  identity.className = "apk-card-identity";
  const product = document.createElement("span");
  product.className = "apk-card-product";
  product.textContent = "Arcaea APK";
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
    createMetaItem("发布时间 / 更新时间", formatDate(latest.publishedAt)),
  );
  main.append(identity, metadata);

  const actions = document.createElement("div");
  actions.className = "apk-download-actions";
  if (latest.downloads.official) actions.append(createDownloadLink(latest.downloads.official, latest.fileName, "button apk-official-button", "官方下载"));
  actions.append(createDownloadLink(latest.downloads.github, latest.fileName, "button apk-download-button", "GitHub 下载"));

  stateElement.append(main, actions, createDigest(latest.sha256));
  if (previous) stateElement.append(createPreviousVersion(previous));
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

function createDigest(sha256: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "apk-digest";
  const summary = document.createElement("summary");
  summary.textContent = "校验信息";
  const row = document.createElement("div");
  row.className = "apk-digest-row";
  const label = document.createElement("span");
  label.textContent = "SHA-256";
  const value = document.createElement("code");
  value.textContent = sha256;
  const copy = document.createElement("button");
  copy.className = "text-button";
  copy.type = "button";
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(sha256);
      copy.textContent = "已复制";
      window.setTimeout(() => { copy.textContent = "复制"; }, 1600);
    } catch {
      copy.textContent = "复制失败";
    }
  });
  row.append(label, value, copy);
  details.append(summary, row);
  return details;
}

function createPreviousVersion(previous: PublicArcaeaApkEntry): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "apk-previous";
  const summary = document.createElement("summary");
  summary.textContent = `上一版本 ${previous.version}`;
  const row = document.createElement("div");
  row.className = "apk-previous-row";
  const metadata = document.createElement("span");
  metadata.textContent = `${formatPublicApkBytes(previous.fileSize)} · ${formatDate(previous.publishedAt)}`;
  const actions = document.createElement("span");
  actions.className = "apk-previous-actions";
  actions.append(createDownloadLink(previous.downloads.github, previous.fileName, "", "GitHub 下载"));
  if (previous.downloads.official) actions.append(" · ", createDownloadLink(previous.downloads.official, previous.fileName, "", "官方下载"));
  row.append(metadata, actions);
  details.append(summary, row);
  return details;
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
