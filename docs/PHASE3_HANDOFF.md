# Phase 3 Handoff — Local Admin WebUI MVP

## 完成内容

- Node 原生 HTTP API + 同源静态管理界面，启动命令为 `npm run admin`。
- Dashboard、 新建更新、更新审核、AI 超分、发布预览、设置六个页面。
- `packages/admin/src/registry.ts` 提供简单 GameConfig registry，当前注册 `arcaea`、`phigros`；新增游戏只需提供 adapter/提取器配置并注册能力。
- Admin 复用 Phase 2 的 `createWorkspaceFromExtractorResult`、`loadWorkspaceState`、`scan/reconcile`、confirm/override、upscale 和 PublishPlan dry-run API。

## 路由和主要 API

- `GET /api/bootstrap`、`GET/PUT /api/config`、`GET /api/apks`
- `GET /api/workspaces`、`GET /api/workspaces/:id`
- `POST /api/workspaces/create`
- `POST /api/workspaces/:id/rescan`
- `POST /api/workspaces/:id/confirm`、`confirm-all`
- `POST /api/workspaces/:id/candidates/:candidateId/override|identity|finalize`
- `POST /api/workspaces/:id/upscale/prepare|rescan|select|convert`
- `POST /api/workspaces/:id/open-folder`
- `POST /api/workspaces/:id/publish/dry-run`

## 审核体验

- Arcaea 高置信候选直接显示图片、标题、资源类型、难度和关键 metadata；点击“确认”即可完成人工确认，不会制造 filename override。支持明确显示数量后批量确认无异常项。
- Phigros 缺少曲名/曲师时突出“需补充信息”，字段修改是可选 override；信息完整时仍可直接确认。内部 UUID、hash、source path 只在“详细信息”展开区显示。

## AI 超分和发布预览

- UI 可准备输入目录、打开输入/输出/处理目录、重新扫描输出、选择候选、转换 JPG。
- 转换复用 q95、sRGB、4:4:4、progressive，保留 PNG；透明区域默认阻塞并提示，可明确选择白底处理。
- 发布页只生成 PublishPlan dry-run，展示新增资源、更新资源、新增文件和预计上传体积，不假装已经上传。

## 安全与恢复

- 仅监听 `127.0.0.1`；拒绝明显非本地 Host/Origin；不发送 secret，不开放任意 CORS。
- APK 只能通过已配置目录中的文件名选择；workspace ID 只能解析到配置 runtime 下的 `game/version`；打开文件夹只有四个登记目录，预览和 workspace 文件均做边界校验。
- `.runtime/admin-config.json` 和 Phase 2 JSON manifest 支持重启恢复，无 SQLite。

## 验证结果

- `npm run typecheck`：通过。
- `npm test`：34/34 通过，其中原有 Phase 2 测试 31 个，Admin API 测试 3 个。
- Admin 没有独立打包步骤，静态资源由 Node API 直接提供；因此没有新增 `npm run build`。

## 当前缺少

- 仍依赖用户配置并安装旧项目提取器及其运行环境；没有本地 APK 对时不下载。
- 尚未接 ROS、Catalog commit、上传、公开站、账号权限或数据库。
- Phigros changed-bundle 深度 diff、`_256` 等 Phase 2C 已知限制保持不变。
