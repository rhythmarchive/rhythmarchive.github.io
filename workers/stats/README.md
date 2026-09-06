# Rhythm Archive stats Worker

这是站点统计的独立 Cloudflare Worker + D1 模块。Worker 不接收客户端的“加一”指令，只接受 `site_visit`、`resource_detail` 和 `resource_download` 事件，并由 D1 去重记录决定最终是否更新计数。

## API

- `GET /health`：健康检查，不访问 D1。
- `GET /v1/site/stats`：返回 `{ totalVisits, todayVisits, date }`。
- `POST /v1/events`：请求体为 `{ "type": "site_visit", "visitorId": "..." }`，或带 `resourceId` 的资源事件。`resourceId` 必须是 Catalog 的 UUID 形式稳定 ID。
- `POST /v1/resources/stats`：请求体为 `{ "resourceIds": ["...", "..."] }`，最多 100 个 ID；返回一组 `{ views, downloads }`，没有记录的资源返回 0。

站点访问按匿名 visitor ID 的 30 分钟窗口去重。资源 detail 和直接下载共享同一个资源 view 去重键；下载另有 10 秒短窗口去重。过期的 `event_dedupe` 行在写入事件前按索引清理，数据库不记录 IP、UA、地理位置或页面轨迹。

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

本地 Astro 使用 `PUBLIC_STATS_API_URL=http://127.0.0.1:8787`；没有配置该变量时，静态站点仍可正常构建，统计展示会保持隐藏。
