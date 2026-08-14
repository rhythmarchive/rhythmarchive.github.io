# V2 架构发现与边界建议

本文件是基于 Phase 1 证据的 proposal，不是最终 schema，也没有实现网站、Admin、ROS 上传或 GitHub workflow。

## 1. 已确认的架构事实

1. 旧站是 Astro 静态前端 + build-time JSON index + Sharp thumbnails；后端只有旧 VPS stats/APK Node service。
2. 旧站 public/assets 与两个 index 100% 对齐，但它只是已发布快照；E:\曲绘 更大，且含 6.16.0 增量、贴纸和 Phigros 未发布/改名内容。
3. Legacy Seed 2,803 张图片中有 19 组精确重复 hash，不能用路径或 basename 推断唯一内容。
4. Arcaea 616 对 original/AI 可完全配对，但同一 songId 可能有多个真实视觉变体。
5. 当前 ID 是 relativePath hash，不适合作为 V2 语义 ID。
6. 当前更新时间实际是文件 mtime，不是游戏版本发布时间。
7. Phigros metadata 很稀疏，当前 extractor 只发现新增 bundle，不足以保证更新完整。
8. APK checker 已经有“官方链接 → runtime → public download”的概念，但未做 cryptographic artifact verification，且 public metadata 有本机路径/source URL 漂移。

## 2. ROS 与 GitHub Catalog 边界

用户提出的边界整体合理：

| GitHub | Rainyun ROS |
|---|---|
| V2 代码、schema、Catalog | original 图片 |
| Catalog 与关系数据 | AI upscaled 图片 |
| search index 源数据/生成逻辑 | thumbnail |
| APK public metadata | APK |
| workflow、非敏感配置 | 必要二进制资源 |
| migration/review schema | internal diff APK（建议 private/internal prefix） |

建议 GitHub Catalog 不保存大文件，也不把完整内部 APK diff baseline 复制进仓库。Catalog 可以保存 sha256、尺寸、对象 key、来源版本和审核状态。

## 3. Object key 建议

不最终拍板，但基于当前重复/覆盖风险，优先考虑 immutable content-addressed key：

    objects/<sha256>/<normalized-extension>

或：

    assets/<game>/<sha256>.<ext>

缩略图则由源 hash、尺寸和格式组成，例如：

    thumbs/<source-sha256>/<width>w.webp

理由：

- 同 key 不覆盖，天然避免浏览器长期缓存命中旧内容。
- 同内容不同路径可以复用对象，但 Catalog 仍保留 alias/provenance。
- 内容变化生成新 hash/key，旧 object 可以延迟 GC。
- 可由 Catalog 通过 objectKey + sha256 + size 验证，而不是依赖 URL 文件名。

如果希望按业务路径浏览，可把 game/resourceType 只放在 Catalog，不把可变标题、版本或本地路径作为唯一 object key。objectKey 与页面 URL 必须解耦。

## 4. 删除、替换和缓存

建议采用两阶段：

1. Catalog 中先移除引用或标记 tombstone，生成 PublishPlan。
2. 等一个 retention window，确认无 Catalog 引用、无未完成 review/rollback，再由受控 GC 删除 unreferenced objects。

Admin 的“删除”不能直接执行 ROS delete。对象替换应上传新 hash key、验证成功、提交 Catalog，再决定旧对象是否进入 GC。公开响应使用 immutable cache；latest APK 可以是 Catalog 指针而不是可覆盖的长缓存文件。若必须提供 latest URL，至少让响应 metadata/no-cache 与内部 immutable target 分离。

## 5. 稳定 Resource ID

建议区分三种身份：

- Internal stable ID：V2 自己生成，页面 URL 使用它。
- External identity：Arcaea songId、characterId、Phigros key 等，可能为空或有版本语义。
- Object identity：sha256/objectKey，代表具体文件 bytes。

Arcaea 可优先使用：

    arcaea:song:<songId>:jacket:<variant-key>
    arcaea:character:<characterId>:<assetRole>:<variant-key>
    arcaea:story:<story-path>:<node>:<assetRole>

但 songId 不能单独当 Resource ID，因为当前数据存在 55 个非空 songId 的多文件情况。variant-key 需要包含独立难度后缀、APK source path、事件/版本标识或人工 canonical key。

无官方 ID 的资源不应只使用标题。可以由规范化 identity tuple 生成 sha256/UUID，例如：

    namespace + game + resourceType + normalized title + normalized artist + source identity

同时保留原始 sourcePath 和人工 override。对于没有可靠语义的孤立图片，先生成 review-scoped candidate ID，不要过早承诺永久 Resource ID。

## 6. Catalog 建模草案

非最终 schema，可先验证下列关系：

    Resource
      - id
      - game
      - resourceType
      - title/artist
      - externalIds
      - pack/character/story relations
      - review/provenance summary

    Variant
      - id
      - resourceId
      - variantKey
      - difficulty/event/source markers
      - canonicalHash or semantic note

    Rendition
      - id
      - variantId
      - renditionType: original | ai-upscaled | compressed | thumbnail
      - objectKey
      - sha256
      - mime/size/width/height
      - sourcePath/sourceApk/sourceVersion
      - createdAt/approvedAt

    Alias/Provenance
      - sourceRoot/sourcePath
      - observedAt/mtime
      - mapping evidence
      - review decision

这样可以表达原图/AI，而不会把 曲绘（AI超分后） 变成另一首歌；也可以表达 BYD/特殊难度，而不会把它们误合并到同一个文件。

## 7. 静态站边界

Astro/GitHub Pages 只负责：

- 从 GitHub Catalog 构建页面、搜索索引、sitemap、结构化 metadata。
- 以 Catalog 的 objectKey 生成 ROS URL。
- 页面 URL 使用 Resource/Variant 的稳定 ID。
- 原图/AI/缩略图使用 objectKey；不把本地路径暴露给浏览器。
- 批量 ZIP 可以先保留浏览器方案，但要评估大文件、失败重试、CORS、内存和同名路径问题；长期可考虑由 ROS/CDN 或本地 Admin 生成离线包，不新增公网后端。

## 8. GitHub Actions 边界

Actions 适合：

- 定时检查官方 Arcaea APK。
- 下载到 runner 临时目录，验证 hash/结构，上传 ROS internal object。
- 读取 latest/previous baseline，运行 extractor，发布候选 report/artifact。
- 在人工批准后生成 Catalog commit 或 PR，并触发 Pages。

Actions 不应绕过人工审核直接发布新图片。secret 应用 GitHub Environment/short-lived credentials；workflow 日志不得打印 source URL token、ROS secret、本地路径或完整内部对象列表。

## 9. V2 的验证不变量

在实现前应先固化这些不变量：

- Resource/Variant/Rendition 每个外键都可解析。
- 一个 Rendition 只有一个 immutable objectKey，sha256/size/mime 可验证。
- 同一 Variant 的 original/AI 关系明确，不用文件夹名推测。
- 同 hash 不同路径有 alias/provenance 记录。
- songId/characterId 是外部身份，不是全局主键。
- Catalog 不含本机绝对路径、私有 source URL、secret 或临时目录。
- 公共 metadata 不指向未验证 object。
- 任何删除先有 dry-run、引用检查、retention 和可回滚记录。
- APK diff 的 old/new object 都可追溯到已验证 hash。

