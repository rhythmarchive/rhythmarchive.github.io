# 每日运营邮件与游戏版本监测

复用 Stats Worker、现有 D1、`*/5 * * * *` Cron 和 Resend。无前端改动、额外服务器或付费接口。日报默认收件人沿用 `RESOURCE_REPORT_EMAIL_TO`，其次 `UPDATE_REMINDER_EMAIL_TO`；可用 Secret `DAILY_REPORT_EMAIL_TO` 单独指定。发件人可用 `DAILY_REPORT_EMAIL_FROM`，否则沿用反馈发件人或现有 Resend 测试域。

## 时间与数据口径

- 北京时间 08:00 检测版本；08:30 为昨日生成报告。由 `ScheduledController.scheduledTime` 计算日期，统计范围为昨日北京时间 `[00:00, 次日00:00)`。每小时整点恢复未完成监测；08:30 后每15分钟检查待发报告。其他普通 Cron tick 不增加日报 SQL/请求。
- 检测是本次晨间相对上次成功读取的变化，不把检测时间当发布时间，也不宣称都发生于昨日。首次成功仅基线；失败不会覆盖旧基线。数字版本回退单列异常，保留原基准；同版本的日志或日期变化只列修订。Steam 新闻始终称公告，GID 不当版本号或构建号。
- 访问沿用30分钟匿名会话去重；资源浏览、下载沿用现有计数。累计和待更新状态是生成时快照；日报提供近8日序列、昨日/前日/上周同日对比、浏览与下载排行、有效提醒、站内表单反馈及客户端异常。缺失保留 null，不补零；下载/浏览比不是用户转化率。历史日表保留35日，反馈原表保留7日，不推测更早明细。
- 网站当前版本直接读取已发布 `data/game-index.json` 的 `contentVersion`、`lastUpdatedAt`、资源与分类数量，避免复制一套版本配置。排行名称仅按所需ID读取既有 `data/ranking/xx.json` 分片，不下载全量 Catalog。网站没有统一声明发行渠道，因此版本差异仅提示人工核查。
- 邮件包含人工可读纯文本及 `BEGIN_RHYTHM_ARCHIVE_REPORT_JSON` / `END_RHYTHM_ARCHIVE_REPORT_JSON` 包围的 schemaVersion=1 私密快照。固定主题 `[Rhythm Archive Daily] YYYY-MM-DD 每日运营报告`、Resend tag `category=daily-operations` 便于 Gmail 检索。反馈和外部日志均明确标为不可信数据，供 AI 归纳，不作为指令。没有向 GitHub Discussions/Giscus 取数。
- 运营分析同时保留资源规模、分类、热门需求、提醒/反馈积压及数据缺口；建议依据与假设分开。当前无访问来源、搜索词、地区或推广归因数据，不能声称某推广渠道有效，也不能把下载计数换算ROS账单。

## 来源配置与可靠性

在 `src/version-sources.ts` 声明固定身份和渠道；新增已支持的来源只添加配置行。新增解析器必须先验证真实公开数据结构，不执行页面脚本、不绕过登录/验证码。请求8秒超时、768KiB响应上限、最多4个并发、不即时重试；每日成功任务不会重复查询。616所有变体共享一次目录请求。当前35项来源共28个独立URL。

| 来源 | 游戏与渠道 | 读取方式与限制 |
| --- | --- | --- |
| Apple | 9款移动游戏的US iOS；范式另含CN iOS | 官方 iTunes Lookup，校验bundleId；包含版本、正式版本发布时间和日志。相对稳定，地区分别保存。 |
| TapTap | Berry Melody、Dynamix、Milthm、Orzmic、Phigros、Rizline、Rotaeno 的国内Android | 公开SSR页面Nuxt JSON引用表，校验包名并只取APK日志；无私有接口。网页结构可能变更；Dynamix旧页明显滞后。 |
| 好游快爆 | Phigros、范式：起源的快爆Android渠道 | 公开详情页的版本日志、日期；固定详情ID并校验标题，日期只有日粒度（北京时间零点表示，不能当精确发布时间）。先通过页面自身公开搜索请求确认详情地址。 |
| Steam | In Falsus，appid3971950 | 官方 `ISteamNews/GetNewsForApp/v2`，限制官方社区公告feed，10条窗口、按最新公告识别变化；不保证提供版本号，不把公告当发布。 |
| Google Play | Arcaea、Berry Melody、Dynamix、Milthm、范式国际、Rizline国际 | 官方公开应用页，仅接受明确的SoftwareApplication/softwareVersion，拒绝猜测私有数组字段；当前未验证可用版本输出，持续明确失败。 |
| 616.sb | Arcaea Google及C包、Berry Melody、Dynamix、Milthm、范式国际、Rizline国际/香港 | 其前端实际使用的公开 `api.616.sb/api/public/apps` 目录，核对包名与variant。第三方镜像不能单独确认官方更新，publishedAt只作收录时间；不下载安装包。 |
| 官网 | Milthm | 官方更新日志首个版本段，未提供发布日期则留null。仅支持内容层的跨渠道参考，不证明对应商店已发布。 |

