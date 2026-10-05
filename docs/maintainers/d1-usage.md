# D1 热路径与用量

本文解释 Stats Worker 的查询与缓存设计，供维护者分析用量。API 与本地开发见 [Worker README](../../workers/stats/README.md)，生产配置见[运维说明](stats-operations.md)。

## 限流与事件去重

每次公开业务请求先执行原生限流，再执行 D1 的接口窗口限流，随后才能读取榜单缓存或写入事件。原生拒绝不访问 D1；绑定或持久限流异常返回 503。D1 使用一条 `UPSERT ... RETURNING` 原子计数并返回窗口状态，不再跟随 SELECT 或逐请求清理。

事件用条件 UPSERT claim：只有已有键的 `expires_at <= now` 时才续建；重复事件不写入、不延长去重窗口。资源 view 为 30 分钟，download 为 10 秒，Cron 延迟不会延迟去重窗口恢复。Cron 负责物理清理；限流清理使用 `window_started_at <= now - 24h` 以利用已有索引。

有效 view/download 同时写入 `resource_stats` 和 `resource_daily_stats`。累计计数保留；日统计、event dedupe、限流桶和过期 reminder visitor 由 5 分钟 Cron 清理。

## 榜单缓存

`ranking-cache.ts` 使用 Workers Cache API 缓存 60 秒。键包含 host、registry hash、日期、period 和 limit；各 limit 独立缓存，保留 SQL LIMIT 后过滤公开 registry 的结果。缓存内部 `expiresAt` 控制 TTL，同 isolate 同键并发 miss 合并。

缓存只存 entries，不存客户端 CORS、429 或 503，浏览器响应仍为 `no-store`。错误不缓存，不返回过期数据；Cache API 故障回源 D1，D1 故障返回 503。统计写入立即生效，榜单展示最多滞后 60 秒；日期或 registry 变化不复用旧键。

## 查询预算与测量

以下为当前请求路径的 SQL 条数，包含 D1 限流，不包含后台邮件任务：

| 请求 | SQL 条数 |
| --- | ---: |
| 原生限流拒绝 | 0 |
| D1 限流拒绝 | 1 |
| 7d/all 榜单 miss | 2 |
| 7d/all 榜单 hit | 1 |

同键 60 秒内 20 次请求、1 次 miss 和 19 次 hit，共执行 21 条 SQL，其中榜单聚合执行一次。这是给定命中条件的示例，不是线上命中率或计费保证。缓存按 Cloudflare 地点独立，可能被驱逐；跨地点请求不保证共享结果。

SQL 条数与 D1 `rows_read` / `rows_written` 是不同指标。限流、claim 的主键读写仍有成本；聚合查询仍有日期索引扫描。实际用量应在相同时间窗、请求量和 registry 下比较生产 D1 元数据或 Query Insights，结合缓存命中与错误情况解释，不能套用旧截图的固定节省百分比。

## 回归覆盖

`npm run worker:check` 包含类型检查、业务测试和 [`d1-usage.test.ts`](../../workers/stats/tests/d1-usage.test.ts) 的 SQLite migrations 与 D1 适配器回归，覆盖：

- 去重到期边界、重复不续期、并发 claim、Cron 清理。
- 接口阈值、窗口重置、scope 隔离与异常失败关闭。
- 实际 SQL 数、索引查询计划与事件计数。
- 缓存 TTL、日期/period/limit 隔离、CORS、并发 miss 及故障回源。

本地 SQLite 验证语义和查询计划，不能证明生产 D1 的精确读写行数或缓存命中率。测试数量随代码变化，不以历史测试总数作为当前验证状态。
