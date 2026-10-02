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

公开接口有 body 上限和短期限流。限流键是 Cloudflare edge client 的短期哈希，不保存原始 IP、UA、地理位置或页面轨迹。visitorId 只用于普通去重，不能绕过服务端限流。RATE_LIMITER binding 是每个 scope 的前置 120 次/60 秒突发拦截；通过后仍使用现有 D1 短期桶执行接口额度：events 和 resource-stats 各 60 次/分钟，update-reminders 20 次/10 分钟，site stats 与 ranking 共用 stats-read 120 次/分钟。未配置绑定也执行同样的 D1 规则；无持久化适配器的本地测试保留 isolate 内存后备。绑定拒绝时不访问 D1；绑定或 D1 限流失败返回 503，不放行。通过原生检查的请求增加现有 D1 限流操作（当前为清理、计数、读取三条语句），需关注 D1 用量。

站点访问按匿名 visitor ID 的 30 分钟窗口去重。资源 detail 和直接下载共享一个资源 view 去重键；下载另有 10 秒短窗口。有效 view/download 同时写入 resource_stats 和 resource_daily_stats，因此 7 日榜使用同一去重结果。累计 resource_stats 保留，日统计、event dedupe、限流桶和过期 reminder visitor 由 5 分钟 cron 清理。

更新提醒按游戏建立 pending cycle，保留首次/最近提醒时间、累计有效提醒数、resolved_at 和通知状态。首次有效提醒触发一封 Resend 邮件；同一 pending cycle 后续提醒只累计，不重复发信。Turnstile 默认必需：写入提醒前服务端调用 siteverify，要求 success、hostname 和 action 均符合配置。Secret 或预期 hostname/action 缺失返回 503 turnstile_unavailable；无 token、验证失败或 claims 不符返回 403 turnstile_failed。Pages 同时需要公开的 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY；客户端 action 固定为 update-reminder。邮件失败按有限退避重试，最多 5 次；管理接口可查询、resolve 或手动重试。

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

wrangler.toml 已有 RATE_LIMITER binding，保留其 namespace_id，simple limit=120、period=60；它不再代替各接口的 D1 窗口。RATE_LIMIT_HASH_SECRET 应通过以下命令配置：

~~~
npm --prefix workers/stats exec -- wrangler secret put RATE_LIMIT_HASH_SECRET
npm --prefix workers/stats exec -- wrangler secret put UPDATE_REMINDER_ADMIN_TOKEN
npm --prefix workers/stats exec -- wrangler secret put RESEND_API_KEY
npm --prefix workers/stats exec -- wrangler secret put UPDATE_REMINDER_EMAIL_TO
npm --prefix workers/stats exec -- wrangler secret put TURNSTILE_SECRET_KEY
~~~

生产配置应为 TURNSTILE_REQUIRED=true、TURNSTILE_EXPECTED_HOSTNAME=rhythmarchive.github.io、TURNSTILE_EXPECTED_ACTION=update-reminder，已写入 wrangler.toml 的非秘密 vars。TURNSTILE_REQUIRED 未设置时也要求验证；只有显式 false 且无 Secret 才跳过，限于本地开发/测试，生产不得使用。如果有 Secret，即使设 false 也仍校验全部 claims。

控制台确认（本轮只改代码，不部署或修改这些设置）：

- Cloudflare → Workers & Pages → rhythm-archive-stats → Settings → Variables and Secrets：确认上述三项非秘密 vars；TURNSTILE_SECRET_KEY 为对应生产 widget 的 Secret，RATE_LIMIT_HASH_SECRET 已设置。不要把 Secret 值写进 Git。
- 同一 Worker → Settings → Bindings：RATE_LIMITER 保持现有 namespace、120/60 秒；DB 仍为 rhythm-archive-stats。没有新绑定或 D1 迁移。
- Cloudflare → Turnstile → 本站 widget → Settings / Hostname Management：允许 rhythmarchive.github.io，生产 widget 不加入 localhost/127.0.0.1 或无关域名。action 由前端 render 发送，不是控制台的域名设置；后端预期值必须为 update-reminder。
- GitHub 仓库 → Settings → Secrets and variables → Actions → Variables：PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY 与上述 widget 匹配，PUBLIC_UPDATE_REMINDERS_ENABLED=true，PUBLIC_STATS_API_URL 指向当前 Stats Worker。site key 是公开值，不能填 Secret key。

后续正式发布须使 Worker 的 action 校验与 Pages 新客户端配套上线。旧客户端不发送 action，新 Worker 会拒绝其提醒；发布时考虑既有缓存/已打开页面，提示刷新后重试，不能用放宽服务端检查代替配套发布。

## Catalog 发布和自动部署

主分支 Pages 使用 change-aware 检查。只有生成的 public-resource-registry.ts 实际变化、Worker 代码/配置变化或共享 UUID 运行代码变化才部署 Worker。Catalog 时间戳、Updates、Browse 排序、页面样式不会触发。registry-only 只验证数据，不重跑 Worker 业务测试。部署后 /health.registryHash 必须匹配生成的 SHA-256，然后发布 Pages。publishedAt 不从部署时间回写。

Pages 工作流的 build job 使用 `stats-production` Environment。请将该 Environment 的部署分支限制为 `main`，并把 `CLOUDFLARE_API_TOKEN` 保存为 Environment Secret；不要保留仓库级同名 Secret。Token 需能编辑 Stats Worker，并管理 `rhythmarchive.top` 区域中的 `api.rhythmarchive.top` Custom Domain。将 `CLOUDFLARE_ACCOUNT_ID` 和 `PUBLIC_STATS_API_URL` 保存为仓库 Variables。手动重发 Worker 时，只允许从 `main` 的 `workflow_dispatch` 勾选 `deploy_stats_worker`。

## 本地开发

wrangler.toml 明确允许 rhythmarchive.github.io、localhost 和 127.0.0.1，没有开放通配 Origin。运行本地 D1 和 Worker：

~~~
npm --prefix workers/stats run migrate:local
npm --prefix workers/stats run dev
~~~

本地 Astro 使用 PUBLIC_STATS_API_URL=http://127.0.0.1:8787；没有配置时静态站点仍可构建，统计展示保持隐藏。提醒入口还需要 Pages 构建变量 PUBLIC_UPDATE_REMINDERS_ENABLED=true；若启用 Turnstile，还要设置 PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY。
本地明确不测试验证码时，可在被忽略的 workers/stats/.dev.vars 中设置 TURNSTILE_REQUIRED=false 且不配置 TURNSTILE_SECRET_KEY；这不会改动生产 wrangler.toml。
