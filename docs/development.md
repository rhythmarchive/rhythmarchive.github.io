# 架构与本地开发

Rhythm Archive 以 Astro 生成静态页面。浏览器执行搜索、筛选、资源选择及 ZIP 下载；Stats Worker 单独提供统计和更新提醒。网站没有用户登录或文件上传服务。

## 目录与数据流

| 目录 | 职责 |
| --- | --- |
| `catalog/` | 资源 Catalog、Browse 语义和更新记录的公开源数据 |
| `packages/domain/src/` | Zod 数据契约、身份、校验和对象 URL 规则 |
| `apps/site/src/` | Astro 页面、共享组件、公共投影与浏览器脚本 |
| `apps/site/scripts/` | 数据生成、内容校验、流量预算和构建 smoke |
| `workers/stats/` | Worker 路由、公开资源 registry、D1 migrations 和测试 |
| `tools/` | 公开 Browse 校验与独立 Arcaea APK 更新器 |
| `.github/workflows/` | PR 检查、Pages 发布及 APK 自动更新 |

`catalog/index.json` 经 `site-data.ts` 与 `catalog-projection.ts` 转为 `PublicSiteData`，再结合 `catalog/browse/` 的游戏语义与 `catalog/updates/index.json` 的时间线。`generate-public-data.ts` 将图库、搜索、榜单卡片及批量下载数据写入 `apps/site/public/data/`；Astro 构建生成 `apps/site/dist/`。

图库卡片使用预览图，原图和高清图在详情或明确下载操作中提供。批量下载元数据按分类拆分并延迟读取，ZIP 在浏览器打包，网站不代理图片字节。相关预算由 `traffic:check` 检查实际构建产物。

`generate-stats-resource-registry.ts` 从公开投影生成 Worker 使用的资源与游戏 registry。Worker 仅接受当前公开资源的统计写入；Catalog 中存在的 ID 不必然出现在公开投影中。

## 开发环境

[贡献指南](../CONTRIBUTING.md)提供安装、启动、构建与验证命令。公开仓库可以独立构建静态站点，不依赖维护者的私有提取工具或运维应用。

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_ROS_BASE_URL` | 公开图片对象存储地址；默认值见生成器 |
| `PUBLIC_STATS_API_URL` | 统计 API 地址，本地 Worker 通常为 `http://127.0.0.1:8787`；未配置时隐藏统计展示 |
| `PUBLIC_UPDATE_REMINDERS_ENABLED` | 更新提醒入口开关 |
| `PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY` | 提醒 widget 的公开 site key |

`PUBLIC_*` 会进入浏览器或公开产物，只能包含公开值。Worker 本地秘密配置放在被忽略的 `workers/stats/.dev.vars`；无需生产凭据即可开发静态页面和运行测试。

## 修改与验证

页面交互与数据投影的测试在 `apps/site/tests/`；Worker 业务与 D1 适配器的测试在 `workers/stats/tests/`。检查脚本 `scripts/maintenance-check.mjs` 按变更路径选择受影响检查；完整检查 `ci:check` 包含类型、测试、内容、Worker、Astro、构建、流量和 smoke。

数据变更保持稳定资源身份、引用完整性和公开边界，详见[数据模型](catalog.md)。更新记录解释用户实际获得的内容，详见[时间线模型](update-timeline.md)。生产配置、迁移与部署顺序见[维护者文档](maintainers/README.md)。
