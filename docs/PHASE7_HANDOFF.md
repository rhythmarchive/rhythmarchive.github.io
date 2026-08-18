# Phase 7 Handoff

## Scope

Phase 7 将 Arcaea APK updater 的正式执行环境改为 GitHub-hosted Actions runner。雨云服务器不访问 lowiro，不运行 updater、systemd timer、代理或服务器锁；Admin 只负责触发 GitHub workflow。

唯一官方上游是 `https://arcaea.lowiro.com/zh`。实现复用了旧项目 `scripts/check-arcaea-apk.ts` 的 Playwright Chromium、官方 CDN anchor、`.version`、filename fallback、`.part` 下载和完成后 rename 思路，并补上了官方 URL 校验、canonical filename、ROS manifest 和发布恢复边界。

## Workflow

- 文件：`.github/workflows/arcaea-apk-update.yml`
- schedule：`15 1,7,13,19 * * *` UTC，对应北京时间 09:15、15:15、21:15、次日 03:15。
- `workflow_dispatch` 只有 `mode` input：`publish`（默认）或 `check-only`。
- `concurrency.group` 为 `arcaea-apk-update`，`cancel-in-progress: false`；定时和手动触发串行等待。
- workflow 只执行 checkout、Node 22、`npm ci`、Playwright Chromium 和 `npm run arcaea:apk:check`。

CLI 仍可本地运行：

```powershell
npm run arcaea:apk:check
npm run arcaea:apk:check -- --check-only
```

`check-only` 真实访问官网、发现版本和官方 CDN host，不读取或写入 ROS，不下载 APK。

## Safety and publish contract

- source APK 只能是 HTTPS 且 host 精确为 `arcaea-static.lowiro-cdn.net`；下载 redirect 会重新校验 host。
- manifest 中的 APK URL 只能是配置的 ROS HTTPS public origin，且路径必须精确对应 `apk/arcaea/releases/<version>/Arcaea_<version>.apk`；不会接受任意 HTTPS host。
- 不接受 workflow input、Admin query 或 API body 注入 APK URL。
- 版本只接受当前 Arcaea 格式（数字段加可选单字母后缀），内部文件名固定为 `Arcaea_<version>.apk`。
- 页面版本和 filename 数字段必须一致；官网当前页面展示 `6.16.2`、filename 为 `6.16.2c` 时，仅保留这个窄兼容分支并采用精确 filename 版本；其他不一致直接停止。
- 正式上传前检查文件存在、非空、1 MiB–2 GiB 合理范围、ZIP central directory、`AndroidManifest.xml`、SHA-256 和 `.part` 缺失；没有引入 Android SDK 或完整 APK analyzer。
- versioned APK：`apk/arcaea/releases/<version>/Arcaea_<version>.apk`，设置 Android MIME、immutable cache 和 attachment disposition。
- public source of truth：`apk/arcaea/latest.json`，设置 `application/json; charset=utf-8` 和 `public, max-age=300`。
- publish 顺序是下载 → 验证 → SHA-256 → ROS object 检查/上传 → ROS 验证和 public HEAD/Content-Length → latest.json PUT → latest.json GET 验证 → 删除旧 previous。
- 无更新为 0 APK download、0 ROS PUT、0 manifest PUT、0 delete。
- 当前 `latest = B, previous = A` 发布 C 后变为 `latest = C, previous = B`，manifest 验证后列出并删除所有未被 latest/previous 引用的 canonical release APK。cleanup 失败只产生 warning，不回滚 C/B；后续有新版发布时会再次尝试。无更新仍保持 0 delete。
- latest.json PUT 失败时保留已上传 C；下一次会对 C 做 staging、ZIP、Manifest、SHA 和 size 校验后复用，不重新下载 lowiro。
- bootstrap 时 `previous = null`。异常版本回退只 warning/停止，不自动 rollback。

## latest.json schema

```json
{
  "schemaVersion": 1,
  "game": "arcaea",
  "generatedAt": "2026-08-17T01:15:00.000Z",
  "latest": {
    "version": "6.17.1",
    "versionCode": null,
    "fileName": "Arcaea_6.17.1.apk",
    "fileSize": 123456789,
    "sha256": "…",
    "url": "https://rhythm-assets.cn-nb1.rains3.com/apk/arcaea/releases/6.17.1/Arcaea_6.17.1.apk",
    "publishedAt": "2026-08-17T01:15:00.000Z"
  },
  "previous": null
}
```

manifest 不包含 lowiro 临时 URL、credentials、GitHub token、runner path 或 workflow id。

