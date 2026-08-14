(() => {
  "use strict";

  const state = {
    page: "dashboard",
    bootstrap: null,
    currentWorkspaceId: window.localStorage.getItem("asset-desk-workspace") || "",
    currentView: null,
    filter: "all",
    publish: null,
  };

  const pageNames = { dashboard: "Dashboard", new: "新建更新", review: "更新审核", upscale: "AI 超分", publish: "发布预览", settings: "设置" };
  const resourceNames = {
    jacket: "曲绘", "pack-cover": "曲包封面", background: "背景", "character-portrait": "角色立绘", "character-avatar": "角色头像",
    "linkplay-preview": "LinkPlay", sticker: "贴纸", "story-cg": "剧情 CG", "story-texture": "剧情贴图", startup: "启动页", "world-mode": "世界模式",
    "phigros-april-fools": "April Fools", other: "其他",
  };
  const statusNames = { EXTRACTED: "待审核", NAMING_REVIEW: "待审核", NEEDS_UPSCALE: "需超分", UPSCALE_PENDING: "超分处理中", UPSCALE_DETECTED: "已找到超分", UPSCALE_CONVERTED: "待最终确认", FINAL_REVIEW: "最终确认", READY: "已完成", REJECTED: "已忽略", BLOCKED: "阻塞" };

  const $ = (selector) => document.querySelector(selector);
  const page = () => $("#page");
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = -1;
    do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
  };
  const formatDate = (value) => {
    try { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); } catch { return "—"; }
  };
  const percent = (value) => `${Math.max(0, Math.min(100, Math.round((value || 0) * 100)))}%`;
  const statusChip = (label, kind = "") => `<span class="status-chip ${kind}">${escapeHtml(label)}</span>`;

  class ApiError extends Error {
    constructor(payload, status) { super(payload?.error?.message || "请求失败"); this.detail = payload?.error?.detail; this.code = payload?.error?.code; this.status = status; }
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload, response.status);
    return payload;
  }

  function notify(title, detail = "", kind = "") {
    const root = $("#toast-root");
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}`;
    if (detail && detail.includes("\n")) node.innerHTML += `<details><summary>技术详情</summary><p>${escapeHtml(detail)}</p></details>`;
    root.appendChild(node);
    window.setTimeout(() => node.remove(), 6500);
  }

  function showError(error) {
    notify(error.message || "操作失败", error.detail || "", "danger");
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("asset-desk-theme", theme);
    const button = $("[data-action='toggle-theme']");
    if (button) button.textContent = theme === "dark" ? "浅色模式" : "深色模式";
  }

  function currentWorkspace() {
    return state.bootstrap?.workspaces?.find((item) => item.id === state.currentWorkspaceId);
  }

  function navigate(nextPage) {
    state.page = nextPage;
    if (nextPage === "review" || nextPage === "upscale" || nextPage === "publish") {
      if (!state.currentWorkspaceId) { state.page = "dashboard"; notify("先选择一个工作区", "创建或打开版本工作区后再继续。", "warn"); }
      else if (!state.currentView) loadWorkspace(state.currentWorkspaceId).catch(showError);
    }
    renderShell();
    renderPage();
  }

  function renderShell() {
    document.querySelectorAll("[data-page]").forEach((item) => item.classList.toggle("active", item.dataset.page === state.page));
    $("#page-crumb").textContent = pageNames[state.page] || "Dashboard";
    const select = $("#workspace-select");
    if (select) {
      const options = ['<option value="">未选择</option>', ...(state.bootstrap?.workspaces || []).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.gameName)} ${escapeHtml(item.targetVersion)}</option>`)].join("");
      select.innerHTML = options;
      select.value = state.currentWorkspaceId;
    }
  }

  function renderPage() {
    if (!state.bootstrap) { page().innerHTML = '<div class="loading">正在读取工作区…</div>'; return; }
    const renderers = { dashboard: renderDashboard, new: renderNew, review: renderReview, upscale: renderUpscale, publish: renderPublish, settings: renderSettings };
    renderers[state.page]?.();
    page().focus({ preventScroll: true });
  }

  function renderDashboard() {
    const workspaces = state.bootstrap.workspaces || [];
    const pending = workspaces.reduce((sum, item) => sum + item.pendingCount, 0);
    const upscale = workspaces.reduce((sum, item) => sum + item.needsUpscaleCount, 0);
    const blocked = workspaces.reduce((sum, item) => sum + item.blockedCount, 0);
    page().innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><p>从最近的版本工作区继续处理。</p></div><div class="head-actions"><button class="button button-primary" data-page="new">新建版本更新</button></div></div>
      <div class="grid dashboard-grid">
        <div class="stat-card"><span class="stat-label">待确认</span><strong class="stat-value">${pending}</strong><span class="stat-note">跨全部工作区</span></div>
        <div class="stat-card"><span class="stat-label">需要超分</span><strong class="stat-value">${upscale}</strong><span class="stat-note">等待外部 AI 输出</span></div>
        <div class="stat-card"><span class="stat-label">阻塞</span><strong class="stat-value">${blocked}</strong><span class="stat-note">需要手动处理</span></div>
      </div>
      <div class="section-head"><h2>最近工作区</h2><span class="muted">${workspaces.length} 个工作区</span></div>
      ${workspaces.length ? `<div class="workspace-list">${workspaces.map(renderWorkspaceRow).join("")}</div>` : '<div class="empty-state"><strong>还没有版本工作区</strong><span>选择旧版和新版 APK，开始一次本地更新。</span><div class="form-actions" style="justify-content:center"><button class="button button-primary" data-page="new">新建更新</button></div></div>'}
    `;
  }

  function renderWorkspaceRow(item) {
    return `<button class="workspace-row" data-action="open-workspace" data-workspace-id="${escapeHtml(item.id)}">
      <span class="workspace-main"><span class="game-dot ${item.game}"></span><span><span class="workspace-title">${escapeHtml(item.gameName)} ${escapeHtml(item.targetVersion)}</span><span class="workspace-meta">基于 ${escapeHtml(item.baseVersion)} · ${escapeHtml(statusNames[item.status] || item.status)} · ${formatDate(item.updatedAt)}</span></span></span>
      <span class="workspace-counts"><span class="count-chip ${item.pendingCount ? "warn" : ""}">待确认 ${item.pendingCount}</span><span class="count-chip ${item.needsUpscaleCount ? "accent" : ""}">超分 ${item.needsUpscaleCount}</span><span class="count-chip ${item.blockedCount ? "danger" : ""}">阻塞 ${item.blockedCount}</span></span>
    </button>`;
  }

  async function loadApks(game) {
    const note = $("#apk-note");
    const oldSelect = $("#apk-old");
    const newSelect = $("#apk-new");
    if (!oldSelect || !newSelect) return;
    try {
      const result = await api(`/api/apks?game=${encodeURIComponent(game)}`);
      const options = result.apks.map((apk) => `<option value="${escapeHtml(apk.filename)}">${escapeHtml(apk.version)} · ${escapeHtml(apk.filename)} · ${formatBytes(apk.sizeBytes)}</option>`).join("");
      oldSelect.innerHTML = options || '<option value="">没有找到可识别 APK</option>';
      newSelect.innerHTML = options || '<option value="">没有找到可识别 APK</option>';
      if (result.apks.length < 2) {
        note.className = "inline-note warn";
        note.textContent = "需要旧版和新版两个 APK 才能提取更新。";
      } else {
        note.className = "inline-note";
        note.textContent = `${result.apks.length} 个 APK 已读入，可选择旧版和新版。`;
        oldSelect.selectedIndex = 0;
        newSelect.selectedIndex = result.apks.length > 1 ? result.apks.length - 1 : 0;
      }
    } catch (error) {
      note.className = "inline-note warn";
      note.textContent = error.message;
      oldSelect.innerHTML = '<option value="">请先配置 APK 目录</option>';
      newSelect.innerHTML = '<option value="">请先配置 APK 目录</option>';
    }
  }

  function renderNew() {
    const config = state.bootstrap.config;
    page().innerHTML = `
      <div class="page-head"><div><h1>新建更新</h1><p>选择一对本地 APK，生成版本工作区。</p></div></div>
      <form class="panel" data-form="new-workspace">
        <div class="form-grid">
          <div class="form-field"><label for="new-game">游戏</label><select id="new-game" name="game">${state.bootstrap.games.map((game) => `<option value="${game.id}">${escapeHtml(game.name)}</option>`).join("")}</select></div>
          <div class="form-field"><label>提取器</label><div class="inline-note">使用已配置旧项目的 Phase 2C 提取器与 adapter</div></div>
          <div class="form-field"><label for="apk-old">旧 APK</label><select id="apk-old" name="baseFilename"><option value="">读取中…</option></select></div>
          <div class="form-field"><label for="apk-new">新 APK</label><select id="apk-new" name="targetFilename"><option value="">读取中…</option></select></div>
          <div class="form-field full"><div id="apk-note" class="inline-note">正在扫描配置目录…</div></div>
          <div class="form-field full"><span class="input-note">APK 目录：${escapeHtml(config.arcaeaApkDir || "未配置")}（Arcaea） · ${escapeHtml(config.phigrosApkDir || "未配置")}（Phigros）</span></div>
          ${config.legacyExtractorRoot ? "" : '<div class="form-field full"><div class="inline-note warn">还没有配置旧项目提取器目录。可以先在设置中填写 legacy project root。</div></div>'}
        </div>
        <div class="form-actions"><button class="button button-primary" type="submit">提取更新资源</button><button class="button button-quiet" type="button" data-page="settings">打开设置</button></div>
      </form>
    `;
    loadApks($("#new-game").value).catch(showError);
  }

  function candidateFilter(candidate) {
    if (state.filter === "all") return true;
    if (state.filter === "pending") return !candidate.confirmed && !["READY", "REJECTED", "BLOCKED"].includes(candidate.status);
    if (state.filter === "info") return candidate.needsInfo;
    if (state.filter === "upscale") return candidate.needsUpscale || candidate.upscale.matches.length > 0;
    if (state.filter === "done") return candidate.confirmed || candidate.status === "READY";
    if (state.filter === "blocked") return candidate.status === "BLOCKED";
    return true;
  }

  function filterCounts(candidates) {
    return {
      all: candidates.length,
      pending: candidates.filter((item) => !item.confirmed && !["READY", "REJECTED", "BLOCKED"].includes(item.status)).length,
      info: candidates.filter((item) => item.needsInfo).length,
      upscale: candidates.filter((item) => item.needsUpscale || item.upscale.matches.length > 0).length,
      done: candidates.filter((item) => item.confirmed || item.status === "READY").length,
      blocked: candidates.filter((item) => item.status === "BLOCKED").length,
    };
  }

  function renderReview() {
    const view = state.currentView;
    if (!view) { page().innerHTML = '<div class="loading">正在读取工作区…</div>'; return; }
    const counts = filterCounts(view.candidates);
    const safeCount = view.candidates.filter((item) => !item.needsInfo && item.status !== "BLOCKED" && !item.confirmed && item.status !== "REJECTED").length;
    const candidates = view.candidates.filter(candidateFilter);
    page().innerHTML = `
      <div class="page-head"><div><h1>更新审核</h1><p>${escapeHtml(view.gameName)} ${escapeHtml(view.targetVersion)} · ${view.candidateCount} 个候选</p></div><div class="head-actions"><button class="button" data-action="rescan-workspace">重新扫描</button>${safeCount ? `<button class="button button-primary" data-action="confirm-all">确认所有无异常项（${safeCount}）</button>` : ""}</div></div>
      <div class="filter-bar">${[["all", "全部"], ["pending", "待确认"], ["info", "需补充信息"], ["upscale", "需超分"], ["done", "已完成"], ["blocked", "阻塞"]].map(([key, label]) => `<button class="filter-button ${state.filter === key ? "active" : ""}" data-action="filter" data-filter="${key}">${label} ${counts[key]}</button>`).join("")}</div>
      ${candidates.length ? `<div class="candidate-grid">${candidates.map(renderCandidateCard).join("")}</div>` : '<div class="empty-state"><strong>这个筛选下没有候选</strong><span>换一个筛选，或重新扫描工作区。</span></div>'}
    `;
  }

  function renderCandidateCard(candidate) {
    const isInfo = candidate.needsInfo;
    const issueHtml = candidate.issues.length ? `<div class="candidate-issues">${candidate.issues.map((issue) => `<div class="issue">${escapeHtml(issue)}</div>`).join("")}</div>` : "";
    const canConfirm = !candidate.confirmed && candidate.status !== "BLOCKED" && candidate.status !== "REJECTED";
    const detail = candidate.details;
    const technical = `<details class="technical"><summary>详细信息</summary><div class="detail-content"><dl class="detail-list"><dt>源文件</dt><dd>${escapeHtml(detail.sourceFilename)}</dd><dt>源路径</dt><dd><code>${escapeHtml(detail.sourceRelativePath || "—")}</code></dd><dt>来源版本</dt><dd>${escapeHtml(detail.sourceGameVersion || "—")}</dd><dt>来源类型</dt><dd>${escapeHtml(detail.sourceType)}</dd><dt>SHA-256</dt><dd><code>${escapeHtml(detail.sourceSha256 || "未记录")}</code></dd></dl><div class="candidate-tags">${detail.externalIdentities.map((item) => `<span class="tag">${escapeHtml(item.key)} · ${escapeHtml(item.value)}</span>`).join("")}</div></div></details>`;
    const override = `<details class="override" ${isInfo ? "open" : ""}><summary>${isInfo ? "补充信息" : "修改"}</summary><form class="override-form" data-form="override" data-candidate-id="${escapeHtml(candidate.id)}"><label class="field-label">曲名</label><input name="title" value="${escapeHtml(candidate.title || candidate.suggestedTitle || "")}" placeholder="${candidate.suggestedTitle ? "保留推测名称也可以" : "填写曲名"}" /><label class="field-label">曲师</label><input name="artist" value="${escapeHtml(candidate.artist || "")}" placeholder="填写曲师" /><label class="field-label">下载文件名（可选）</label><input name="filename" value="${escapeHtml(candidate.filename || "")}" placeholder="保留自动命名" /><button class="button button-small" type="submit">保存修改</button></form></details>`;
    const finalize = candidate.confirmed && candidate.status !== "READY" && candidate.status !== "REJECTED" && !candidate.needsUpscale ? '<button class="button button-small" data-action="finalize-new" data-candidate-id="' + escapeHtml(candidate.id) + '">标记为新资源</button>' : "";
    return `<article class="candidate-card ${candidate.status === "BLOCKED" ? "is-blocked" : ""}"><div class="asset-preview"><img src="${escapeHtml(candidate.previewUrl)}" alt="${escapeHtml(candidate.title || candidate.filename)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'preview-placeholder', textContent: '预览不可用' }))" /></div><div class="candidate-body"><div class="candidate-topline"><h3 class="candidate-title" title="${escapeHtml(candidate.title || candidate.filename)}">${escapeHtml(candidate.title || "未识别名称")}</h3>${statusChip(statusNames[candidate.status] || candidate.status, candidate.status === "BLOCKED" ? "danger" : candidate.confirmed ? "ok" : candidate.status === "READY" ? "ok" : "")}</div><div class="candidate-artist">${escapeHtml(candidate.artist || (candidate.suggestedTitle ? `推测：${candidate.suggestedTitle}` : "曲师未识别"))}</div><div class="candidate-tags"><span class="tag accent">${escapeHtml(resourceNames[candidate.resourceType] || candidate.resourceType)}</span>${candidate.difficulty ? `<span class="tag">${escapeHtml(candidate.difficulty)}</span>` : ""}<span class="tag">${escapeHtml(candidate.filename)}</span></div>${issueHtml}<div class="candidate-actions">${canConfirm ? '<button class="button button-primary button-small" data-action="confirm" data-candidate-id="' + escapeHtml(candidate.id) + '">确认</button>' : ""}${finalize}${candidate.status === "BLOCKED" ? "" : '<button class="button button-small" data-action="open-folder" data-folder="workspace">打开工作区</button>'}</div>${override}${technical}</div></article>`;
  }

  function renderUpscale() {
    const view = state.currentView;
    if (!view) { page().innerHTML = '<div class="loading">正在读取工作区…</div>'; return; }
    const items = view.candidates.filter((candidate) => candidate.needsUpscale || candidate.upscale.matches.length > 0 || candidate.upscale.converted);
    const total = view.candidates.filter((candidate) => candidate.needsUpscale || candidate.upscale.converted).length;
    const complete = view.candidates.filter((candidate) => candidate.upscale.converted).length;
    page().innerHTML = `<div class="page-head"><div><h1>AI 超分</h1><p>准备输入、扫描外部输出，再转换为 JPG。</p></div><div class="head-actions"><button class="button" data-action="open-folder" data-folder="upscale-input">打开超分输入</button><button class="button" data-action="open-folder" data-folder="upscale-output">打开超分输出</button><button class="button" data-action="prepare-upscale">准备超分文件</button><button class="button button-primary" data-action="rescan-upscale">重新扫描</button></div></div>
      <div class="panel"><div class="section-head" style="margin-top:0"><h2>处理进度</h2><span class="muted">${complete} / ${total} 已转换</span></div><div class="progress-line"><span style="width:${total ? (complete / total) * 100 : 0}%"></span></div><div class="form-actions"><button class="button button-small" data-action="open-folder" data-folder="processed">打开处理结果</button><span class="input-note">输入 PNG 会保留，JPG 使用 q95、sRGB、4:4:4、progressive。</span></div></div>
      ${items.length ? `<div class="upscale-list" style="margin-top:14px">${items.map(renderUpscaleRow).join("")}</div>` : '<div class="empty-state" style="margin-top:14px"><strong>当前没有待超分候选</strong><span>需要超分的资源会出现在这里。</span></div>'}`;
  }

  function renderUpscaleRow(candidate) {
    const attempts = candidate.upscale.matches.length ? `<div class="upscale-attempts">${candidate.upscale.matches.map((match) => `<span class="attempt ${match.selected ? "selected" : ""}">${escapeHtml(match.filename)}${match.selected ? " · 已选" : match.state === "ambiguous" ? " · 需处理" : ""}${!match.selected && match.state === "matched" ? `<button class="button button-small" data-action="select-upscale" data-candidate-id="${escapeHtml(candidate.id)}" data-output-file-id="${escapeHtml(match.fileId)}">选择</button>` : ""}</span>`).join("")}</div>` : '<div class="input-note" style="margin-top:9px">还没有找到 *_optimization.png 输出。</div>';
    const conversion = candidate.upscale.converted ? `<div class="inline-note ok" style="margin-top:9px">已转换 · ${formatBytes(candidate.upscale.inputBytes)} → ${formatBytes(candidate.upscale.outputBytes)} · 节省 ${percent(candidate.upscale.sizeReductionRatio)}</div>` : "";
    const selected = candidate.upscale.matches.some((match) => match.selected);
    return `<div class="upscale-row"><div><div class="upscale-title">${escapeHtml(candidate.title || candidate.filename)}</div><div class="upscale-meta"><span>${escapeHtml(resourceNames[candidate.resourceType] || candidate.resourceType)}</span><span>${escapeHtml(candidate.filename)}</span>${candidate.issues.length ? `<span class="issue">${escapeHtml(candidate.issues[0])}</span>` : ""}</div>${attempts}${conversion}</div><div class="upscale-actions">${selected && !candidate.upscale.converted ? `<button class="button button-primary button-small" data-action="convert-upscale" data-candidate-id="${escapeHtml(candidate.id)}">转换为 JPG</button>` : ""}</div></div>`;
  }

  function renderPublish() {
    const view = state.currentView;
    if (!view) { page().innerHTML = '<div class="loading">正在读取工作区…</div>'; return; }
    const publish = state.publish;
    page().innerHTML = `<div class="page-head"><div><h1>发布预览</h1><p>${escapeHtml(view.gameName)} ${escapeHtml(view.targetVersion)} · 当前只生成 dry-run 计划，不会上传。</p></div><div class="head-actions"><button class="button button-primary" data-action="generate-publish">生成发布计划</button></div></div>
      <div class="panel"><div class="inline-note ${view.blockedCount ? "danger" : view.readyCount ? "ok" : "warn"}">${view.blockedCount ? `还有 ${view.blockedCount} 个候选阻塞，暂不能生成计划。` : view.readyCount ? `${view.readyCount} 个候选已准备发布。` : "先完成审核并绑定发布目标，再生成计划。"}</div>${publish ? `<div class="publish-summary"><div class="publish-number"><strong>${publish.summary.addedResources}</strong><span>新增资源</span></div><div class="publish-number"><strong>${publish.summary.updatedResources}</strong><span>更新资源</span></div><div class="publish-number"><strong>${publish.summary.uploadObjects}</strong><span>新增文件</span></div><div class="publish-number"><strong>${formatBytes(publish.summary.uploadBytes)}</strong><span>预计上传</span></div></div><details open><summary>详细变化</summary><div class="change-list">${publish.manifest.changes.length ? publish.manifest.changes.map((change) => `<div class="change-row">${escapeHtml(change.detail)}</div>`).join("") : '<div class="input-note">没有 Catalog 变化。</div>'}</div></details><details style="margin-top:12px"><summary>计划说明</summary><div class="detail-content">${publish.plan.notes.map((note) => `<div class="input-note">${escapeHtml(note)}</div>`).join("")}</div></details>` : '<div class="empty-state" style="margin-top:16px"><strong>还没有发布计划</strong><span>生成 dry-run 后，这里会显示新增资源、更新资源和对象体积。</span></div>'}</div>`;
  }

  function renderSettings() {
    const config = state.bootstrap.config;
    page().innerHTML = `<div class="page-head"><div><h1>设置</h1><p>只配置本机目录；Admin 不保存账号或密钥。</p></div><div class="head-actions"><span class="tag accent">仅监听 127.0.0.1</span></div></div><form class="panel" data-form="settings"><div class="form-grid"><div class="form-field full"><label for="setting-arcaea">Arcaea APK 本地目录</label><input id="setting-arcaea" name="arcaeaApkDir" value="${escapeHtml(config.arcaeaApkDir)}" placeholder="例如 D:\\Games\\Arcaea\\APK" /></div><div class="form-field full"><label for="setting-phigros">Phigros APK 本地目录</label><input id="setting-phigros" name="phigrosApkDir" value="${escapeHtml(config.phigrosApkDir)}" placeholder="例如 D:\\Games\\Phigros\\APK" /></div><div class="form-field full"><label for="setting-runtime">workspace / runtime 路径</label><input id="setting-runtime" name="workspaceRuntimePath" value="${escapeHtml(config.workspaceRuntimePath)}" /><span class="input-note">工作区会按 game/version 保存，重启后从这里恢复。</span></div><div class="form-field full"><label for="setting-extractor">旧项目提取器根目录（可选）</label><input id="setting-extractor" name="legacyExtractorRoot" value="${escapeHtml(config.legacyExtractorRoot)}" placeholder="包含 scripts/extract-arcaea-update.ts 的目录" /><span class="input-note">只用于调用已完成的 Phase 2C 前置提取脚本，不会修改旧项目。</span></div><div class="form-field full"><label for="setting-legacy">Legacy Asset Root（可选）</label><input id="setting-legacy" name="legacyAssetRoot" value="${escapeHtml(config.legacyAssetRoot)}" /><span class="input-note">仅用于首次迁移/查看；它不是日常版本归档目录。</span></div><div class="form-field full"><label for="setting-catalog">Catalog JSON（可选）</label><input id="setting-catalog" name="catalogPath" value="${escapeHtml(config.catalogPath)}" placeholder="留空则使用空 Catalog 做 dry-run" /></div></div><div class="form-actions"><button class="button button-primary" type="submit">保存设置</button><span class="input-note">保存后重新扫描工作区即可生效。</span></div></form>`;
  }

  async function loadWorkspace(id) {
    state.currentWorkspaceId = id;
    window.localStorage.setItem("asset-desk-workspace", id);
    state.currentView = await api(`/api/workspaces/${encodeURIComponent(id)}`);
    state.bootstrap.workspaces = await api("/api/workspaces").then((result) => result.workspaces);
    renderShell();
    renderPage();
  }

  function updateView(payload) {
    if (payload.view) state.currentView = payload.view;
    else if (payload.candidates) state.currentView = payload;
    if (state.bootstrap) state.bootstrap.workspaces = state.bootstrap.workspaces.map((item) => item.id === state.currentView?.id ? { ...item, ...state.currentView } : item);
    renderShell();
    renderPage();
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    if (action === "toggle-theme") { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); return; }
    if (action === "open-workspace") { await loadWorkspace(button.dataset.workspaceId); navigate("review"); return; }
    if (action === "filter") { state.filter = button.dataset.filter || "all"; renderPage(); return; }
    if (action === "confirm") { updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/confirm`, { method: "POST", body: JSON.stringify({ candidateId: button.dataset.candidateId }) })); notify("已确认", "自动命名和 provenance 保持不变。", "ok"); return; }
    if (action === "confirm-all") { const count = Number((button.textContent.match(/（(\d+)）/) || [])[1] || 0); if (!window.confirm(`确认 ${count} 个无异常候选？`)) return; const result = await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/confirm-all`, { method: "POST", body: "{}" }); updateView(result); notify(`已确认 ${result.confirmed} 个候选`, result.skipped ? `跳过 ${result.skipped} 个需要补充信息或阻塞的候选。` : "", "ok"); return; }
    if (action === "rescan-workspace") { const result = await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/rescan`, { method: "POST", body: "{}" }); updateView(result); notify("重新扫描完成", result.messages?.join("\n") || "没有发现需要处理的变化。", "ok"); return; }
    if (action === "prepare-upscale") { updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/upscale/prepare`, { method: "POST", body: "{}" })); notify("超分输入已准备", "可以打开 upscale-input/ 并运行外部 AI 工具。", "ok"); return; }
    if (action === "rescan-upscale") { const result = await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/upscale/rescan`, { method: "POST", body: "{}" }); updateView(result); notify("超分输出已重新扫描", "没有自动猜测有歧义的输出。", "ok"); return; }
    if (action === "select-upscale") { updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/upscale/select`, { method: "POST", body: JSON.stringify({ candidateId: button.dataset.candidateId, outputFileId: button.dataset.outputFileId }) })); notify("已选择超分结果", "下一步可以转换为 JPG。", "ok"); return; }
    if (action === "convert-upscale") {
      try {
        updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/upscale/convert`, { method: "POST", body: JSON.stringify({ candidateId: button.dataset.candidateId, alphaPolicy: "block" }) }));
        notify("JPG 转换完成", "源 PNG 已保留。", "ok");
      } catch (error) {
        if (error.code !== "UPSCALE_CONVERSION_BLOCKED" || !error.message.includes("透明")) throw error;
        if (!window.confirm("图片包含透明区域，不能直接转换为 JPG。是否使用白底转换？")) throw error;
        updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/upscale/convert`, { method: "POST", body: JSON.stringify({ candidateId: button.dataset.candidateId, alphaPolicy: "flatten-white" }) }));
        notify("JPG 转换完成", "透明区域已使用白底处理，源 PNG 已保留。", "ok");
      }
      return;
    }
    if (action === "open-folder") { await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/open-folder`, { method: "POST", body: JSON.stringify({ folder: button.dataset.folder }) }); notify("已打开文件夹", "", "ok"); return; }
    if (action === "finalize-new") { if (!window.confirm("将这个候选标记为新资源并加入发布预览？")) return; updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/candidates/${encodeURIComponent(button.dataset.candidateId)}/finalize`, { method: "POST", body: JSON.stringify({ createNewTarget: true }) })); notify("已加入发布预览", "这是明确的新资源操作，尚未上传。", "ok"); return; }
    if (action === "generate-publish") { state.publish = await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/publish/dry-run`, { method: "POST", body: "{}" }); renderPage(); notify("发布计划已生成", "这是 dry-run，不会连接 ROS 或上传。", "ok"); return; }
  }

  async function handleSubmit(form) {
    if (form.dataset.form === "new-workspace") {
      const data = new FormData(form);
      const payload = Object.fromEntries(data.entries());
      const button = form.querySelector("button[type='submit']");
      button.disabled = true; button.textContent = "提取中…";
      try {
        const result = await api("/api/workspaces/create", { method: "POST", body: JSON.stringify(payload) });
        state.bootstrap.workspaces = [result.view, ...(state.bootstrap.workspaces || []).filter((item) => item.id !== result.view.id)];
        await loadWorkspace(result.view.id);
        navigate("review");
        notify("工作区已创建", `${result.view.gameName} ${result.view.targetVersion} · ${result.view.candidateCount} 个候选`, "ok");
      } catch (error) { showError(error); button.disabled = false; button.textContent = "提取更新资源"; }
      return;
    }
    if (form.dataset.form === "override") {
      const data = new FormData(form);
      const payload = Object.fromEntries(data.entries());
      try { updateView(await api(`/api/workspaces/${encodeURIComponent(state.currentWorkspaceId)}/candidates/${encodeURIComponent(form.dataset.candidateId)}/override`, { method: "POST", body: JSON.stringify(payload) })); notify("修改已保存", "仍需要再次确认候选。", "ok"); } catch (error) { showError(error); }
      return;
    }
    if (form.dataset.form === "settings") {
      const data = Object.fromEntries(new FormData(form).entries());
      try { state.bootstrap.config = await api("/api/config", { method: "PUT", body: JSON.stringify(data) }); state.bootstrap.workspaces = await api("/api/workspaces").then((result) => result.workspaces); renderShell(); renderPage(); notify("设置已保存", "目录配置已更新。", "ok"); } catch (error) { showError(error); }
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-page], [data-action]");
    if (!target) return;
    if (target.dataset.page) { event.preventDefault(); navigate(target.dataset.page); return; }
    event.preventDefault(); handleAction(target).catch(showError);
  });
  document.addEventListener("submit", (event) => { const form = event.target.closest("form"); if (!form) return; event.preventDefault(); handleSubmit(form).catch(showError); });
  document.addEventListener("change", (event) => { if (event.target.id === "new-game") loadApks(event.target.value).catch(showError); if (event.target.id === "workspace-select") { const id = event.target.value; if (id) loadWorkspace(id).then(() => navigate(state.page === "dashboard" ? "review" : state.page)).catch(showError); } });

  async function init() {
    setTheme(window.localStorage.getItem("asset-desk-theme") || "light");
    try {
      state.bootstrap = await api("/api/bootstrap");
      if (!state.bootstrap.workspaces.some((item) => item.id === state.currentWorkspaceId)) state.currentWorkspaceId = state.bootstrap.workspaces[0]?.id || "";
      renderShell(); renderPage();
    } catch (error) { page().innerHTML = `<div class="empty-state"><strong>Admin 无法连接后端</strong><span>${escapeHtml(error.message)}</span></div>`; showError(error); }
  }
  init();
})();
