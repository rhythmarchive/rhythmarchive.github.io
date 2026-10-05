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

公开接口有 body 上限和短期限流。限流键是 Cloudflare edge client 的短期哈希，不保存原始 IP、UA、地理位置或页面轨迹。visitorId 只用于普通去重，不能绕过服务端限流。RATE_LIMITER binding 是每个 scope 的前置 120 次/60 秒突发拦截；通过后仍使用现有 D1 短期桶执行接口额度：events 和 resource-stats 各 60 次/分钟，update-reminders 20 次/10 分钟，site stats 与 ranking 共用 stats-read 120 次/分钟。未配置绑定也执行同样的 D1 规则；无持久化适配器的本地测试保留 isolate 内存后备。绑定拒绝时不访问 D1；绑定或 D1 限流失败返回 503，不放行。每个通过原生检查的请求只用一条 D1 SQL 完成限流计数（UPSERT ... RETURNING 同时返回新的窗口状态，不再额外 SELECT）；过期限流桶由 Cron 按 window_started_at 索引清理，读取失败或状态缺失仍返回 503。

站点访问按匿名 visitor ID 的 30 分钟窗口去重。资源 detail 和直接下载共享一个资源 view 去重键；下载另有 10 秒短窗口。有效 view/download 同时写入 resource_stats 和 resource_daily_stats，因此 7 日榜使用同一去重结果。累计 resource_stats 保留，日统计、event dedupe、限流桶和过期 reminder visitor 由 5 分钟 cron 清理。

事件热路径用条件 UPSERT claim：仅旧 expires_at <= 当前时刻时更新过期时间，不再全局 DELETE。重复事件不续期；即使 Cron 延迟，30 分钟/10 秒窗口仍在准确边界恢复计数。

7d/all 榜单使用现有 Workers Cache API 缓存 60 秒，无新绑定或迁移。缓存键包含 host、registry hash、统计日期、period 和 limit；每个请求在查缓存前仍执行原生与 D1 限流。缓存只存榜单 entries，不存 CORS 或限流响应，API 对浏览器仍返回 no-store。冷缓存请求在同一 isolate 合并聚合；成功空榜也可缓存，缓存故障回源，D1 故障返回 503且不缓存错误。榜单最多短暂滞后 60 秒；跨日期/registry 不复用。Cache API 按 Cloudflare 地点独立，命中率取决于实际路由和缓存存活，不能宣称全世界每分钟只查一次。详见 [D1 热路径与用量](../../docs/maintainers/d1-usage.md)。

更新提醒按游戏建立 pending cycle，保留首次/最近提醒时间、累计有效提醒数、resolved_at 和通知状态。每次后端有效计入的提醒都创建独立邮件记录并触发一封 Resend 邮件，同一 pending cycle 内也一样。重复、去重、Turnstile 验证失败或限流请求不创建邮件记录。Turnstile 默认必需：写入提醒前服务端调用 siteverify，要求 success、hostname 和 action 均符合配置。Secret 或预期 hostname/action 缺失返回 503 turnstile_unavailable；无 token、验证失败或 claims 不符返回 403 turnstile_failed。Pages 同时需要公开的 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY；客户端 action 固定为 update-reminder。邮件失败按现有 Cron 有限退避重试，每封最多 5 次；管理接口可查询、resolve 或手动重试。resolve 继续关闭当前周期并停止其未发送通知。每封邮件使用稳定的 Resend Idempotency-Key 和不变的提醒时间/计数，避免网络不确定或重试导致重复投递。

邮件额度固定为每 UTC 自然日最多 80 次 Resend 调用（北京时间每天 08:00 重置），由 D1 条件 UPSERT 在发送前原子占用，HTTP 失败、网络错误和重试均计入，不退还额度。超额仍返回 202、入库并累计提醒数，独立邮件记录标记 failed / daily_limit_reached、next_notification_at=NULL，当天不发送，次日也不补发；次日新有效提醒恢复发送，手动 retry 不复活额度跳过记录。额度存储异常时不调用 Resend。上限仅覆盖本 Worker，80 × 31 = 2,480，给 Resend Free 的 100/天、3,000/月额度留出余量；同一账号的其他应用发信仍共享供应商额度。

迁移 0006_update_reminder_emails.sql 新增每次有效提醒的邮件状态历史表 update_reminder_notifications 和每日尝试计数表 update_reminder_email_daily。周期已有的通知字段继续作为最近有效提醒的状态摘要；独立记录保存各封邮件的重试状态，旧记录重试不会覆盖较新提醒的摘要。迁移只保留旧 pending 周期中尚未发送的单次通知，不回放已发送周期的历史提醒；上线当天保守计入现有周期的发送尝试。远端迁移与部署顺序见[运维文档](../../docs/maintainers/stats-operations.md)；Pages 部署流程不自动运行迁移。

旧迁移建立的 update_reminders 和 update_reminder_rate_limits 表已经停止写入，但本地代码不会自动删除历史数据；清理前请由仓库所有者备份并确认。

## 生产运维

首次创建、远端 D1 迁移、Secrets 和自动部署说明集中在[维护者运维文档](../../docs/maintainers/stats-operations.md)。贡献者可使用本地 D1 开发，无需生产权限。

## 本地开发

wrangler.toml 明确允许 rhythmarchive.github.io、localhost 和 127.0.0.1，没有开放通配 Origin。运行本地 D1 和 Worker：

~~~
npm --prefix workers/stats run migrate:local
npm --prefix workers/stats run dev
~~~

本地 Astro 使用 PUBLIC_STATS_API_URL=http://127.0.0.1:8787；没有配置时静态站点仍可构建，统计展示保持隐藏。提醒入口还需要 Pages 构建变量 PUBLIC_UPDATE_REMINDERS_ENABLED=true；若启用 Turnstile，还要设置 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY。
本地明确不测试验证码时，可在被忽略的 workers/stats/.dev.vars 中设置 TURNSTILE_REQUIRED=false 且不配置 TURNSTILE_SECRET_KEY；这不会改动生产 wrangler.toml。
