import { onPageLoad, onPageCleanup } from "./page-lifecycle";
import type { MediaItem } from "../lib/media";
import { downloadRendition } from "./download";

onPageLoad(() => {
  const root = document.querySelector<HTMLElement>("[data-video-gallery]");
  if (root) initialize(root);
});

function initialize(root: HTMLElement) {
  const mediaItems = JSON.parse(root.dataset.mediaItems ?? "[]") as MediaItem[];
  const el = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing media preview element: ${selector}`);
    return element;
  };
  const player = el<HTMLVideoElement>("[data-player]");
  const poster = el<HTMLImageElement>("[data-poster]");
  const clips = el<HTMLSelectElement>("[data-clip]");
  const source = el<HTMLSelectElement>("[data-source]");
  const autoOption = source.options[0]!;
  const download = el<HTMLButtonElement>("[data-download]");
  const cover = el("[data-cover]");
  const spoiler = el("[data-spoiler]");
  const playButton = el<HTMLButtonElement>("[data-play]");
  const status = el("[data-status]");
  const error = el("[data-player-error]");
  const stop = el<HTMLButtonElement>("[data-stop]");
  let itemIndex = 0;
  let clipIndex = 0;
  let load: AbortController | undefined;
  let starting = false;
  let pendingPosition = 0;
  const revealed = new Set<string>();
  const currentItem = () => mediaItems[itemIndex]!;
  const currentClip = () => currentItem().clips[clipIndex]!;
  const size = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

  function resetPlayer() {
    load?.abort();
    load = undefined;
    starting = false;
    pendingPosition = 0;
    autoOption.textContent = "自动（R2）";
    player.pause();
    if (player.hasAttribute("src")) { player.removeAttribute("src"); player.load(); }
    player.preload = "none";
    player.hidden = true;
    cover.hidden = false;
    stop.hidden = true;
    error.hidden = true;
    status.textContent = "";
  }

  onPageCleanup(resetPlayer);

  function updateDownloadSource() {
    const { url, fallbackUrl } = currentClip().original;
    const manualRos = Boolean(fallbackUrl && source.value === "ros");
    download.dataset.downloadUrl = manualRos ? fallbackUrl! : url;
    download.dataset.downloadKind = manualRos ? "backup" : "original";
    if (fallbackUrl && source.value === "auto") download.dataset.backupUrl = fallbackUrl;
    else delete download.dataset.backupUrl;
  }

  function renderSelection() {
    resetPlayer();
    const item = currentItem(), clip = currentClip();
    root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => {
      const selected = Number(button.dataset.item) === itemIndex;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    el("[data-title]").textContent = item.title;
    el("[data-screen-duration]").textContent = time(clip.duration);
    el("[data-source-label]").hidden = !clip.original.fallbackUrl;
    if (!clip.original.fallbackUrl) source.value = "auto";
    updateDownloadSource();
    download.dataset.downloadFilename = clip.original.downloadFilename;
    download.dataset.resourceId = item.id;
    const sizeLabel = root.querySelector<HTMLElement>("[data-original-size]");
    if (sizeLabel) sizeLabel.textContent = size(clip.original.sizeBytes);
    el("[data-clip-label]").hidden = item.clips.length < 2;
    clips.replaceChildren(...item.clips.map((entry, index) => new Option(entry.label, String(index))));
    clips.value = String(clipIndex);
    const gated = item.spoiler && !revealed.has(item.id);
    spoiler.hidden = !gated;
    playButton.hidden = gated;
    poster.hidden = gated;
    if (gated) poster.removeAttribute("src");
    else { poster.src = clip.poster; poster.alt = `${item.title} · ${clip.label}封面`; }
  }

  function selectedUrl() {
    const { url, fallbackUrl } = currentClip().original;
    return source.value === "ros" ? fallbackUrl ?? url : url;
  }

  function bindVideo(url: string, position = 0, resume = true) {
    load?.abort();
    const { signal } = load = new AbortController();
    player.pause();
    starting = resume;
    pendingPosition = position;
    player.preload = resume ? "none" : "metadata";
    player.src = url;
    player.hidden = false;
    cover.hidden = true;
    stop.hidden = false;
    error.hidden = true;
    status.textContent = autoOption.textContent === "自动（ROS）" ? "已切换到 ROS 线路。" : "正在加载视频。";
    if (position > 0) {
      player.addEventListener("loadedmetadata", () => {
        player.currentTime = Math.min(position, Number.isFinite(player.duration) ? player.duration : position);
        pendingPosition = 0;
      }, { once: true, signal });
    }
    // Switch a stalled initial load once. Long pauses and later seeks keep the current line.
    if (resume) {
      const timer = window.setTimeout(() => {
        if (starting && !player.paused) recoverPlayback();
      }, 15000);
      player.addEventListener("canplay", () => {
        window.clearTimeout(timer);
        starting = false;
      }, { once: true, signal });
      signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
      void player.play().catch(() => {
        if (!signal.aborted && !player.error) starting = false;
      });
    }
  }

  function recoverPlayback() {
    if (!load || !player.hasAttribute("src")) return;
    const { url, fallbackUrl } = currentClip().original;
    if (source.value === "auto" && fallbackUrl && player.src === url) {
      autoOption.textContent = "自动（ROS）";
      bindVideo(fallbackUrl, pendingPosition || player.currentTime, starting || !player.paused);
      return;
    }
    pendingPosition ||= player.currentTime;
    load.abort();
    load = undefined;
    starting = false;
    player.pause();
    player.removeAttribute("src");
    player.load();
    error.hidden = false;
    status.textContent = "视频加载失败。";
  }

  playButton.addEventListener("click", () => bindVideo(selectedUrl()));
  source.addEventListener("change", () => {
    autoOption.textContent = "自动（R2）";
    updateDownloadSource();
    if (!error.hidden || (player.hasAttribute("src") && player.src !== selectedUrl())) {
      bindVideo(selectedUrl(), pendingPosition || player.currentTime, starting || !player.paused || !error.hidden);
    }
  });
  download.addEventListener("click", async () => {
    await downloadRendition(download);
    const sizeLabel = download.querySelector<HTMLElement>("[data-original-size]");
    if (sizeLabel) sizeLabel.textContent = size(currentClip().original.sizeBytes);
  });
  stop.addEventListener("click", resetPlayer);
  el("[data-reveal]").addEventListener("click", () => { revealed.add(currentItem().id); renderSelection(); });
  root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => button.addEventListener("click", () => { const next = Number(button.dataset.item); if (next === itemIndex) return; itemIndex = next; clipIndex = 0; renderSelection(); }));
  clips.addEventListener("change", () => { const next = Number(clips.value); if (next === clipIndex) return; clipIndex = next; renderSelection(); });
  player.addEventListener("playing", () => { status.textContent = `正在播放。`; });
  player.addEventListener("ended", () => { status.textContent = "播放结束。"; });
  player.addEventListener("error", recoverPlayback);
  root.querySelector<HTMLSelectElement>("[data-filter]")?.addEventListener("change", event => {
    const filter = (event.currentTarget as HTMLSelectElement).value;
    root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => { button.hidden = filter !== "all" && button.dataset.kind !== filter; });
  });

  renderSelection();
}
