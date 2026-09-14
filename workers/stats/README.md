# Rhythm Archive stats Worker

这是站点统计的独立 Cloudflare Worker + D1 模块。Worker 不接收客户端的“加一”指令，只接受 `site_visit`、`resource_detail` 和 `resource_download` 事件，并由 D1 去重记录决定最终是否更新计数。

## API

- `GET /health`：健康检查，不访问 D1。
- `GET /v1/site/stats`：返回 `{ totalVisits, todayVisits, date }`。
- `POST /v1/events`：请求体为 `{ "type": "site_visit", "visitorId": "..." }`，或带 `resourceId` 的资源事件。`resourceId` 必须是 Catalog 的 UUID 形式稳定 ID。
- `POST /v1/resources/stats`：请求体为 `{ "resourceIds": ["...", "..."] }`，最多 100 个 ID；返回一组 `{ views, downloads }`，没有记录的资源返回 0。
- `POST /v1/update-reminders`：请求体为 `{ "visitorId": "...", "game": "<公开游戏 slug>" }`；首次有效提醒返回 `202`，同一访客对同一游戏 24 小时内重复返回 `409`，访客在 10 分钟内超过 10 次请求返回 `429`。
- `GET /v1/admin/update-reminders`：需要 `Authorization: Bearer <UPDATE_REMINDER_ADMIN_TOKEN>`，只返回当前 pending 游戏及通知状态。
- `POST /v1/admin/update-reminders/:game/resolve`：鉴权后关闭当前 pending 周期但保留历史。
- `POST /v1/admin/update-reminders/:game/retry-notification`：鉴权后重置当前通知重试状态。

站点访问按匿名 visitor ID 的 30 分钟窗口去重。资源 detail 和直接下载共享同一个资源 view 去重键；下载另有 10 秒短窗口去重。过期的 `event_dedupe` 行在写入事件前按索引清理，数据库不记录 IP、UA、地理位置或页面轨迹。

更新提醒当前只接受 arcaea、phigros、rizline、infalsus、rotaeno、paradigm-reboot 六个公开 slug。有效提醒写入 update_reminders，并按游戏建立可解析的 pending cycle，保留首次/最近提醒时间、累计有效提醒数、resolved_at 和通知状态。首次有效提醒会触发一封 Resend 邮件；同一 pending cycle 后续提醒只累计，不重复发信。邮件发送失败不会影响访客收到的 202，429、5xx、网络错误和超时按 5/10/20/40/80 分钟有限退避，最多尝试 5 次；其他 4xx 记录为不可重试失败。站长可通过管理接口查询、resolve 或手动重试。

## 首次创建和部署

在仓库根目录运行：

```text
npx wrangler login
npx wrangler d1 create rhythm-archive-stats
```

将创建命令输出的 database ID 写入 `wrangler.toml` 的 `database_id`，再运行：

```text
npx wrangler d1 migrations apply rhythm-archive-stats --remote
npx wrangler deploy
```

部署后用返回的 `https://<worker>.<subdomain>.workers.dev` 地址作为站点构建环境的 `PUBLIC_STATS_API_URL`。不要把 D1 管理凭据放入站点或 Git。

## 本地开发

`wrangler.toml` 已明确允许 `https://rhythmarchive.github.io`、`http://localhost:4321` 和 `http://127.0.0.1:4321`，没有开放 `*`。本地 D1 迁移和 Worker：

```text
npx wrangler d1 migrations apply rhythm-archive-stats --local
npx wrangler dev
```

本地 Astro 使用 PUBLIC_STATS_API_URL=http://127.0.0.1:8787；没有配置该变量时，静态站点仍可正常构建，统计展示会保持隐藏。提醒入口还需要 Pages/构建环境显式设置 PUBLIC_UPDATE_REMINDERS_ENABLED=true。通知使用 Worker Secret RESEND_API_KEY 和 UPDATE_REMINDER_EMAIL_TO，固定从 Rhythm Archive <onboarding@resend.dev> 发出；管理接口使用单独的 UPDATE_REMINDER_ADMIN_TOKEN。Secret 只通过 Wrangler 配置，不写入仓库、前端或日志。