未接入的游戏/平台和原因随邮件明确列出：TapTap国内韵律源点、TapTap范式缺少可验证APK记录；其他快爆详情、Google Play Phigros/Orzmic/Rotaeno及其他官网未核实。In Falsus不会查询移动商店。

交叉核实只比较相同游戏、相同发行渠道；同渠道的独立来源一致且至少有官方/发行页面时为`multi-source`；一条官方/发行页面为`single-source`；不同版本为`conflict`；失败或仅镜像为`unverified`。跨渠道相同版本供人工参考，不升级为同渠道确认。归一化只处理尾部`.0`，保留原始版本。分组展示相同版本的变化时保留每个平台原/新版本、时间、日志、来源和查询时间。

2026-10-27本机真实探测：35项中27成功、8失败；Apple10项、TapTap7项、快爆2项、616的8项成功；Google6项、Steam1项、官网1项失败。官网曾单独读取成功，本轮生产解析器探测失败，不能称稳定。实际交叉参考包括Phigros多个渠道4.0.1.2、Milthm6.0.5；Berry Melody为TapTap3.3.9 / iOS及镜像3.3.8；Dynamix为TapTap3.16.05 / iOS3.18.00 / Google镜像3.20.01。这里没有同渠道多来源确认的实测成功，不把跨渠道差异叫冲突或资源过期。生产网络结果可能不同，以D1每次记录为准。

只读复核：`node --import tsx workers/stats/scripts/probe-version-sources.ts`。输出每来源状态及短日志，不连接D1、不发信、不创建更新事件。

## ROS边界

真实生产者→契约→消费者：私有 Admin 现有雨云适配器→`RosReportSource.snapshot()`只读白名单RPC→Stats日报。复用现有Operator，不复制私有管理能力/凭据到Public；新增service binding `OPERATOR_ROS`，没有新增公共HTTP路由。Admin的 `RAINYUN_API_KEY` 仍为可选Secret；缺配置、API失败、超时独立显示不可用，不能拖垮邮件。

保留状态、套餐配置原值、周期、到期时间和已验证的字节/请求指标。2026-10-27已用真实雨云响应核实：列表/详情使用规范斜杠、列表必需`options={}`，响应为`ID/Status/Plan`及`data.Data`详情包装；实例监控使用官方控制台实际调用的`/product/ros/instance/:id/monitor?start_date=…&end_date=…`，时间为Unix秒，只查询最近一小时并取最新有效存储采样。`Plan.bandwidth`是套餐流量额度，不是网络速率。流量/请求计数只有UsageData更新时间有效时才采用，否则保留null；上游返回空值或更新时间为0，不当作零用量。样本时间与口径随definition进入邮件，不能据此推算账单。单次来源加载仍为1次列表、最多10次详情及10次实例监控，无额外轮询或D1写入。快照去除实例ID、桶ID、标签及账号信息。来源缓存5分钟，日报20秒等待上限；每天反馈当时状态。

## 幂等、失败与留存

- `version_monitor_runs`按北京时间日原子领取10分钟租约；有成功来源的每日完整检查只运行一次。全来源失败明确标记failed并退避6小时，旧版误标complete且没有任何成功检查的任务也允许自然恢复。成功状态、历史checks和changes在同一批事务写入，有owner guard避免过期任务覆盖新领取者。
- `daily_operations_reports`按报告日唯一，首次生成冻结快照、收件人、主题和邮件正文。并发Cron/人工操作原子领取5分钟租约，所有重试使用相同正文和 `rhythm-archive-daily-YYYY-MM-DD` Resend键。报告发送失败不影响现有提醒/反馈队列。
- 429、5xx、网络或响应不确定可15分钟后重试，每份报告最多3次；此外新增独立UTC日最多3次Resend调用额度，失败也计入。原提醒/反馈80次额度完全不变，正常最多83次/UTC日，仍需站长确认自己的Resend账户套餐可用额度。没有创建付费额度或更改订阅。
- Resend幂等键只保证24小时；本实现23小时后停止不确定重试并标`needs_review`，不能跨窗口盲目重放。发送成功记录不再发送。管理重试不重置尝试数、不突破每日额度。人工处理前应先在Resend核对是否已接受；错误收件人/主题修复不会改写已冻结正文。
- 08:15独立清理私密快照正文，超过7个北京时间日清空（同原反馈保留窗口），不受发送开关/Secret/失败控制。版本checks/changes保留90日、当前基线持续保存；日报日期/投递状态保留以防重复。只有原始日报正文保留期内（近6日）支持补发；停机期间从未生成的旧报告不自动伪造补齐，可手动生成仍在原始保留期的日期。
- 生产验证只建立真实基线、读取真实统计、发送真实前一日报告。不得写入伪造visit/download/feedback或模拟版本变化。

## 管理接口与部署

管理接口沿用 `UPDATE_REMINDER_ADMIN_TOKEN` Bearer认证，响应no-store，不返回收件Secret；无token时401。无公开反馈正文接口。

