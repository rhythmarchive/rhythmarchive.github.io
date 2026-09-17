# Rhythm Archive stats Worker

这是站点统计的独立 Cloudflare Worker + D1 模块。Worker 不接收客户端的“加一”指令；visitorId 只是可伪造的匿名去重输入，不是身份认证。统计写入还必须命中由 PublicSiteData 生成的当前公开 resource registry。

## API

- GET /health：健康检查，不访问 D1，并返回绑定的 Public Catalog 生成时间。
- POST /v1/events：接受 site_visit、resource_detail、resource_download。resourceId 必须是当前公开 Catalog 投影中的 UUIDv7；格式正确但不在 registry 中的 ID 会以 resource_not_public 拒绝。
- POST /v1/resources/stats：最多 100 个当前公开资源 ID；只读，不创建统计行。
- GET /v1/resources/ranking?period=7d|all&limit=N：默认 12 项，最多 50 项；只返回 resourceId、views、downloads，历史/随机 ID 不会进入结果。
- POST /v1/update-reminders：接受当前公共投影中的游戏。首次有效提醒返回 202，同一 visitorId 对同一游戏 24 小时内重复返回 409。
- GET /v1/admin/update-reminders：需要 Authorization: Bearer UPDATE_REMINDER_ADMIN_TOKEN。
- POST /v1/admin/update-reminders/:game/resolve：鉴权后关闭当前 pending 周期但保留历史。
- POST /v1/admin/update-reminders/:game/retry-notification：鉴权后重置当前通知重试状态。

公开接口有 body 上限和短期限流。限流键是 Cloudflare edge client 的短期哈希，不保存原始 IP、UA、地理位置或页面轨迹。visitorId 只用于普通去重，不能绕过服务端限流。若配置 RATE_LIMITER binding，优先使用边缘限流；未配置时使用 D1 短期桶，并保留 isolate 内存后备。

站点访问按匿名 visitor ID 的 30 分钟窗口去重。资源 detail 和直接下载共享一个资源 view 去重键；下载另有 10 秒短窗口。有效 view/download 同时写入 resource_stats 和 resource_daily_stats，因此 7 日榜使用同一去重结果。累计 resource_stats 保留，日统计、event dedupe、限流桶和过期 reminder visitor 由 5 分钟 cron 清理。

更新提醒按游戏建立 pending cycle，保留首次/最近提醒时间、累计有效提醒数、resolved_at 和通知状态。首次有效提醒触发一封 Resend 邮件；同一 pending cycle 后续提醒只累计，不重复发信。若配置 TURNSTILE_SECRET_KEY，Worker 会在写入前服务端调用 Turnstile siteverify；Pages 同时需要配置公开的 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY。邮件失败按有限退避重试，最多 5 次；管理接口可查询、resolve 或手动重试。

旧迁移建立的 update_reminders 和 update_reminder_rate_limits 表已经停止写入，但本地代码不会自动删除历史数据；清理前请由仓库所有者备份并确认。

## 首次创建和部署

在仓库根目录运行：

~~~
npm --prefix workers/stats exec -- wrangler login
npm --prefix workers/stats exec -- wrangler d1 create rhythm-archive-stats
~~~

将创建命令输出的 database ID 写入 wrangler.toml 的 database_id，再运行：

~~~
npm --prefix workers/stats run migrate:remote
npm --prefix workers/stats run deploy
~~~

部署前从根目录运行：

~~~
npm run stats:registry
npm run worker:check
npm run browse:check
npm run ci:check
~~~

registry 文件必须和这次公开 Catalog 一起提交。部署后用返回的 Worker URL 作为站点构建环境的 PUBLIC_STATS_API_URL。D1 管理凭据、Resend、Turnstile 和限流哈希 secret 只通过 Wrangler secret 配置，不写入站点或 Git。

生产建议在 wrangler.toml 增加 RATE_LIMITER binding，使用当前账号内唯一的正整数 namespace_id；binding 名称必须是 RATE_LIMITER，simple period 使用 60 秒。RATE_LIMIT_HASH_SECRET 应通过以下命令配置：

~~~
npm --prefix workers/stats exec -- wrangler secret put RATE_LIMIT_HASH_SECRET
npm --prefix workers/stats exec -- wrangler secret put UPDATE_REMINDER_ADMIN_TOKEN
npm --prefix workers/stats exec -- wrangler secret put RESEND_API_KEY
npm --prefix workers/stats exec -- wrangler secret put UPDATE_REMINDER_EMAIL_TO
npm --prefix workers/stats exec -- wrangler secret put TURNSTILE_SECRET_KEY
~~~

## 本地开发

wrangler.toml 明确允许 rhythmarchive.github.io、localhost 和 127.0.0.1，没有开放通配 Origin。运行本地 D1 和 Worker：

~~~
npm --prefix workers/stats run migrate:local
npm --prefix workers/stats run dev
~~~

本地 Astro 使用 PUBLIC_STATS_API_URL=http://127.0.0.1:8787；没有配置时静态站点仍可构建，统计展示保持隐藏。提醒入口还需要 Pages 构建变量 PUBLIC_UPDATE_REMINDERS_ENABLED=true；若启用 Turnstile，还要设置 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY。