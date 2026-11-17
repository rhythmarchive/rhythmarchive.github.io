# Arcaea APK 自动发布

当前默认保持 GitHub-only：`ARCAEA_R2_ENABLED` 未配置或不是 `true` 时，CLI 不初始化、不检查、不读写 R2，也不要求 R2 凭据。小于 2 GiB 的新 APK 沿用 GitHub Release → ROS schema 2 清单；已发布的同版本直接退出。官网 APK 达到 2 GiB 时不会尝试 GitHub 上传，也不改写旧清单。若官方提供 Content-Length，会在读取 APK 正文前停止；否则流式计数达到限制即中止。GitHub 的限制无法通过关闭 R2 绕过，网站继续提供已有可用版本。

以下双平台流程只在后续明确设置仓库变量 `ARCAEA_R2_ENABLED=true` 后启用。本次发布不启用它。

APK 由 `.github/workflows/arcaea-apk-update.yml` 每半小时检查，也可手动运行。网站仍只读取一次 ROS 的 `apk/arcaea/latest.json`，不在构建时查询版本，不修改 Catalog、Browse 或资源更新提醒。APK 版本和网站资源版本是独立的；APK 上传不能提前清除资源更新提醒。

## 大小与发布顺序

原实现使用的是 `2 * 1024 * 1024 * 1024`（2 GiB，2,147,483,648 字节），不是十进制 2 GB。问题是下载、校验和 GitHub 上传共用这个上限。GitHub 要求每个 Release 文件**小于** 2 GiB。

现在下载安全上限独立为 4 GiB − 1 字节，超过即停止，不发布清单；轻量校验仍只支持 ZIP32，ZIP64 明确拒绝。下载写入单个 `.part`，成功后重命名；SHA-256、远端校验均流式读取，ZIP 中央目录限制为 32 MiB。官方下载总超时为 45 分钟，Actions 总超时 90 分钟，异常或结束清理本次下载目录。

1. 检查官方 API、CDN 白名单和版本，读取现有清单。已迁移的同版本直接退出，回退版本禁止发布。旧 schema 2 同版本允许重新下载并迁移到 R2。
2. 下载并校验 ZIP、AndroidManifest.xml、大小、SHA-256。
3. 启用 R2 后，所有新发布 APK 写入独立 R2 Bucket 的 `apk/arcaea/<version>/<sha256>/Arcaea_<version>.apk`。复用现有 AWS SDK Upload，64 MiB 分片、并发 3（约 192 MiB 分片缓冲），失败自动中止分片，不加载整包到内存。
4. 上传后 HEAD 核对大小，并 GET 流式重算完整 SHA-256；重试可复用验证通过的同路径对象，冲突对象拒绝覆盖。再 HEAD 公开域名，确认 HTTP 成功且 Content-Length 一致。
5. 小于 2 GiB 才创建/复用 GitHub Release，验证资产大小和 GitHub 的 SHA-256 digest。已有资产不匹配时停止，避免替换可用下载。达到 2 GiB 完全跳过 GitHub。
6. 所需平台全部验证成功后，最后一次 PUT 原有 ROS `latest.json`（schema 3），再读回核对。存储、校验或 GitHub 失败不会写新清单；已经成功上传的对象保留供重试。ROS PUT 响应不确定或读回失败应重跑检查，不能据此认定 PUT 未生效。上一版本的对象及 GitHub 资产不会删除。

新清单 `downloads.github` 可为 null，`downloads.r2` 为必需；保留 official 来源记录但不作为备用按钮。旧 schema 2 继续可读。小包显示「下载」「备用下载」，大包只显示「下载」。下载为直链，Worker 不读取 APK 内容。域名必须匹配构建时明确配置的 HTTPS 公共基址和版本/hash 路径，不能任意跳转。

## Cloudflare 设置（由维护者执行）

1. 在 Cloudflare Dashboard 开通 R2（若未开通，先完成账户要求的开通流程），创建专用 Standard Bucket，例如 `rhythm-archive-apk`；不要复用 ROS 或为此修改现有曲绘存储。
2. Bucket → Settings → Custom Domains，连接自己管理的域名，例如 `apk.your-domain.example`，等待 HTTPS 生效。生产下载使用自定义域名，不用有限流的 r2.dev 开发地址。
3. R2 → Manage R2 API Tokens，创建只对这个 Bucket 的 **Object Read & Write** 凭据。保存 Access Key ID、Secret Access Key 和账户 S3 endpoint。该凭据与现有 Cloudflare Worker 部署 Token 不同。
4. 若启用防盗链，在这个下载域名设置 WAF 规则：仅限制 `/apk/arcaea/`，允许本站 `https://rhythmarchive.github.io/` Referer；同时允许无 Referer（Actions HEAD、浏览器隐私设置和直接下载需要）。不信任无 Referer 的严格保护需要另行设计签名下载，不属于本次直链架构。不要使用要求浏览器交互的挑战阻断 HEAD 或 Range 下载。现有 ROS 防盗链不变。
5. 不需要浏览器 fetch APK，因此无需为 APK 开放 CORS。保留正常 GET/HEAD、Range 支持。对象由上传器设置 attachment、APK MIME 和一年 immutable 缓存。不要对版本路径设置负缓存或覆盖缓存内容。
6. 不配置历史 APK 自动过期；可设置未完成 multipart upload 在 7 天后中止的生命周期规则作为强制终止的兜底。持续关注 R2 存储用量及账单，历史清理需另行批准。更新器不做全桶扫描、不删除旧版本，也不会自动回填所有既有历史 GitHub APK。

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

复用现有 D1 表，无迁移。每次 APK 点击：一条去重 claim；有效点击再更新 resource_stats/resource_daily_stats 两行，不读回 APK 计数、不增加浏览量。现有 IP 限流读写照旧。总下载量仍用已有 SUM 和一分钟缓存，不轮询。页面展示不新增统计请求，只有用户点击才发送事件。

发布每次只操作本版本的对象：首次验证 HEAD（缺失则上传），multipart，上传后 HEAD + 一次全对象流式 GET，公开域名 HEAD，ROS 清单 GET/PUT/GET。复用对象需 HEAD + 全对象 GET。大文件校验增加 R2 读取请求及传输时间，但不占整包内存；不会触及 ROS 历史图片。

官方限制参考：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)、[R2 公开 Bucket](https://developers.cloudflare.com/r2/buckets/public-buckets/)。
