import type { MediaItem } from "../lib/media";
import { downloadRendition } from "./download";

const root = document.querySelector<HTMLElement>("[data-video-gallery]");
if (root) initialize(root);

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
  const cover = el("[data-cover]");
  const spoiler = el("[data-spoiler]");
  const playButton = el<HTMLButtonElement>("[data-play]");
  const status = el("[data-status]");
  const error = el("[data-player-error]");
  const stop = el<HTMLButtonElement>("[data-stop]");
  let itemIndex = 0;
  let clipIndex = 0;
  let generation = 0;
  const revealed = new Set<string>();
  const currentItem = () => mediaItems[itemIndex]!;
  const currentClip = () => currentItem().clips[clipIndex]!;
  const size = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

  function resetPlayer() {
    generation++;
    player.pause();
    if (player.hasAttribute("src")) { player.removeAttribute("src"); player.load(); }
    player.hidden = true;
    cover.hidden = false;
    stop.hidden = true;
    error.hidden = true;
    status.textContent = "";
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
    const download = el<HTMLButtonElement>("[data-download]");
    download.dataset.downloadUrl = clip.original.url;
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

  function bindVideo() {
    const ticket = ++generation;
    player.pause();
    player.src = currentClip().original.url;
    player.hidden = false;
    cover.hidden = true;
    stop.hidden = false;
    error.hidden = true;
    status.textContent = "正在加载视频。";
    player.addEventListener("loadedmetadata", () => {
      if (ticket !== generation) return;
      void player.play().catch(() => { if (ticket === generation) status.textContent = "视频已就绪。"; });
    }, { once: true });
    player.load();
    void player.play().catch(() => { /* metadata handler provides a retry */ });
  }

  playButton.addEventListener("click", () => bindVideo());
  el<HTMLButtonElement>("[data-download]").addEventListener("click", async event => {
    const button = event.currentTarget as HTMLButtonElement;
    await downloadRendition(button);
    const sizeLabel = button.querySelector<HTMLElement>("[data-original-size]");
    if (sizeLabel) sizeLabel.textContent = size(currentClip().original.sizeBytes);
  });
  stop.addEventListener("click", resetPlayer);
  el("[data-reveal]").addEventListener("click", () => { revealed.add(currentItem().id); renderSelection(); });
  root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => button.addEventListener("click", () => { itemIndex = Number(button.dataset.item); clipIndex = 0; renderSelection(); }));
  clips.addEventListener("change", () => { clipIndex = Number(clips.value); renderSelection(); });
  player.addEventListener("playing", () => { status.textContent = `正在播放。`; });
  player.addEventListener("ended", () => { status.textContent = "播放结束。"; });
  player.addEventListener("error", () => { if (player.hasAttribute("src")) { error.hidden = false; status.textContent = "视频加载失败。"; } });
  root.querySelector<HTMLSelectElement>("[data-filter]")?.addEventListener("change", event => {
    const filter = (event.currentTarget as HTMLSelectElement).value;
    root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => { button.hidden = filter !== "all" && button.dataset.kind !== filter; });
  });

  renderSelection();
}
