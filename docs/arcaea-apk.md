# Arcaea APK 自动发布

当前默认保持 GitHub-only：`ARCAEA_R2_ENABLED` 未配置或不是 `true` 时，CLI 不初始化、不检查、不读写 R2，也不要求 R2 凭据。小于 2 GiB 的新 APK 沿用 GitHub Release → ROS schema 2 清单；已发布的同版本直接退出。官网 APK 达到 2 GiB 时不会尝试 GitHub 上传，也不改写旧清单。若官方提供 Content-Length，会在读取 APK 正文前停止；否则流式计数达到限制即中止。GitHub 的限制无法通过关闭 R2 绕过，网站继续提供已有可用版本。

以下双平台流程只在后续明确设置仓库变量 `ARCAEA_R2_ENABLED=true` 后启用。本次发布不启用它。

APK 由 `.github/workflows/arcaea-apk-update.yml` 在启用 R2 后每日检查一次，也可手动运行。网站仍只读取一次 ROS 的 `apk/arcaea/latest.json`，不在构建时查询版本，不修改 Catalog、Browse 或资源更新提醒。APK 版本和网站资源版本是独立的；APK 上传不能提前清除资源更新提醒。

## 大小与发布顺序

原实现使用的是 `2 * 1024 * 1024 * 1024`（2 GiB，2,147,483,648 字节），不是十进制 2 GB。问题是下载、校验和 GitHub 上传共用这个上限。GitHub 要求每个 Release 文件**小于** 2 GiB。

现在下载安全上限独立为 4 GiB − 1 字节，超过即停止，不发布清单；轻量校验仍只支持 ZIP32，ZIP64 明确拒绝。下载写入单个 `.part`，成功后重命名；SHA-256、远端校验均流式读取，ZIP 中央目录限制为 32 MiB。官方下载总超时为 45 分钟，Actions 总超时 90 分钟，异常或结束清理本次下载目录。

1. 检查官方 API、CDN 白名单和版本，读取现有清单。已迁移的同版本直接退出，回退版本禁止发布。旧 schema 2 同版本允许重新下载并迁移到 R2。
2. 下载并校验 ZIP、AndroidManifest.xml、大小、SHA-256。
3. 启用 R2 后，所有新发布 APK 写入独立 R2 Bucket 的 `apk/arcaea/<version>/<sha256>/Arcaea_<version>.apk`。复用现有 AWS SDK Upload，64 MiB 分片、并发 3（约 192 MiB 分片缓冲），失败自动中止分片，不加载整包到内存。
4. 上传后 HEAD 核对大小，并 GET 流式重算完整 SHA-256；重试可复用验证通过的同路径对象，冲突对象拒绝覆盖。再 HEAD 公开域名，确认 HTTP 成功且 Content-Length 一致。
5. 小于 2 GiB 才创建/复用 GitHub Release，验证资产大小和 GitHub 的 SHA-256 digest。已有资产不匹配时停止，避免替换可用下载。达到 2 GiB 完全跳过 GitHub。
6. 所需平台全部验证成功后，最后一次 PUT 原有 ROS `latest.json`（schema 3），再读回核对。存储、校验或 GitHub 失败不会写新清单；已经成功上传的对象保留供重试。ROS PUT 响应不确定或读回失败应重跑检查，不能据此认定 PUT 未生效。上一版本的对象及 GitHub 资产不会删除。

新清单 `downloads.github` 可为 null，`downloads.r2` 为必需；保留 official 来源记录但不作为备用按钮。旧 schema 2 继续可读。小包显示「下载」「备用下载」，大包只显示「下载」。优先下载经私有桶网关流式传输的 R2 副本；保留已有 GitHub 地址。域名必须匹配构建时明确配置的 HTTPS 公共基址和版本/hash 路径，不能任意跳转。

## Cloudflare 设置

复用私有 `rhythm-archive`（Standard，APAC）。禁用 `r2.dev`，不要给桶绑定自定义域名。`dl.rhythmarchive.top` 只允许绑定下载 Worker。核实 Workers Free 与账户级 R2 余量后才开放路由并分配 UTC 月读取预算；无预算时拒绝读取。ROS 自动回退另需经核实的 UTC 日字节预算；未配置时只提供手动备用入口。两张表都不自动充值。读取预约不是平台实际传输量，告警也不是账单封顶。

