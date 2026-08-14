# Arcaea APK 自动化审计

审计对象：旧仓库 scripts/check-arcaea-apk.ts、scripts/check-remote-arcaea-apk.ps1、scripts/stats-server.mjs、src/components/ArcaeaApkDownloadCard.tsx、相关 README/docs 和实际 runtime/public 数据。没有执行 checker、remote wrapper、download 或部署。

## 1. 当前链路

    arcaea.lowiro.com/zh
      ↓ Playwright Chromium，等待官方 CDN 链接
    第一个匹配 arcaea-static.lowiro-cdn.net 的 anchor
      ↓
    .version 文本取得 version；失败时从 filename 正则取得
      ↓
    filename query 参数或 arcaea_<version>.apk
      ↓
    全量 fetch
      ├─ 写到 <filename>.part
      ├─ pipeline 完成后 rename 为正式文件
      └─ 异常时删除 .part
      ↓
    runtime arcaea-apk.json
      ├─ latest
      ├─ history
      ├─ lastChecked
      └─ downloadCount
      ↓
    stats-server.mjs
      ├─ /api/apk/arcaea/latest
      ├─ /api/download/arcaea/latest
      └─ /api/download/arcaea/<filename>，支持 GET/HEAD/Range
      ↓
    ArcaeaApkDownloadCard + 浏览器下载

默认本地运行路径是旧项目 .runtime/arcaea-apk；远端 wrapper 把它改到 /www/wwwroot/stats-data/arcaea-apk。旧站生成数据另有 public/data/arcaea-apk.json。

## 2. 当前如何找到官方 URL

当前实现不是读取一个固定 CDN API，而是：

1. 启动 headless Playwright Chromium。
2. 打开 https://arcaea.lowiro.com/zh，等待 domcontentloaded。
3. 等待 selector：a[href*='arcaea-static.lowiro-cdn.net']。
4. 取第一个符合 selector 的 anchor href。
5. 优先从 .version 元素读取版本，去掉“版本”前缀；如果失败，从 URL filename 用 arcaea[_-]数字.数字.数字[字母] 正则提取。
6. filename 从 URL query 的 filename 取得，否则按 arcaea_<version>.apk 推导。

Playwright 是否技术上不可替代：当前脚本确实依赖 Playwright，因此对“当前实现”是必要的；但源码没有证明官方页面不能用普通 HTTP、静态 HTML 或官方 API 读取。本轮没有对官方页面做在线替代方案实验，结论为 CONFIDENCE: MEDIUM。V2 checker 应先做低成本 HTTP/API 探测，再把 Playwright 作为受控 fallback，避免把浏览器安装和页面 DOM 变动绑定为唯一入口。

## 3. 版本、断点和保留策略

- 版本只按 history 中的 version 判断已缓存；同版本则不下载。
- 若目标文件已经存在，代码只读取 stat size 并跳过下载，不校验 Content-Length、ETag、SHA-256、APK 结构或签名。
- 下载是完整 fetch，没有 HEAD、Range、断点续传或自动重试。
- 只有 .part 在 pipeline 异常时被删除；进程被强制终止时残留 .part 由下一次 prune 删除。
- DEFAULT_KEEP_VERSIONS=2；帮助文本却写 Default: 3。远端 PowerShell wrapper 默认 Retention=3，并通过环境变量覆盖 checker。
- pruneHistoryFiles 会删除下载目录里不在保留 history 的文件和所有 .part。这是 write/delete 行为，本轮没有运行。
- history 按 version+filename 去重，切片保留最新 N 条；没有内容哈希历史。

实际旧工作区证据：

| 位置 | 只读结果 |
|---|---|
| E:\曲绘 | 0 个 APK |
| old public/downloads/arcaea | 1 个 1,847,391,612 B APK + 1 个同大小 URL 样式无扩展名文件 |
| old public/data/arcaea-apk.json | latest=6.14.12，history=1；生成对象含 source URL 和本机 filePath |
| old .arcaea-apk-work | 0 文件 |
| old .runtime | 当前不存在 |
| old .deploy-work | 22,480 文件、约 7.97 GB、含 1 个 APK；它是部署工作区，不应当作正式 APK 库 |

因此当前旧站“保留多少 APK”的源码意图是 checker 2 个、remote wrapper 默认 3 个；实际当前可见生成 history 只有 1 个，Legacy Seed 没有 APK。公开数据与私有 runtime 的边界也没有保持干净。

## 4. Range/HEAD 下载实现

stats-server.mjs 的下载路由：