- `GET /v1/admin/operations`：近7日报告投递状态及监测任务状态，不返回反馈正文。
- `GET /v1/admin/operations/reports/YYYY-MM-DD`：只读实时预览，包含私密反馈；不写日报、不发信。
- `POST /v1/admin/operations/monitor`：为今天建真实基线/检测，完整任务不重复。
- `POST /v1/admin/operations/reports/YYYY-MM-DD/send`：生成并发送实际报告，已发送不重放。
- `POST /v1/admin/operations/reports/YYYY-MM-DD/verify`：带 UUID 格式的 `Idempotency-Key`，生成一封明确标注“手动核验”的新快照邮件。它复用原生产查询、RPC和Resend链路，同一个请求ID不重复发送。已有日报保持不变；核验记录复用现有出箱表，独立键为 `check:统计日期:请求UUID`，正文的 reportDate 仍是真实统计日期，管理列表附带 kind/source_date，不会占用未来日报日期。
- `POST /v1/admin/operations/reports/YYYY-MM-DD/retry`：仅在原23小时窗口及剩余尝试次数内恢复需要人工处理的报告，不重放已发送项。
- `POST /v1/admin/operations/reports/YYYY-MM-DD/rebuild`：只对首次明确400/401/403/422拒绝、无provider_id且23小时内的报告显式重新生成正文（例如修复发件域名后）。保留尝试数和UTC每日额度，新正文冻结并使用固定`-r1`幂等键；不允许重建已发送或投递不确定的报告。它本身不调用Resend，后续Cron领取发送。也可由维护者将符合相同条件的记录明确标记`rebuild_pending`，供Cron恢复；默认不会自动重建needs_review。重建中断的租约可恢复，过期/不符合条件记录会退回needs_review，不阻塞新报告。

2026-10-27生产兼容修复：workerd原生fetch拒绝`redirect: "error"`，Node测试此前未捕获。两端改为`manual`并将所有非2xx状态保留为失败，不跟随外部跳转。新增原生workerd业务测试覆盖版本来源、网站索引、ROS元数据及拒绝重定向；CI在需要Worker检查的范围先安装一次已有Worker开发依赖。Resend错误只持久化脱敏代码（例如`http_403:testing_recipient_restricted`），不保存可能带邮箱的原始错误正文。继续复用原Resend平台；向指定Gmail发信需配置已验证域名下的`DAILY_REPORT_EMAIL_FROM`，测试域限制见[Resend说明](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)。

先应用本批`0009_daily_operations.sql`迁移，再部署Admin命名RPC入口，最后部署Stats（配置已启用两项开关）。正常干净仓库使用Wrangler migrations apply；工作区若混有其他未授权迁移，只从隔离的migration目录应用本批，不顺带执行其他迁移。不要将远程迁移加入Pages构建。缺少Secret须由维护者在Worker Secrets配置，绝不写入代码或日志。

验证：Public `npm run ci:check`（含Worker测试、构建和站点回归）；Admin因增加RPC入口运行`npm run check`。独立测试覆盖真实SQLite迁移/时间边界/并发/预算/失败隔离/首次基线/回退/冻结payload/23h不确定发送截止及私有ROS白名单。

## D1与请求成本

现有网站请求和提醒提交路径新增SQL/第三方请求均为0；前端载荷无变化。监测每个完整日一次：1条领取+1条读取约35条当前状态+4条批事务（JSON集合写checks、changes、成功状态及完成任务），总6条SQL；最多35条check、35条state、变化项及1条run写入，约90日有界历史。非首次成功会更新当前state，但不虚构change。

日报首次生成12条只读查询：8日visit/资源聚合、累计资源统计、两类昨日排行、反馈/反馈计数/下载异常、提醒、监测任务/checks/changes；资源日统计只扫描8日范围，昨日排行各读当日行，累计只每日扫描一次resource_stats。报告新增1行；发送领取、独立预算、尝试与状态最多6条SQL及1次Resend。排行名称最多20个缓存分片请求、游戏索引1次、ROS RPC1次（现有适配器最多10实例的元数据/监控请求），无对象HEAD/下载/历史ROS遍历。

08:30后每15分钟恢复：已发送时仅已存在报告读取、终结过期任务、待发索引查询共3条SQL，不重新查询第三方。整点监测已完成时仅1条按主键领取检查。留存每天5条范围清理，不在网站热路径执行。没有新增D1每资源每次事件写入。

手动核验仅在明确请求后入箱，也可由已授权维护者通过D1插入符合该键格式、零尝试的verification_pending记录，现有Cron会领取生成；没有新增迁移、队列服务或空闲轮询。入箱1条INSERT，领取与冻结正文2条UPDATE，加既有报告查询和发送成本；没有任务时仍走原有空闲查询数。核验与日报合用UTC日最多3次的预算，不占用提醒/反馈80次额度。生成过程失败或超过23小时的未完成任务转needs_review；敏感正文按真实统计日期的7日窗口清理，独立的幂等账目继续保留。