桶级 Object Read & Write S3 密钥仅交给上传流程，不能与 Worker 部署令牌混用。仅允许一个正式 APK 写入任务同时运行；资源同步和 APK 初次迁移不要并发。上传检查待完成分片、完整对象占用及新文件大小，超预算停止，不自动删除旧版。新增资源使用私有工具 `ros:delta -- --r2`，先 dry-run，再 `--apply`；只发布完成读回校验的内容寻址索引。若桶级以外还有用量，请先调低上传预算。

## GitHub 设置（由维护者执行）

仓库 Settings → Secrets and variables → Actions，配置**仓库级**变量：

| Variable | 值 |
| --- | --- |
| `ARCAEA_R2_ENABLED` | 当前保持未配置或 `false`；未来配置完成并让新版网站上线后才设 `true` |
| `ARCAEA_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `ARCAEA_R2_BUCKET` | 专用 Bucket 名 |
| `PUBLIC_ARCAEA_R2_BASE_URL` | HTTPS 下载域名，无末尾斜杠；公开配置，自动更新和 Pages 构建必须一致 |

配置仓库级 Secrets `ARCAEA_R2_ACCESS_KEY_ID`、`ARCAEA_R2_SECRET_ACCESS_KEY`。保留现有 `ROS_*` Secrets（只发布 JSON）和 Actions `GITHUB_TOKEN` 的 contents:write 权限。Pages 的 stats-production 环境中若存在同名 PUBLIC 变量，必须保持相同值，避免环境覆盖仓库配置。

本地凭据仅可放 Workspace 已忽略的 `config/.dev.vars`，不要提交。CLI 使用 `ARCAEA_R2_PUBLIC_BASE_URL`，其值与 GitHub 的 PUBLIC 变量相同。本地网站使用 `PUBLIC_ARCAEA_R2_BASE_URL`。

## 发布及重跑 7.3.0c

先审核并按正常流程发布本地代码，让 Stats Worker 的 `apk_download` 事件和 Pages 的 schema 3 解析器先上线，再启动 APK 更新，避免旧页面遇到新清单。此轮仅本地开发，不包含该部署。

仅 GitHub 模式无需上述 R2 配置，可以直接沿用现有自动任务。启用 R2 时，应在网站上线后最后设置 `ARCAEA_R2_ENABLED=true`。

配置完成后：Actions → **Arcaea APK update** → Run workflow → 选择包含本次修改的 main → mode=`check-only`，确认当前官方版本；然后以 mode=`publish` 运行。它会自动决定 GitHub/R2，无需手动选择。若官方仍返回 7.3.0c，本次就发布 7.3.0c；如果官方已升级，发布官方当前版本。工具刻意不提供任意历史 URL/version 覆盖入口。任务失败修复配置后重新运行即可，未完成发布不会推进清单，已经验证的同版本 R2/GitHub 文件可复用。

## 统计和请求成本

现有 APK 按钮此前没有统计。两个新入口在点击时各发送一次现有 `/v1/events`，固定 `apk_download` 事件映射到保留的 APK 计数 ID；不使用 Catalog 资源、不增加 registry 项、不污染图片排行。沿用 Origin 白名单、body 限制、访客校验、IP 限流和同访客 10 秒下载去重。统计表示下载发起，不能证明保存完成；离开本站、统计请求失败或拦截不阻止下载，也不会重试产生重复。

来源统计使用增量迁移 0010；无来源的旧事件仍可接收。每次 APK 点击：一条去重 claim；有效点击再更新 resource_stats/resource_daily_stats 两行，有来源时额外更新一行按日来源聚合，不读回 APK 计数、不增加浏览量。现有 IP 限流读写照旧。总下载量仍用已有 SUM 和一分钟缓存，不轮询。页面展示不新增统计请求，只有用户点击才发送事件。

发布每次只操作本版本的对象：首次验证 HEAD（缺失则上传），multipart，上传后 HEAD + 一次全对象流式 GET，公开域名 HEAD，ROS 清单 GET/PUT/GET。复用对象需 HEAD + 全对象 GET。大文件校验增加 R2 读取请求及传输时间，但不占整包内存；不会触及 ROS 历史图片。

官方限制参考：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)、[R2 公开 Bucket](https://developers.cloudflare.com/r2/buckets/public-buckets/)。
