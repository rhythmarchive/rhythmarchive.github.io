# Phase 7 Handoff

## Scope

Phase 7 将 Arcaea APK updater 的正式执行环境改为 GitHub-hosted Actions runner。雨云服务器不访问 lowiro，不运行 updater、systemd timer、代理或服务器锁；Admin 只负责触发 GitHub workflow。

唯一官方上游是 `https://webapi.lowiro.com/webapi/serve/static/bin/arcaea/apk`。API 返回当前版本和官方 CDN APK URL；updater 直接请求 API，校验 URL、filename 与版本一致后下载并验证 APK，不再依赖 Playwright 或官网 DOM。

## Workflow

- 文件：`.github/workflows/arcaea-apk-update.yml`
- schedule：`*/30 * * * *` UTC，每半小时运行一次。
- `workflow_dispatch` 只有 `mode` input：`publish`（默认）或 `check-only`。
- `concurrency.group` 为 `arcaea-apk-update`，`cancel-in-progress: false`；定时和手动触发串行等待。
- workflow 只执行 checkout、Node 22、`tools/arcaea-apk-updater/package-lock.json` 对应的独立 `npm ci` 和 updater 脚本；网站根依赖不参与 Arcaea 定时任务。

CLI 仍可本地运行：

```powershell
npm run arcaea:apk:check
npm run arcaea:apk:check -- --check-only
```

`check-only` 真实访问官方 APK API、发现版本和官方 CDN host，不读取或写入 ROS，不下载 APK。

## Safety and publish contract

- source APK 必须来自官方 API 返回的 HTTPS URL，host 精确为 `arcaea-static.lowiro-cdn.net`；下载 redirect 会重新校验 host。
- manifest v2 中的 GitHub 下载 URL 只能是 `https://github.com/rhythmarchive/rhythmarchive.github.io/releases/download/arcaea-apk-<version>/Arcaea_<version>.apk`；official 下载 URL 只能是 HTTPS 且 host 精确为 `arcaea-static.lowiro-cdn.net`；不会接受任意 redirect origin。
- 不接受 workflow input、Admin query 或 API body 注入 APK URL。
- 版本只接受当前 Arcaea 格式（数字段加可选单字母后缀），内部文件名固定为 `Arcaea_<version>.apk`。
- API 返回的 version 和下载 URL filename 数字段必须一致；不一致直接停止。
- 正式上传前检查文件存在、非空、1 MiB–2 GiB 合理范围、ZIP central directory、`AndroidManifest.xml`、SHA-256 和 `.part` 缺失；没有引入 Android SDK 或完整 APK analyzer。
- APK binary：GitHub Release tag `arcaea-apk-<version>`，asset 固定为 `Arcaea_<version>.apk`；APK 不进入 Git repository 或 ROS。
- public source of truth：`apk/arcaea/latest.json`，设置 `application/json; charset=utf-8` 和 `public, max-age=300`。
- publish 顺序是下载 → 本地验证和 SHA-256 → GitHub Release/asset 创建或复用 → Release asset metadata 验证 → latest.json PUT → latest.json GET 验证 → 删除 third-oldest managed GitHub Release。
- 无更新为 0 APK download、0 GitHub Release 操作、0 ROS manifest PUT、0 delete。
- 当前 `latest = B, previous = A` 发布 C 后变为 `latest = C, previous = B`，manifest 验证后只删除 tag 为 `arcaea-apk-<version>` 且 title 符合 updater 约定的 A Release；普通项目 Release 不会删除。cleanup 失败只产生 warning，不回滚 C/B；后续有新版发布时会再次尝试。
- latest.json PUT 失败时保留已创建或复用的 C Release asset；下一次会重新完成本地验证并复用匹配的 canonical asset，不会重复上传。
- bootstrap 时 `previous = null`。异常版本回退只 warning/停止，不自动 rollback。

## latest.json schema

```json
{
  "schemaVersion": 2,
  "game": "arcaea",
  "generatedAt": "2026-08-17T01:15:00.000Z",
  "latest": {
    "version": "6.17.1",
    "versionCode": null,
    "fileName": "Arcaea_6.17.1.apk",
    "fileSize": 123456789,
    "sha256": "…",
    "downloads": {
      "github": "https://github.com/rhythmarchive/rhythmarchive.github.io/releases/download/arcaea-apk-6.17.1/Arcaea_6.17.1.apk",
      "official": "https://arcaea-static.lowiro-cdn.net/download?filename=arcaea_6.17.1.apk"
    },
    "publishedAt": "2026-08-17T01:15:00.000Z"
  },
  "previous": null
}
```

manifest 只保留经过 host 校验的 official URL 和 versioned GitHub asset URL；不包含 credentials、GitHub token、runner path 或 workflow id。

## Admin and public site

