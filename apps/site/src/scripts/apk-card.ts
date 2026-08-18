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
  const latestBox = document.createElement("div");
  latestBox.className = "apk-latest-box";
  const version = document.createElement("strong");
  version.textContent = `最新版本 ${latest.version}`;
  const metadata = document.createElement("span");
  metadata.textContent = `${formatPublicApkBytes(latest.fileSize)} · ${formatDate(latest.publishedAt)}`;
  const download = document.createElement("a");
  download.className = "button apk-download-button";
  download.href = latest.url;
  download.setAttribute("download", latest.fileName);
  download.textContent = "下载 APK";
  latestBox.append(version, metadata, download);

  const digest = document.createElement("div");
  digest.className = "apk-digest";
  const digestLabel = document.createElement("span");
  digestLabel.textContent = "SHA-256";
  const digestValue = document.createElement("code");
  digestValue.textContent = `${latest.sha256.slice(0, 16)}…${latest.sha256.slice(-8)}`;
  const copy = document.createElement("button");
  copy.className = "text-button";
  copy.type = "button";
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(latest.sha256);
      copy.textContent = "已复制";
      window.setTimeout(() => { copy.textContent = "复制"; }, 1600);
    } catch {
      copy.textContent = "复制失败";
    }
  });
  digest.append(digestLabel, digestValue, copy);

  stateElement.append(latestBox, digest);
  if (previous) {
    const previousRow = document.createElement("div");
    previousRow.className = "apk-previous-row";
    const previousLabel = document.createElement("span");
    previousLabel.textContent = `上一版本 ${previous.version}`;
    const previousLink = document.createElement("a");
    previousLink.href = previous.url;
    previousLink.setAttribute("download", previous.fileName);
    previousLink.textContent = "下载上一版本";
    previousRow.append(previousLabel, previousLink);
    stateElement.append(previousRow);
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
