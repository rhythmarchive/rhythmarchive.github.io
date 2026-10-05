# Stats Worker 运维

面向生产维护者。API 和本地开发见 [Stats Worker README](../../workers/stats/README.md)，内容发布流程见[发布说明](publishing.md)。以下命令在仓库根目录运行；生产凭据仅由维护者配置。

## 首次创建和部署

在仓库根目录运行：

~~~
npm --prefix workers/stats exec -- wrangler login
npm --prefix workers/stats exec -- wrangler d1 create rhythm-archive-stats
~~~

将创建命令输出的 database ID 写入 wrangler.toml 的 database_id。先生成 registry 并完成检查：

~~~
npm run stats:registry
npm run ci:check
~~~

再应用远端迁移并部署：

~~~
npm --prefix workers/stats run migrate:remote
npm --prefix workers/stats run deploy
~~~

registry 文件必须和这次公开 Catalog 一起提交。部署后用返回的 Worker URL 作为站点构建环境的 PUBLIC_STATS_API_URL。D1 管理凭据、Resend、Turnstile 和限流哈希 secret 只通过 Wrangler secret 配置，不写入站点或 Git。

已有数据库也须在使用新表的 Worker 部署前应用所需迁移；Pages 工作流不自动迁移 D1。`0006_update_reminder_emails.sql` 为每次有效提醒增加独立邮件历史和每日尝试计数，保留旧 pending 周期尚未发送的单次通知，不回放已发送历史，并在迁移当日保守计入既有发送尝试。旧表的清理需要备份和确认，不由本地代码自动删除。

wrangler.toml 已有 RATE_LIMITER binding，保留其 namespace_id，simple limit=120、period=60；它不再代替各接口的 D1 窗口。RATE_LIMIT_HASH_SECRET 应通过以下命令配置：

~~~
npm --prefix workers/stats exec -- wrangler secret put RATE_LIMIT_HASH_SECRET
npm --prefix workers/stats exec -- wrangler secret put UPDATE_REMINDER_ADMIN_TOKEN
npm --prefix workers/stats exec -- wrangler secret put RESEND_API_KEY
npm --prefix workers/stats exec -- wrangler secret put UPDATE_REMINDER_EMAIL_TO
npm --prefix workers/stats exec -- wrangler secret put TURNSTILE_SECRET_KEY
~~~

生产配置应为 TURNSTILE_REQUIRED=true、TURNSTILE_EXPECTED_HOSTNAME=rhythmarchive.github.io、TURNSTILE_EXPECTED_ACTION=update-reminder，已写入 wrangler.toml 的非秘密 vars。TURNSTILE_REQUIRED 未设置时也要求验证；只有显式 false 且无 Secret 才跳过，限于本地开发/测试，生产不得使用。如果有 Secret，即使设 false 也仍校验全部 claims。

生产配置核对：

- Cloudflare → Workers & Pages → rhythm-archive-stats → Settings → Variables and Secrets：确认上述三项非秘密 vars；TURNSTILE_SECRET_KEY 为对应生产 widget 的 Secret，RATE_LIMIT_HASH_SECRET 已设置。不要把 Secret 值写进 Git。
- 同一 Worker → Settings → Bindings：RATE_LIMITER 保持现有 namespace、120/60 秒；DB 为 rhythm-archive-stats。检查绑定与当前 wrangler.toml 一致。
- Cloudflare → Turnstile → 本站 widget → Settings / Hostname Management：允许 rhythmarchive.github.io，生产 widget 不加入 localhost/127.0.0.1 或无关域名。action 由前端 render 发送，不是控制台的域名设置；后端预期值必须为 update-reminder。
- GitHub 仓库 → Settings → Secrets and variables → Actions → Variables：PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY 与上述 widget 匹配，PUBLIC_UPDATE_REMINDERS_ENABLED=true，PUBLIC_STATS_API_URL 指向当前 Stats Worker。site key 是公开值，不能填 Secret key。

Worker 的 action 校验与 Pages 客户端需要配套上线。旧客户端不发送 action，新 Worker 会拒绝其提醒；发布时考虑既有缓存/已打开页面，提示刷新后重试，不能用放宽服务端检查代替配套发布。

## Catalog 发布和自动部署

主分支 Pages 使用 change-aware 检查。只有生成的 public-resource-registry.ts 实际变化、Worker 代码/配置变化或共享 UUID 运行代码变化才部署 Worker。Catalog 时间戳、Updates、Browse 排序、页面样式不会触发。registry-only 只验证数据，不重跑 Worker 业务测试。部署后 /health.registryHash 必须匹配生成的 SHA-256，然后发布 Pages。publishedAt 不从部署时间回写。

Pages 工作流的 build job 使用 `stats-production` Environment。请将该 Environment 的部署分支限制为 `main`，并把 `CLOUDFLARE_API_TOKEN` 保存为 Environment Secret；不要保留仓库级同名 Secret。Token 需能编辑 Stats Worker，并管理 `rhythmarchive.top` 区域中的 `api.rhythmarchive.top` Custom Domain。将 `CLOUDFLARE_ACCOUNT_ID` 和 `PUBLIC_STATS_API_URL` 保存为仓库 Variables。手动重发 Worker 时，只允许从 `main` 的 `workflow_dispatch` 勾选 `deploy_stats_worker`。
