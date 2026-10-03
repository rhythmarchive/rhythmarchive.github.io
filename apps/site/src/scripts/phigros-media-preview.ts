import { mediaItems, PREVIEW_MEDIA_ORIGIN } from "../lib/phigros-media-preview";

const root = document.querySelector<HTMLElement>("[data-media-archive]");
if (root) initialize(root);

function initialize(root: HTMLElement) {
  const el = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing media preview element: ${selector}`);
    return element;
  };
  const player = el<HTMLVideoElement>("[data-player]");
  const poster = el<HTMLImageElement>("[data-poster]");
  const quality = el<HTMLSelectElement>("[data-quality]");
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
  const selectedQuality = (): "480p" | "720p" => quality.value === "720p" ? "720p" : "480p";
  const url = (path: string) => `${PREVIEW_MEDIA_ORIGIN}${path}`;
  const size = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
  try { if (localStorage.getItem("rhythm-archive-media-quality") === "720p") quality.value = "720p"; } catch { /* optional preference */ }

  function resetPlayer() {
    generation++;
    player.pause();
    if (player.hasAttribute("src")) { player.removeAttribute("src"); player.load(); }
    player.hidden = true;
    cover.hidden = false;
    stop.hidden = true;
    error.hidden = true;
    status.textContent = "尚未加载视频。选择清晰度后，点击画面开始播放。";
  }

  function updateFileInfo() {
    const clip = currentClip(), source = clip.sources[selectedQuality()];
    el("[data-size]").textContent = `当前文件 · ${size(source.bytes)}`;
    el("[data-cover-quality]").textContent = selectedQuality() === "480p" ? "480p · 省流预览" : "720p · 清晰预览";
    const saving = Math.round((1 - source.bytes / clip.originalBytes) * 100);
    el("[data-savings]").textContent = clip.duration !== clip.originalDuration ? "正文片段 · 原始下载保留完整文件" : `比原始文件小约 ${saving}%`;
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
    el("[data-category]").textContent = item.category;
    el("[data-description]").textContent = item.description;
    el("[data-duration]").textContent = time(clip.duration);
    el("[data-screen-duration]").textContent = time(clip.duration);
    el("[data-audio]").textContent = clip.audio ? "含音轨" : "无音轨";
    el("[data-asset-key]").textContent = clip.assetKey;
    el("[data-original-spec]").textContent = `${clip.width} × ${clip.height} · ${clip.fps} fps · ${time(clip.originalDuration)}`;
    const download = el<HTMLAnchorElement>("[data-download]");
    download.href = url(`/originals/${clip.originalFile}?download=1`);
    el("[data-original-size]").textContent = size(clip.originalBytes);
    el("[data-clip-label]").hidden = item.clips.length < 2;
    clips.replaceChildren(...item.clips.map((entry, index) => new Option(entry.label, String(index))));
    clips.value = String(clipIndex);
    const gated = item.spoiler && !revealed.has(item.id);
    spoiler.hidden = !gated;
    playButton.hidden = gated;
    poster.hidden = gated;
    if (gated) poster.removeAttribute("src");
    else { poster.src = url(`/posters/${clip.poster}`); poster.alt = `${item.title} · ${clip.label}封面`; }
    updateFileInfo();
  }

  function bindVideo(startAt = 0, resume = true) {
    const ticket = ++generation;
    player.pause();
    player.src = url(`/media/${currentClip().sources[selectedQuality()].file}`);
    player.hidden = false;
    cover.hidden = true;
    stop.hidden = false;
    error.hidden = true;
    status.textContent = `正在加载 ${selectedQuality()}；可用“停止加载”结束传输。`;
    player.addEventListener("loadedmetadata", () => {
      if (ticket !== generation) return;
      if (startAt > 0) player.currentTime = Math.min(startAt, Math.max(0, player.duration - .1));
      if (resume) void player.play().catch(() => { status.textContent = "视频已就绪，点击播放器中的播放按钮继续。"; });
    }, { once: true });
    player.load();
    if (resume) void player.play().catch(() => { /* metadata handler provides a retry */ });
  }

  playButton.addEventListener("click", () => bindVideo());
  stop.addEventListener("click", resetPlayer);
  el("[data-reveal]").addEventListener("click", () => { revealed.add(currentItem().id); renderSelection(); });
  root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => button.addEventListener("click", () => { itemIndex = Number(button.dataset.item); clipIndex = 0; renderSelection(); }));
  clips.addEventListener("change", () => { clipIndex = Number(clips.value); renderSelection(); });
  quality.addEventListener("change", () => {
    const loaded = player.hasAttribute("src"), position = player.currentTime, playing = !player.paused && !player.ended;
    try { localStorage.setItem("rhythm-archive-media-quality", selectedQuality()); } catch { /* optional preference */ }
    updateFileInfo();
    if (loaded) bindVideo(position, playing);
  });
  player.addEventListener("playing", () => { status.textContent = `正在播放 · ${selectedQuality()} · ${size(currentClip().sources[selectedQuality()].bytes)}`; });
  player.addEventListener("ended", () => { status.textContent = "播放结束。不会自动播放下一条。"; });
  player.addEventListener("error", () => { if (player.hasAttribute("src")) { error.hidden = false; status.textContent = "加载失败。可停止加载后重试，或下载原始视频。"; } });
  el<HTMLSelectElement>("[data-filter]").addEventListener("change", event => {
    const filter = (event.currentTarget as HTMLSelectElement).value;
    root.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(button => { button.hidden = filter !== "all" && button.dataset.kind !== filter; });
  });

  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-view]")];
  function selectView(tab: HTMLButtonElement) {
    const video = tab.dataset.view === "video";
    if (!video) resetPlayer();
    tabs.forEach(button => { const selected = button === tab; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; });
    el("#video-panel").hidden = !video;
    el("#cg-panel").hidden = video;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectView(tab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const target = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!;
      selectView(target); target.focus();
    });
  });

  const scene = el<HTMLSelectElement>("[data-cg-scene]");
  const base = el<HTMLImageElement>("[data-cg-base]");
  const layer = el<HTMLImageElement>("[data-cg-layer]");
  const cgSpoiler = el("[data-cg-spoiler]");
  const frames = el("[data-cg-frames]");
  const background = el<HTMLInputElement>("[data-cg-background]");
  const cgRevealed = new Set<string>();
  let frameIndex = 0;
  const states = [ ["1", "站台"], ["2", "门"], ["3.1", "人物"], ["3.2", "光球"], ["3.3", "微光"], ["3.4", "扩散"], ["3.5", "消散 I"], ["3.6", "消散 II"], ["3bg", "背景"] ] as const;
  const frameButtons = states.map((state, index) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = state[1];
    button.addEventListener("click", () => { frameIndex = index; renderCg(); });
    return button;
  });
  frames.append(...frameButtons);
  function renderCg() {
    const secret = scene.value === "secret", unlocked = cgRevealed.has(scene.value);
    el("[data-cg-title]").textContent = secret ? "秘密剧情 · 鸠与 Gino" : "推演 · 重逢";
    cgSpoiler.hidden = unlocked;
    el("[data-cg-controls]").hidden = !unlocked;
    frames.hidden = secret;
    base.hidden = true; layer.hidden = !unlocked;
    if (!unlocked) { base.removeAttribute("src"); layer.removeAttribute("src"); return; }
    const state = states[frameIndex]!, file = secret ? "CollectionHeader.png" : `${state[0]}.png`;
    layer.src = url(`/cg/${file}`);
    layer.alt = secret ? "鸠与 Gino 的完整剧情原画" : `推演剧情 · ${state[1]}`;
    const layered = !secret && state[0].startsWith("3.");
    el("[data-cg-background-label]").hidden = !layered;
    if (layered && background.checked) { base.src = url("/cg/3bg.png"); base.hidden = false; }
    else base.removeAttribute("src");
    frameButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === frameIndex)));
    el("[data-cg-caption]").textContent = secret ? "2048 × 1152 · 完整原画" : `2048 × 1152 · ${state[1]}${layered ? " · 透明组件" : ""}`;
    const download = el<HTMLAnchorElement>("[data-cg-download]"); download.href = url(`/cg/${file}?download=1`); download.textContent = layered ? "下载原始组件" : "下载原图";
    el("[data-cg-footnote]").textContent = secret ? "完整原画包含左右角色与斜向分隔线；游戏字幕和渐变叠层不包含在图片中。" : "按原始背景与透明组件组合预览，不含游戏对白、色阶与转场演出。可关闭背景查看透明组件。";
  }
  el("[data-cg-reveal]").addEventListener("click", () => { cgRevealed.add(scene.value); renderCg(); });
  scene.addEventListener("change", () => { frameIndex = 0; renderCg(); });
  background.addEventListener("change", renderCg);
  renderSelection(); renderCg();
}