## Admin and public site

- Admin dashboard 增加 Arcaea APK 小区域，读取 ROS `latest.json` 显示 latest、previous 和公开发布时间。
- `POST /api/admin/apk/arcaea/check` 仅在现有 Admin 本机访问边界内可调用，服务器使用 `GITHUB_ACTIONS_TRIGGER_TOKEN` 调 GitHub REST `workflow_dispatch`，固定 ref `main` 和 `mode=publish`，立即返回 `{ "status": "started" }`。
- Admin 进程对成功 dispatch 做轻量 5 分钟 debounce，并拒绝同一时刻的提交中请求；GitHub concurrency 仍负责跨 runner 的串行等待。
- 浏览器不会得到 GitHub token，也不会直接访问 lowiro。
- GitHub fine-grained token 最小需要目标仓库 Actions Read and write；不需要 Contents write、Administration 或 Organization access。
- Actions 复用现有 ROS client 环境名：`ROS_ACCESS_KEY`、`ROS_SECRET_KEY`、`ROS_ENDPOINT`、`ROS_BUCKET`、`ROS_PUBLIC_BASE_URL`。这些值只能配置为 GitHub Repository/Environment Secrets。
- 首页只新增 APK card；浏览器 GET `https://rhythm-assets.cn-nb1.rains3.com/apk/arcaea/latest.json`，manifest 成功后直接渲染 latest/previous。下载按钮是直接 `<a href>`，不使用 JS Blob/arrayBuffer。
- manifest/CORS/ROS 暂时不可用时只显示“暂时无法获取 APK 下载信息”和官网链接，不影响首页其他内容。

## Validation status

已完成本地 fixture 验证：

- latest == discovered：零下载、零 ROS 写入。
- 新版本：APK 验证后才上传，manifest 最后写入。
- APK 验证失败：latest 不变。
- A/B → C：发布 C/B 后删除 A。
- cleanup 失败：C/B 保留，返回 warning。
- 后续有新版时会重新扫描 release namespace，重试之前遗留的 orphan APK；无更新不会触发删除。
- manifest PUT 失败：下一次复用已有 C。
- manifest 与首页 parser 拒绝任意非 ROS public origin 的 APK URL。
- workflow schedule/concurrency 和首页 latest/previous parser 有轻量测试。
- 本机 `npm run arcaea:apk:check -- --check-only` 已真实访问 lowiro，发现 `6.16.2c`，host 为 `arcaea-static.lowiro-cdn.net`；没有下载 APK。

GitHub-hosted Ubuntu runner 的 `check-only` 尚未实测：当前工作区未提交/未推送，无法在 GitHub-hosted runner 执行本地未推送代码。这是首次启用前的验收 blocker，不能把本机结果冒充 runner 结果。用户提交并推送后，应先在 Actions 手动选择 `check-only`，确认 Playwright → lowiro → version/CDN URL 成功，再批准第一次 `publish`。

## Final local checks

完成代码后运行：

```powershell
npm run typecheck
npm test
npm run site:check
npm run site:build
```

本轮未执行正式 APK 下载、ROS APK PUT、latest.json 正式写入、ROS delete、deploy、commit 或 push；Phase 6 workflow、图片 extractor、Review、超分、Catalog、Gallery、Detail、Search 和其他冻结范围未由 Phase 7 触发。

首次生产启用仍需用户完成：

1. 配置 GitHub ROS Secrets。
2. 在 Admin 服务器配置 `GITHUB_ACTIONS_TRIGGER_TOKEN`。
3. commit/push 本地改动。
4. 手动运行一次 `mode=check-only`，记录 GitHub-hosted runner 实测结果。
5. 针对 `https://rhythmarchive.github.io` 做 latest.json 和一个 APK URL 的 CORS targeted check。
6. 用户批准后再第一次运行 `mode=publish`，并确认 ROS latest/previous。

## Production Hotfix

1.8 GiB APK 暴露了单次 PUT 和上传后整包 GET 验证的生产瓶颈。APK 现在使用 AWS SDK `Upload` multipart upload，固定写入 `sha256` Object metadata；上传后只做 ROS HEAD metadata/size/Content-Type 验证和 public HEAD，不再回读整包。已有 size 合法且 SHA metadata 有效的 remote APK 直接复用；无 metadata 的旧对象不从 ROS 下载，而是重新下载官方 APK、验证后覆盖。上传进度按约 128 MiB/5% 节流输出，并保留失败 multipart 清理。
