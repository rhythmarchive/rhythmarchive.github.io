# 资源反馈与下载异常

复用 Stats Worker 的 DB、Origin 白名单、原生 RATE_LIMITER、D1 IP 限流、Turnstile、Resend 和更新提醒每日邮件预算。没有新的服务、后台、队列或 CDN 探测请求。

## 手动启用

本地提交不会修改生产 D1、Secret 或部署。保持 `RESOURCE_REPORTS_ENABLED = "false"` 直到配置完成。

1. 在 Stats Worker 目录手动执行 `npx wrangler d1 migrations apply rhythm-archive-stats --remote`，确认包含 `0007_resource_reports.sql`。不要将远程迁移放入 Pages 构建。
2. 保留现有 `DB`、`RATE_LIMITER`、`RATE_LIMIT_HASH_SECRET`、`ALLOWED_ORIGINS` 和五分钟 Cron；复用已有 `RESEND_API_KEY`、`TURNSTILE_SECRET_KEY`。
3. 添加 Secret `RESOURCE_REPORT_EMAIL_TO`（接收反馈的邮箱）。可选设置 `RESOURCE_REPORT_EMAIL_FROM`（Resend 已验证域名的发件地址，例如 `Rhythm Archive <reports@example.com>`）；未设置沿用现有 `onboarding@resend.dev`，受 Resend 测试域收件限制。邮箱和密钥只放 Worker Secrets 或忽略的 `.dev.vars`。
4. `TURNSTILE_EXPECTED_HOSTNAME` 必须与站点域名一致。人工反馈固定验证 action `resource-feedback`，更新提醒仍为 `update-reminder`，不要修改现有 `TURNSTILE_EXPECTED_ACTION`。可复用现有 Turnstile widget，但需要允许站点域名。
5. 站点构建继续使用 `PUBLIC_STATS_API_URL` 和 `PUBLIC_UPDATE_REMINDERS_TURNSTILE_SITE_KEY`。未配置时详情入口仍保留 GitHub Discussions 和现有反馈页的 Giscus；邮件表单不显示。Turnstile 仅展开表单后加载。
6. 手动将 Worker 配置 `RESOURCE_REPORTS_ENABLED` 改为 `"true"` 后部署 Worker，再发布站点。缺 DB、收件邮箱或 Resend key 时接口返回 503；人工反馈缺 Turnstile 配置时也关闭接受。生产发信验证需由维护者完成，本地测试不证明送达。

官方参数说明：[Turnstile 服务端 hostname/action 校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[Resend 幂等键](https://resend.com/changelog/idempotency-keys)。

## 接受、汇总与成本

- `POST /v1/resource-feedback`：公开资源 ID、问题类型、5–2000 字描述、最多 200 字名称、Turnstile token。名称明确标作用户提供；详情链接由服务端使用固定站点和已验证 ID 生成，不接受任意链接、收件邮箱或下载 URL。同一匿名网络来源对同一资源十分钟只接受一次。
- `POST /v1/download-failures`：只接受公开资源 ID 和 `network`／`http_400`–`http_599`。不接收计数、URL、原始错误栈、浏览器身份或描述。复用现有按 UTC 日加盐的 IP hash，不保留 IP。每资源／错误／小时同一网络来源计一次；同小时至少三个不同网络来源才提醒。客户端报告只是可疑故障线索，CORS 和用户网络故障不能证明 CDN 故障。
- 两条路由各自每 IP 20 次／十分钟，原生和 D1 限流同时生效，缺允许的 Origin 拒绝。复用现有 16 KiB 流式请求上限。正常下载没有新请求；异常最多每页面十个资源／错误组合，每组合一次，不等待、不重试、无轮询。
- 接受／重复请求：现有限流 1 条 SQL，加事务去重及汇总写入 2 条 SQL，共 3 条。重复不修改汇总计数；限流拒绝仅 1 条 SQL。人工接受额外一次 Turnstile 请求，自动报告无此请求。
- 现有五分钟 Cron：启用时两条带索引过期清理及一条最多十行待发查询；无任务不发邮件。每项发送最多三条 SQL（原子 claim、共享预算、结果状态）和一次 Resend 请求。人工反馈下个 Cron 发送；自动报告整点后发送。
- 所有报告与去重记录最多保留七天。汇总邮件与人工反馈共用已有 UTC 每日最多 80 次 Resend 尝试额度，更新提醒也在此额度内。失败、不确定和重试尝试都消耗预算，不追加新额度。故障大量发生时会占用更新提醒额度。
- 发送前原子标记 `attempted`；并发 Cron 不重复发送。采用稳定幂等键与五秒超时，每报告最多尝试一次。`sent`、`http_*`、`uncertain`、`daily_limit_reached` 可在 D1 的 `resource_reports.delivery` 查看；不会跨天积压补发或自动重试。Worker 中断可能保留 `attempted`，人工反馈 202 表示已记录，不能宣称已送达。

## 下载统计语义

单文件获取完整 Blob 并交给浏览器后计数；批量完整准备 ZIP 并交给浏览器后计数。HTTP／网络失败不计数；主动取消、大小限制、ZIP／本地保存异常不作为远程故障上报。HTTP 错误不走直链回退，网络故障继续使用原有带 Referer 策略的直链回退。

浏览器最终保存、直链跳转与直链回退无法确认，因此不增加下载计数，也不推测其失败。已有历史计数保留，无法可靠追溯扣减。去重下载对象、并发限制、30 文件／300 MB 上限、按需 manifest 加载、防盗链与预览省流策略保持原有行为。
