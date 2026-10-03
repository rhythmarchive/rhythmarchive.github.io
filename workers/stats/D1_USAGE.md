# D1 用量优化与验证

本次依据 Workspace `reports/20261003-rhythm-archive-stats-d1-usage-investigation.md` 修复 Worker 热路径。保留 API 格式、统计计数、排序、limit、公开 registry、CORS、限流 scope/阈值和错误状态。不改前端、Admin、数据库 schema、绑定或 Cron 频率。

## 实现边界

- `ranking-cache.ts` 用现有 `caches.default` 存储 60 秒榜单数据。缓存键按 host、registry hash、日期、period、limit 隔离；不把 50 项榜单切片为各 limit，以保留 SQL LIMIT 后过滤公开 registry 的现有结果。缓存内部记录 expiresAt，在日期边界或 TTL 到期时回源。同 isolate 同键并发 miss 合并；错误不缓存，不返回过期数据。
- 每次请求先执行原生限流和 D1 限流，随后才查榜单缓存。缓存不含客户端 CORS、429 或 503；浏览器响应仍是 no-store。缓存 API 不可用时查询 D1，D1 限流故障/缺失状态仍 fail closed。计数与统计写入立即生效，榜单展示最多滞后 60 秒。
- 请求限流删除逐请求清理 SQL，只保留原有 UPSERT/SELECT。Cron 用 `window_started_at <= now - 24h`，利用已有索引。
- 事件不再逐请求清理全表。claim 的 `ON CONFLICT ... DO UPDATE ... WHERE expires_at <= now` 原子续建已过期键；未过期键不写、不续期。因此无需等下次 Cron，去重仍严格为 30 分钟或 10 秒。Cron 保留物理清理职责。

## SQL 数量对比

以下包括 D1 请求限流，但不含提醒后台发送任务。去重命中不省略限流。

| 请求/行为 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 原生限流拒绝 | 0 | 0 |
| D1 限流拒绝 | 3 | 2 |
| 7d/all 榜单 | 4 | miss 3 / hit 2 |
| 资源统计（最多100个ID） | 4 | 3 |
| 站点统计 GET | 5 | 4 |
| site_visit 计入 / 去重 | 9 / 7 | 7 / 5 |
| resource_detail 计入 / 去重 | 8 / 6 | 6 / 4 |
| download 已有view、本次新下载 | 9 | 7 |
| download 同时新view/新下载 | 11 | 9 |
| download 两个claim都去重 | 7 | 5 |
| 首页首次计入site_visit + 7d榜 | 13 | miss 10 / hit 9 |
| 首页site_visit去重 + 7d榜 | 11 | miss 8 / hit 7 |
| 新详情（site_visit已去重） | 15 | 11 |
| 上一行详情存在相关卡片统计批次 | 再加4 | 再加3 |
| Cron清理每轮 | 5 | 5（限流清理改为索引范围） |

## rows_read 预估

从调查截图得到每次限流清理约 R=314、事件清理约 E=1.49、7d聚合约 L=8,150 行读；它们不是本轮线上基准，截图时间窗彼此也不一致。P 表示实际 D1 对主键/索引的少量读行，应在部署后用 meta/Insights 量化。新 claim 读取一个主键上的 expires_at，按 O(1) 考虑，不能把它的读写成本假定为零。

| 请求 | 修改前估算 | 修改后估算 |
| --- | --- | --- |
| 7d榜单 | R + L + P ≈8,464+P | miss L+P；hit P |
| all榜单 | R + 约5,536 + P | miss约5,536+P；hit P |
| site/detail/download事件 | R + E + P | P（含原子claim的主键读） |
| 资源统计批次 | R + 按ID查找成本 + P | 按ID查找成本 + P |
| 首页site_visit + 7d榜单 | 2R+E+L+P ≈8,779+P | miss L+P；hit P |

例如同地点/同键在60秒内20次榜单请求且命中19次：聚合读行从约163,000降至约8,150（约95%减少），该接口SQL从80条降为41条；每请求的2条D1限流SQL继续保留。Cache API按地点缓存，可被驱逐，不提供全球唯一执行或固定线上节省比例保证。[Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)。

## 本地验证

`npm run worker:check` 覆盖类型检查、原有业务/限流测试，以及 `tests/d1-usage.test.ts` 的实际 SQLite migrations + D1适配器回归：

- 无Cron下去重到期前/准确边界、view/download共享键、重复不续期、并发claim只计一次；Cron清理旧键。
- 四个scope的真实D1阈值与窗口重置、scope隔离；缺失/失败状态503。
- 实际接口SQL数、新旧事件计数；缓存命中仍限流/鉴别Origin。
- 60秒TTL、日期/period/limit隔离、CORS不污染、更新后的榜单到期刷新；并发miss合并；缓存读写/内容故障回源、D1错误不缓存。
- SQLite查询计划断言：旧限流DELETE=`SCAN`；新Cron DELETE=`SEARCH ... USING INDEX request_rate_limits_window_idx`；主键查询=`SEARCH`；7d聚合仍使用日期覆盖索引，聚合本身未改。

本地内存 SQLite 不能提供Cloudflare精确meta.rows_read/rows_written，也不能证明生产命中率；线上用量改善须在实际部署后比较同窗Insights。本次仅本地实现和验证，未push或部署。

2026-10-03 本地结果：Worker 类型检查通过，41/41 测试通过。额外将实际入口打包后在本地 workerd/Miniflare 中初始化 D1，确认首次榜单计算后修改本地日计数，原键命中仍返回缓存数据，另一 limit 键读取新计数；两次不同 Origin 的 CORS 正确，三次榜单请求的持久限流计数为3。该运行时检查只操作本地临时数据库，任务脚本和日志在完成后清理。