- Admin dashboard 增加 Arcaea APK 小区域，读取 ROS `latest.json` 显示 latest、previous 和公开发布时间。
- `POST /api/admin/apk/arcaea/check` 仅在现有 Admin 本机访问边界内可调用，服务器使用 `GITHUB_ACTIONS_TRIGGER_TOKEN` 调 GitHub REST `workflow_dispatch`，固定 ref `main` 和 `mode=publish`，立即返回 `{ "status": "started" }`。
- Admin 进程对成功 dispatch 做轻量 5 分钟 debounce，并拒绝同一时刻的提交中请求；GitHub concurrency 仍负责跨 runner 的串行等待。
- 浏览器不会得到 GitHub token，也不会直接访问 lowiro。
- workflow 使用 GitHub Actions 自动提供的 `GITHUB_TOKEN`，权限仅为 `contents: write`；不需要用户创建 PAT、Administration 或 Organization access。
- Actions 复用现有 ROS client 环境名：`ROS_ACCESS_KEY`、`ROS_SECRET_KEY`、`ROS_ENDPOINT`、`ROS_BUCKET`、`ROS_PUBLIC_BASE_URL`。这些值只能配置为 GitHub Repository/Environment Secrets。
- 首页只新增 APK card；浏览器 GET `https://rhythm-assets.cn-nb1.rains3.com/apk/arcaea/latest.json`，manifest 成功后直接渲染 latest/previous 的 GitHub 下载和 official 下载，官方按钮文案为“官方下载链接”。下载按钮是直接 `<a href>`，不使用 JS Blob/arrayBuffer。
- manifest/CORS/ROS 暂时不可用时只显示“暂时无法获取 APK 下载信息”和官网链接，不影响首页其他内容。

## Validation status

已完成本地 fixture 验证：

- latest == discovered：零下载、零 ROS 写入。
- 新版本：APK 验证后才上传，manifest 最后写入。
- APK 验证失败：latest 不变。
- A/B → C：发布 C/B 后删除 A。
- cleanup 失败：C/B 保留，返回 warning。
- 后续有新版时只按 previous manifest 推导并重试需要删除的 managed GitHub Release；旧 ROS APK orphan 不由 updater 扫描或删除。
- manifest PUT 失败：下一次复用已有 C。
- manifest 与首页 parser 拒绝非目标 GitHub repository、非 `arcaea-apk-` tag、非官方 CDN host 的 APK URL。
- workflow schedule/concurrency 和首页 latest/previous parser 有轻量测试。
- 本机 `npm run arcaea:apk:check -- --check-only` 已真实访问官方 APK API，发现 API 返回的版本和 `arcaea-static.lowiro-cdn.net` 下载地址；没有下载 APK。

此前的 `e34a8c7` 已在 GitHub-hosted Ubuntu runner 上完成 `check-only`；本次独立 updater 依赖隔离仍应在推送后重复一次 `check-only`，确认独立 `npm ci`、API → lowiro CDN → version/URL 全链路成功，再运行 `publish`。

## Final local checks

完成代码后运行：

```powershell
npm run typecheck
npm test
npm run site:check
npm run site:build
```

本次依赖隔离未执行正式 APK 下载、ROS APK PUT、latest.json 正式写入、ROS delete 或 deploy；网站 Pages workflow、Catalog、Gallery、Detail、Search 和其他冻结范围保持不变。

首次生产启用仍需用户完成：

1. 配置 GitHub ROS Secrets。
2. 在 Admin 服务器配置 `GITHUB_ACTIONS_TRIGGER_TOKEN`。
3. commit/push 本地改动。
4. 手动运行一次 `mode=check-only`，记录 GitHub-hosted runner 实测结果。
5. 针对 `https://rhythmarchive.github.io` 做 latest.json、GitHub asset URL 和 official URL 的 targeted check。
6. 用户批准后再第一次运行 `mode=publish`，并确认 ROS latest/previous。

## Production Hotfix

1.8 GiB APK 在 GitHub-hosted runner → Rainyun ROS 的大文件上传吞吐不可接受，因此 APK binary storage 已改为 GitHub Releases：GitHub Actions 从 Lowiro 官方 APK API 获取 CDN URL，下载并本地验证后，创建或复用唯一的 `arcaea-apk-<version>` Release 和 `Arcaea_<version>.apk` asset；ROS 只保存小型 `apk/arcaea/latest.json`。manifest 使用 schema v2，同时提供 versioned GitHub 下载和经 host 校验的 official 下载。Release asset 通过 filename/size 及可用的 SHA-256 digest 幂等复用，单文件 `>= 2 GiB` 时阻断 GitHub mirror publish。此前失败的 Phase 7 ROS APK objects 不自动删除，待 GitHub Release 正式验收后人工清理；workflow 会记录创建/复用、上传、验证和发布阶段日志。