- latest 路由从 metadata 解析最新 filename，再做安全文件名解析。
- named 路由只允许 history 中的 filename。
- 对 GET/HEAD 设置 Content-Length、Accept-Ranges、ETag（大小+mtime）、Last-Modified、Content-Disposition 和 no-buffering。
- 解析单一 byte Range，返回 206 与 Content-Range；无效 range 返回 416。
- HEAD 不打开 body stream；GET 用 fs.createReadStream，客户端断开时销毁 stream。
- 统计下载次数只在无 Range 的 GET 增加，说明旧 API 还承担业务计数。

可复用的是安全路径解析、HEAD/Range、缓存头和断开清理的细节；V2 不应继续把这些逻辑放进一台 VPS Node 进程。ROS/CDN 应优先直接处理大文件协议，Catalog 只提供 immutable objectKey 和 metadata。

## 5. 当前 metadata schema 问题

类型声明 ArcaeaApkVersion 只有 version、filename、sizeBytes、scrapedAt；实际 public/data/arcaea-apk.json 的 latest/history 还包含：

- 官方 source URL；
- 本机绝对 filePath；
- runtime 检查过程生成的字段。

这会把不应公开的本机路径写入 public 数据，也让“公共 metadata”和“checker 私有 metadata”混成同一格式。V2 应分成：

- Private check record：source URL、HTTP headers、ETag、下载尝试、临时路径、SHA-256、验证结果。
- Public latest metadata：version、filename/displayName、sizeBytes、sha256、objectKey、publishedAt、sourceReleaseAt（如果可证实）。
- Internal diff manifest：new APK objectKey、previous APK objectKey、extractor version、candidate report。

## 6. ROS + GitHub Actions 的建议流程（proposal，不实现）

    schedule
      ↓
    checker 读取官方 release/download source
      ↓
    runner 临时目录下载
      ├─ HTTP status / filename / version
      ├─ Content-Length 与实际长度
      ├─ SHA-256
      ├─ APK ZIP 可读性和 Arcaea 关键路径检查
      └─ 可选签名/证书/官方校验信息
      ↓
    upload internal/apk/arcaea/<version>/<sha256>.apk
      ↓
    ROS HEAD/GET range 验证 object size/hash/metadata
      ↓
    写入或更新 internal manifest
      ↓
    人工批准资源提取候选
      ↓
    Catalog/public metadata 指向 immutable 最新对象
      ↓
    GitHub Catalog commit → Pages deploy

图片 diff 需要“新版 + 上一版”同时存在，因此不要因为公开下载区只想保留最新版就删除 diff 输入。优先方案：

- public/apk/arcaea/latest 只作为当前公开指针或 Catalog 引用；
- internal/apk/arcaea/<version>/<sha256>.apk 至少保留 latest 与 previous 两个 immutable objects；
- 提取报告记录精确的 new/old objectKey；人工批准完成后仍保留与 Catalog provenance 绑定的 previous，或按 retention 保留最近若干版本；
- 若 previous 缺失，任务状态应为 blocked/needs-baseline，绝不能拿不确定的旧 APK 做 diff；
- public old APK 是否删除由后续生命周期规则处理，不由每次更新脚本顺手删除；
- 上传与 metadata 更新分为“对象已验证”和“公开指针已提交”两个阶段，避免 Catalog 指向未验证对象。

## 7. KEEP / ADAPT / REMOVE / REDESIGN

| 分类 | 文件/逻辑 | 结论 |
|---|---|---|
| KEEP | stats-server.mjs 的安全 filename、HEAD/Range、ETag/Last-Modified 思路 | 只保留实现经验，不保留 VPS 服务 |
| ADAPT | check-arcaea-apk.ts 官方页面定位、版本/filename 归一化 | 改成 checker + verifier + immutable artifact manifest |
| ADAPT | .part 与 rename 的临时下载思路 | 放在 runner staging，增加重试、断点/校验、磁盘配额 |
| REMOVE | check-remote-arcaea-apk.ps1 | SSH、远端 source/runtime 和旧部署环境 |
| REMOVE | public/downloads/旧 stats API 公开下载实现 | ROS/CDN 接管大文件分发 |
| REDESIGN | history 只按 version/filename、缺少 hash | 版本、hash、来源、验证状态四者分离 |
| REDESIGN | checker 与发布/提取共享同一可删除目录 | APK artifact、diff baseline、public pointer 分离 |
| REDESIGN | public metadata 泄漏 source URL/filePath | 私有记录与公开记录 schema 隔离 |

## 8. 尚未被源码解决的 APK Open Questions

- 官方页面是否存在稳定的非浏览器下载接口，以及 URL/filename/版本变更规则。
- 官方是否提供可验证的 SHA-256、签名或证书策略。
- ROS 是否支持对象版本、生命周期、multipart upload、HEAD metadata 和公开 Range/CORS。
- previous APK 的内部保留年限，以及删除前怎样保证历史 extractor 可重现。

