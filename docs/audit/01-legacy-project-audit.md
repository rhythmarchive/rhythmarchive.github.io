# 旧项目只读审计

审计日期：2026-08-14  
审计对象：E:\rhythm-assets-gallery  
结论性质：以下是当前工作区源码、生成数据、Git 状态和实际文件的只读证据；不是对旧项目的修复建议，也没有运行会写入旧项目、远端或资源目录的脚本。

## 1. 范围与状态

已检查：

- 根目录、package.json、Astro 配置、src/、scripts/、automation/、docs/、public/ 中非大体积生成数据、.githooks/、AGENTS.md、Git 历史和状态。
- public/data/*.json、public/assets 的实际索引对应关系、public/downloads、.arcaea-apk-work、.phigros-apk-work、.deploy-work 的只读统计。
- 不存在 .github/ 目录；当前旧项目没有仓库内 GitHub Actions 证据。

旧仓库在本轮开始时已经不是 clean worktree：main 比 origin/main ahead 1，并有 6 个已有修改文件：scripts/check-arcaea-apk.ts、scripts/deploy.ps1、scripts/extract-arcaea-update.ts、scripts/generate-thumbnails.ts、scripts/stats-server.mjs、src/components/ArcaeaApkDownloadCard.tsx。本轮没有修改、暂存、提交或恢复它们。

## 2. 实际架构

旧项目不是只有一个静态 Astro 页面，而是以下组合：

    public/assets 或外部 ASSET_ROOT
            │
            ├─ scripts/scan-assets.ts
            │      └─ public/data/arcaea-index.json
            │         public/data/phigros-index.json
            │         public/data/summary.json
            │         public/data/recent-updates.json
            │         public/data/tags.json
            │
            ├─ scripts/generate-thumbnails.ts
            │      └─ public/thumbs/{320w,640w,1280w}/*.webp
            │         并回写 index/recent-updates 中的缩略图字段
            │
            ├─ scripts/generate-sitemap.ts
            ├─ scripts/generate-search-suggestions.ts
            └─ Astro build
                   ├─ 首页、Arcaea、Phigros、搜索页
                   └─ /asset/[id]/ 静态详情页

    本地/旧 VPS 辅助层：
    APK checker ── runtime APK + metadata ── stats-server.mjs ── Nginx /api/ 代理
    更新提取 ── 人工整理/超分 ── compress ── publish PowerShell ── SSH/SCP ── remote-build

astro.config.mjs 只有 React 与 Tailwind/Vite 集成，没有服务端渲染或数据库。真正的“后端”是 scripts/stats-server.mjs：旧设计下由 PM2 运行在 VPS 的 loopback 3001 端口，Nginx 代理 /api/。

## 3. 用户可见功能（以源码为准）

### 保留价值较高

1. 首页展示总量、游戏分布、最近更新、公告和外部站点入口。
2. Arcaea、Phigros 独立图库页；搜索页把两个索引合并搜索。
3. Fuse.js 单关键词模糊搜索；多个关键词改为全部命中式文本搜索。搜索字段包括标题、作者、文件名、分类、标签、曲包、版本、songId、idx、难度、角色和剧情字段。
4. 分类、曲包、侧别、版本筛选；最近、名称、分类排序；每页 40 张并“查看更多”。筛选状态会写回 query string。
5. 静态详情页：预览、原始文件下载、文件名、大小、尺寸、元数据、标签、关联资源、背景链接、Arcaea 原图/AI 超分切换。
6. 多选与浏览器端 ZIP：逐个 fetch 原图，在浏览器内存中构造 store-only ZIP，支持同名文件加后缀避免覆盖。
7. 缩略图、站点地图、SEO/Open Graph、静态部署。这些能力与 GitHub Pages + ROS 方向兼容，但索引和 URL 需要 V2 化。

### 仍有实际价值但需要重新实现

- Arcaea APK 最新版本检测与公开下载元数据。
- Arcaea/Phigros 更新候选提取、差分报告、人工审核前 staging。
- 资源预览、批量下载和最近更新的用户体验。
- 资源关系：同曲包、背景、角色、剧情、原图/AI rendition 的跳转。

### 主要属于旧 VPS 架构、V2 可废弃

- stats-server.mjs 的访客 IP 统计、VPS runtime 文件、PM2 管理和 Nginx /api/ 代理。
- deploy.ps1 的 SSH/SCP、远程 npm ci、远程扫描/缩略图生成、Baota/Nginx 原子切换。
- publish-arcaea-update.ps1、publish-phigros-update.ps1 的远端目录复制、旧目录移动到 backup、触发 remote-build。
- check-remote-arcaea-apk.ps1 的 SSH 进入远端 source 目录检查 APK。

安全 guard 的思想有价值，但其目标应从“禁止旧 VPS secret 进入 Git”扩展为“禁止 ROS/GitHub token、签名材料和本地运行时数据进入 Catalog/仓库”。

## 4. 真实数据模型

src/lib/types.ts 的 AssetItem 是“一个可下载文件”的平面模型，不是 Resource/Variant/Rendition 模型。字段大致分为：

| 领域 | 旧字段 |
|---|---|
| 主键与分类 | id、game、category、filename、relativePath、extension |
| 歌曲 | title、artist、version、songId、idx、bpm、side/sideLabel、bg/bgInverse |
| 难度 | difficulty、difficultyLabel、difficultyRating、difficultyRatings、bydVersion、etrVersion、chartDesigner、jacketDesigner |
| 曲包 | pack、packDisplayName、packDescription、packSection |
| 角色 | characterId、characterName、characterEnglishName、characterVariant、relatedCharacterIds/Names |
| 剧情 | storyNode、storyPathTitle、storyType、storyAct、relatedSongId/Title |
| 文件派生 | url、三个缩略图 URL、sizeBytes、width、height、mtimeMs、wikiUrl、tags |

### 游戏、分类和字段如何识别

- 游戏：scan-assets.ts 查看相对路径片段中是否含 arcaea/phigros；不是读取文件内容。
- 分类：按路径段和 APK 资源路径模式识别，例如 曲绘、曲绘（AI超分后）、曲包封面、char/1080、char/*_icon、char/*_mp、img/bg/1080、img/story、img/multiplayer/stickers 等。无法识别时退化为最近的有意义目录名。
- Arcaea 歌曲：文件名中的 IDX 是首要定位锚点，再从 scripts/data/arcaea-metadata.json 的 songsByIdx 补充 songId、标题、作者、版本、曲包、BPM、side、背景和难度。
- 曲包：packlist 的 ID/本地化名称；封面文件名支持 1080_select_、1080_small_、divider_ 等前缀。
- 角色：末尾数字与 _icon/_mp 变体交给角色 metadata；角色立绘、头像、LinkPlay 预览目前主要由路径类别区分。
- 剧情 CG：从文件名归一化键查 story node；story2/ordering 与 entries_* 提供 path、type、act、角色和 clear song 关系。img/story/VN resource 进入 剧情贴图 分支，但当前历史 seed 没有单独的 剧情贴图 类别证据。
- Phigros：通常从最后一个 “ - ” 拆标题/作者，并保留 Chronos Collapse - La Campanella 特例；真实索引中作者字段仍然很稀疏。

### ID、更新日期和稳定性

当前 ID 是：

    SHA-1(NFC-normalized relativePath).slice(0, 16)

当前 2,670 条索引记录没有 ID 冲突，且全部能由相对路径重新计算得到；这是“当前实现正确”的证据，不代表适合作为 V2 的语义主键。只要移动、改名、改变目录或类别，ID 就会变；同一内容的不同别名也会有不同 ID；原图与 AI 文件必然是两个 ID。

“最近更新”依据是扫描时读取的文件 mtimeMs，recent-updates.json 和 sitemap 都按它排序/生成 lastmod。它不是 APK 发布日期，也不是 metadata 生成日期；复制、批量改名或迁移会污染这个时间语义。

## 5. 旧实现与文档的差异

- 当前 package.json 的 update 实际执行 scan → thumbs → sitemap → suggestions；文档中的命令说明曾有不同版本，今后应以 package script 和运行日志为准。
- src/lib/types.ts 的 ArcaeaApkVersion 只声明版本、文件名、大小、抓取时间，但当前生成的 public/data/arcaea-apk.json 还含有原始 url 和本机 filePath。这是 schema 泄漏/漂移，不应直接迁移。
- AGENTS.md、README 和更新脚本仍把 public/assets 或 VPS /media/webpan/曲绘 当 source of truth；这与 V2 的 ROS 正式文件、GitHub Catalog 正式记录、E:\曲绘 只作 Legacy Seed 的目标冲突。
- extract-arcaea-update.ts 排除 _256 文件，但当前旧索引确实包含 asgore 等 _256 资源；不能把 extractor 的目标集合当作历史全量。

## 6. 初步判断

- 旧项目最值得迁移的是解析/索引字段、缩略图参数、Arcaea metadata 归一化、Arcaea 路径差分、静态搜索/详情/批量下载的产品语义。
- 最需要重写的是“以路径和文件名直接等于身份”的扫描契约、Phigros Addressables 差分、发布覆盖逻辑、APK 校验/保留策略和所有 VPS 部署代码。
- Resource/Variant/Rendition 不能直接由 AssetItem.id 推出；需要在 Catalog 中显式保存语义关系和 provenance。

