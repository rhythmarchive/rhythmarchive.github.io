# Rhythm Archive stats Worker

这是站点统计的独立 Cloudflare Worker + D1 模块。Worker 不接收客户端的“加一”指令；visitorId 只是可伪造的匿名去重输入，不是身份认证。统计写入还必须命中由 PublicSiteData 生成的当前公开 resource registry。

本文面向开发者，介绍 API、统计语义和本地运行。生产配置与发布步骤见[维护者运维文档](../../docs/maintainers/stats-operations.md)。

## API

- GET /health：健康检查，不访问 D1，并返回绑定的 Public Catalog 生成时间。
- POST /v1/events：接受 site_visit、resource_detail、resource_download。resourceId 必须是当前公开 Catalog 投影中的 UUIDv7；格式正确但不在 registry 中的 ID 会以 resource_not_public 拒绝。
- POST /v1/resources/stats：最多 100 个当前公开资源 ID；只读，不创建统计行。
- GET /v1/resources/ranking?period=7d|all&limit=N：默认 12 项，最多 50 项；只返回 resourceId、views、downloads，历史/随机 ID 不会进入结果。
- POST /v1/update-reminders：接受当前公共投影中的游戏。每次有效提醒返回 202，同一 visitorId 对同一游戏 10 分钟内重复返回 409；满 10 分钟后可再次有效累计并发送邮件（仍受 Turnstile、IP 限流和每日邮件上限约束）。重复请求不延长去重窗口。
- GET /v1/admin/update-reminders：需要 Authorization: Bearer UPDATE_REMINDER_ADMIN_TOKEN。
- POST /v1/admin/update-reminders/:game/resolve：鉴权后关闭当前 pending 周期但保留历史。可带 JSON `{ "createdBefore": "带时区 ISO 时间" }`，仅结束在此时间之前已存在的周期；无符合条件的周期返回 404 pending_not_found，防止发布收尾重跑误关新周期。
- POST /v1/admin/update-reminders/:game/retry-notification：鉴权后重置当前通知重试状态。

## 行为语义

公开接口有 body 上限和短期限流。限流键是 Cloudflare edge client 的短期哈希，不保存原始 IP、UA、地理位置或页面轨迹；visitorId 用于去重，不能绕过限流。原生 RATE_LIMITER 对每个 scope 前置拦截 120 次/60 秒；通过后，D1 仍执行独立接口额度：events 和 resource-stats 各 60 次/分钟，update-reminders 20 次/10 分钟，site stats 与 ranking 共用 stats-read 120 次/分钟。没有原生绑定时也执行 D1 窗口；绑定或持久限流失败返回 503。

站点访问按匿名 visitorId 的 30 分钟窗口去重。资源详情和直接下载共享一个 30 分钟 view 去重键，下载另有 10 秒窗口。重复事件不延长窗口；Cron 延迟不影响到期后恢复计数。

7d/all 榜单缓存 60 秒，每次请求仍先限流，浏览器响应为 no-store。缓存按日期、registry、period 和 limit 隔离，缓存故障回源，D1 故障返回 503；统计写入立即生效，榜单展示最多滞后 60 秒。SQL、缓存实现与清理策略见 [D1 热路径与用量](../../docs/maintainers/d1-usage.md)。

更新提醒按游戏建立 pending cycle，保留首次/最近提醒时间、累计有效提醒数、resolved_at 和通知状态。每次后端有效计入的提醒都创建独立邮件记录并触发一封 Resend 邮件，同一 pending cycle 内也一样。重复、去重、Turnstile 验证失败或限流请求不创建邮件记录。Turnstile 默认必需：写入提醒前服务端调用 siteverify，要求 success、hostname 和 action 均符合配置。Secret 或预期 hostname/action 缺失返回 503 turnstile_unavailable；无 token、验证失败或 claims 不符返回 403 turnstile_failed。Pages 同时需要公开的 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY；客户端 action 固定为 update-reminder。邮件失败按现有 Cron 有限退避重试，每封最多 5 次；管理接口可查询、resolve 或手动重试。resolve 继续关闭当前周期并停止其未发送通知。每封邮件使用稳定的 Resend Idempotency-Key 和不变的提醒时间/计数，避免网络不确定或重试导致重复投递。

每个 UTC 自然日最多尝试发送 80 次邮件（北京时间每天 08:00 重置），失败和重试也计入额度。超额时提醒仍返回 202 并累计计数，但该封邮件当天不发送、次日不补发，手动 retry 不恢复额度跳过记录。额度存储异常时不调用邮件服务。

## 本地开发

以下命令在仓库根目录运行。`workers/stats` 是独立 npm 模块，先安装其依赖，再初始化本地 D1 并启动 Worker：

~~~
npm ci --prefix workers/stats
npm --prefix workers/stats run migrate:local
npm --prefix workers/stats run dev
~~~

wrangler.toml 允许 rhythmarchive.github.io、localhost 和 127.0.0.1，没有开放通配 Origin。

本地 Astro 使用 PUBLIC_STATS_API_URL=http://127.0.0.1:8787；没有配置时静态站点仍可构建，统计展示保持隐藏。提醒入口还需要 Pages 构建变量 PUBLIC_UPDATE_REMINDERS_ENABLED=true；若启用 Turnstile，还要设置 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY。
本地明确不测试验证码时，可在被忽略的 workers/stats/.dev.vars 中设置 TURNSTILE_REQUIRED=false 且不配置 TURNSTILE_SECRET_KEY；这不会改动生产 wrangler.toml。
