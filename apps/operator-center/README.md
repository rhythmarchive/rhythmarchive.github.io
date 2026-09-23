# Operator Center 接入边界

这里是未来独立部署到 Cloudflare 的站长数据中心基础骨架。当前只有数据契约、服务端环境契约、错误隔离和 mock；没有管理网页、Worker 路由或部署配置。GitHub Pages 仅上传 `apps/site/dist`，本目录不参与公开站点构建。

## 数据源

| 数据源 | 服务端入口与字段 | 授权方式 |
| --- | --- | --- |
| Stats | 复用 `workers/stats/src/core.ts` 的 `SiteStats`/`ResourceRankingEntry`；同一 D1 的 `site_totals`、`site_daily`、`resource_stats`、`resource_daily_stats`，明确 35 天 daily 留存 | Worker `DB` 绑定，仅读 SQL |
| Cloudflare Analytics | GraphQL Analytics API；先确认 Web Analytics 对应 dataset，再映射 pageViews、visits、transferBytes 与时间窗口，缺失指标保持 `null` | Worker Secret `CF_ANALYTICS_API_TOKEN` |
| 雨云 ROS | [雨云官方 ROS API 文档](https://www.rainyun.com/docs/products/ros/detail/api) 指向 [官方接口文档](https://apifox.com/apidoc/shared-a4595cc8-44c5-4678-a2a3-eed7738dab03/api-106165498)。接入时核实实例统计接口、计费周期、出站流量与请求数字段；不能把对象 `Content-Length` 之和当作实际流量 | Worker Secret `RAINYUN_API_KEY`，变量 `RAINYUN_ROS_ID` |
| GitHub Pages | GitHub Actions `pages.yml` workflow run 的 `head_sha`、`status`、`conclusion`、`html_url`，用部署环境记录确认 Pages 结果 | 公开仓库可只读 API；需要私有配额时使用 Worker Secret `GITHUB_TOKEN` |

`SourceResult<T>` 将每个来源分别标记为成功或不可用，并附观察时间；错误仅返回固定原因码。服务端不得将上游响应体、请求头、密钥、Cookie、完整异常对象或个人标识写入响应与日志。不同统计来源的定义和时区必须随指标显示，不能合并成一个未经解释的“访问量”。mock 只返回不可用状态，绝不伪造运营数字。

## 独立部署前的必做配置

1. 建独立 Cloudflare Worker/Pages 项目及独立域名；不要改 GitHub Pages 的 Astro root、`apps/site/public` 或 Stats Worker 的公开路由。
2. 为整个管理域名和所有路径创建 Cloudflare Access self-hosted 应用及允许策略，启用默认拒绝。Worker 再验证 `Cf-Access-Jwt-Assertion` 的签名、issuer、`CF_ACCESS_AUD`，不能只检查头存在。未完成双层校验前不要部署任何管理 API 或页面。参见 [Cloudflare Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
3. 在未来 Worker 配置中绑定现有 Stats D1 为 `DB`，申请只读用途。不要把 D1 ID 或凭据送给浏览器。D1 绑定是 Worker 侧能力，参见 [Cloudflare bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)。
4. 将 `.dev.vars.example` 复制到本地 `.dev.vars`，只在本地或 Cloudflare Secret 管理界面填真实值。`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`CF_ACCOUNT_ID`、`RAINYUN_ROS_ID`、`GITHUB_REPOSITORY` 是部署配置；`CF_ANALYTICS_API_TOKEN`、`RAINYUN_API_KEY`、`GITHUB_TOKEN` 是运行时 Secret。若将来用 S3 管理对象，再额外用 `ROS_ACCESS_KEY`、`ROS_SECRET_KEY` Secret，且与雨云管理 API key 分开。
5. 实现四个服务端 adapter、Access JWT 验证、响应 schema 校验和只读页面后，再单独建立部署/验收流程。浏览器只请求受 Access 保护的同源 Worker API；不要加入自制登录、客户端 token、公开 mock 后备或跨域管理 API。

类型检查：`npm run operator:typecheck`。本轮未连接账号，未测试雨云统计 API 可用字段，也未部署管理应用。
