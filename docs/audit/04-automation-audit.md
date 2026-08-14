# 旧自动化与调用关系审计

## 1. 实际 Arcaea 更新流

当前源码能还原出以下流程：

    官方页面
      ↓
    check-arcaea-apk.ts
      ├─ Playwright 打开 arcaea.lowiro.com/zh
      ├─ 找第一个 arcaea-static.lowiro-cdn.net 下载链接
      ├─ 从 .version 或文件名取得 version/filename
      ├─ 全量 fetch 到 runtime/*.part，再 rename
      ├─ 写 latest/history metadata，并按 retention 删除旧文件
      ↓
    人工指定 new.apk + old.apk
      ↓
    extract-arcaea-update.ts
      ├─ APK 用 tar 选择性抽取目标图片和 metadata
      ├─ 目录按相对路径收集 SHA-1
      ├─ 新文件/相同路径内容变化进入候选
      ├─ LinkPlay stickers 作为完整 snapshot
      ├─ 用 songlist/packlist/characters 生成可读文件名
      └─ 输出分类目录、_metadata、arcaea-update-report.json
      ↓
    人工审核、改名、确认候选、人工 AI 超分
      ↓
    compress-arcaea-update.ts
      ├─ 查找 *_optimization 图片
      ├─ Sharp 白底、sRGB、JPEG 95、4:4:4
      ├─ 输出 *_opt.jpg
      └─ 默认删除 optimization 输入
      ↓
    publish-arcaea-update.ps1
      ├─ 找最高版本本地目录
      ├─ SSH 读取旧远程 Arcaea 目录
      ├─ 新目录不存在时复制上一版作为基底
      ├─ SCP 上传分类目录
      ├─ 默认移动旧远程目录到 backup
      └─ 默认调用 deploy.ps1 -Mode remote-build
      ↓
    VPS remote-build
      ├─ 上传源码 archive
      ├─ 远端 ASSET_ROOT 指向远程曲绘
      ├─ 远端 npm run update
      ├─ 远端 npm run build
      └─ Nginx/Baota 原子切换 dist，并依赖 alias 提供 /assets/
      ↓
    旧站 public/data + public/thumbs + public/assets/路径

关键限制：extract 只对“相同相对路径”的 hash 做变化判断；如果 APK 内路径改名、资源被重新组织或只在旧 bundle 中内容变化，不会自动得到语义级 changed resource。它也排除 songs/.../1080_base 中的 _256 文件，但历史索引有 _256。

## 2. 实际 Phigros 更新流

    本地 Phigros_*.apk
      ↓
    extract-phigros-update.py
      ├─ 按数字版本选最高 APK 和前一个 APK
      ├─ 读取 assets/aa/catalog.json
      ├─ 解码 m_KeyDataString，比较 Addressables keys
      ├─ 比较 assets/aa/Android/*.bundle 文件名集合
      ├─ 只抽取新增 bundle，不处理既有 bundle 内容变化
      ├─ UnityPy 读取 Texture2D
      ├─ Illustration 且尺寸 >= 1000x500 → 曲绘
      ├─ 尺寸 <= 200x200 → 头像
      ├─ 从 Addressables key 推断标题/作者，失败时用 texture/bundle 名
      └─ 输出版本目录、曲绘/头像、phigros-update-report.json
      ↓
    人工核对、改名、整理
      ↓
    publish-phigros-update.ps1
      ├─ 按版本目录选最高版本
      ├─ 只上传 曲绘 和 头像 目录
      ├─ 远端缺目录时复制旧 Phigros 目录作为基底
      ├─ 默认移动旧目录到 asset-backups
      └─ 默认调用 remote-build
      ↓
    旧站索引/缩略图/静态发布

Phigros README 明确把当前脚本定位为基础自动化，并承认它会漏掉同名但内容变化的旧 bundle。这个限制不是文档细节，而是 V2 更新审核的核心风险。

## 3. 隐式调用关系

| 上游 | 下游 | 隐式契约 |
|---|---|---|
| package.json update | scan-assets → generate-thumbnails → generate-sitemap → generate-search-suggestions | 后续步骤依赖前一步写出的 public/data |
| update-arcaea-metadata.ts | scan-assets.ts | scan 从 scripts/data/arcaea-metadata.json 读取 songs、packs、characters、storyNodes |
| scan-assets.ts | Astro pages | 页面在 build 时读取 public/data 两个索引 |
| generate-thumbnails.ts | index/recent-updates | 缩略图 URL 和 mtime query string 会回写索引 |
| generate-search-suggestions.ts | 搜索辅助数据 | 读取 Arcaea metadata 和 Phigros index，来源可能不同步 |
| asset/[id].astro | filename/category/bg/pack/songId | 详情关系依赖归一化文件名、pack、songId、bg，不是独立关系表 |
| arcaea:extract | 人工超分/compress | 输出目录和文件名是后续手工流程的输入 |
| arcaea:publish | deploy.ps1 | publish 末尾默认触发 remote-build |
| check-apk:remote | check-arcaea-apk.ts | wrapper 通过 SSH 设置 runtime env 并在远端 source 目录执行 npm script |
| stats-server.mjs | ArcaeaApkDownloadCard/VisitorStats | 前端依赖旧 VPS 的 /api/ 端点、CORS、Range 下载 |
| .githooks/pre-commit | check-sensitive-staged.mjs | prepare/install-git-hooks 设置 core.hooksPath |

## 4. 脚本复用分类

### KEEP：可保留的算法/产品语义

| 文件 | 可保留内容 | 边界 |
|---|---|---|
| src/components/GalleryGrid.tsx | 搜索字段、AND 关键词、筛选和排序产品语义 | V2 Catalog 不再假设平面 AssetItem；客户端大索引需重新评估 |
| src/pages/asset/[id].astro | 详情页需要展示的关系类型、原图/AI 切换 | 关系必须从 Catalog 显式读取 |
| src/lib/client-zip.ts | 浏览器端打包的基本语义、重名处理 | 需要处理大文件/失败重试/流式方案 |
| scripts/update-arcaea-metadata.ts | 从 APK 资源读 songlist/packlist/character/story 的提取思路 | 输入输出路径、版本 provenance 需要 V2 化 |
| scripts/generate-thumbnails.ts | Sharp 尺寸、质量、增量跳过思路 | 输出改成 ROS 派生对象或独立发布 job |

### ADAPT：逻辑有价值，但必须改接口

| 文件 | 为什么不能原样迁移 |
|---|---|
| scripts/scan-assets.ts | 游戏/类别由目录猜测，ID 由 relativePath 生成，写死 public/data；应改为 manifest + provenance + 显式审核结果 |
| scripts/extract-arcaea-update.ts | SHA-1 相对路径 diff 有用，但不处理资源重命名/删除/语义变化，且写入旧目录 |
| scripts/extract-phigros-update.py | catalog/key 解码、UnityPy Texture2D 导出有价值，但输出命名和 bundle 选择要重做 |
| scripts/compress-arcaea-update.ts | 图像转 JPEG 的参数可复用；默认删除输入不适合 staging，版本正则还有 bug |
| scripts/import-incoming-assets.ts | 仅生成 incoming-import-plan.json 的 dry-run 框架可作候选导入入口，但没有审核决策/映射 |
| scripts/validate-assets.ts | 可保留扩展名/可读性检查，但必须增加 MIME、尺寸、hash、schema、重复和关系校验 |
| scripts/generate-search-suggestions.ts | 建议词采集逻辑可复用；V2 应从 Catalog 构建，不能读取可能过期的旧 metadata |
| scripts/generate-sitemap.ts | 静态 URL/lastmod 概念可复用；页面 URL 与 objectKey 要解耦 |
| scripts/check-sensitive-staged.mjs | secret guard 模式可复用；加入 ROS/GitHub Actions 凭证和 Catalog 泄漏检查 |
| scripts/stats-server.mjs | safe filename、HEAD/Range、ETag、Last-Modified、断开清理等 HTTP 细节可参考；服务本身不迁移 |
| scripts/check-arcaea-apk.ts | 官方页面定位和版本解析流程可作为 checker 候选；下载、校验、保留策略需重写 |

### REMOVE：只属于旧 VPS/旧目录体系

| 文件/逻辑 | 原因 |
|---|---|
| scripts/publish-arcaea-update.ps1 | SSH/SCP、远程 Arcaea 目录复制/移动、触发 remote-build |
| scripts/publish-phigros-update.ps1 | SSH/SCP、远程 Phigros 目录复制/移动、旧 overlay 目录 |
| scripts/check-remote-arcaea-apk.ps1 | SSH 进入 VPS source、远端 runtime 路径和临时 SSH 配置 |
| scripts/deploy.ps1 的远程/全量发布部分 | Baota/Nginx/VPS release tree，不适合 GitHub Pages + ROS |
| stats-server.mjs 的访客统计和 PM2/Nginx 运行方式 | V2 没有公网管理/统计后端计划；如需统计另行选择低耦合服务 |
| public/downloads 与旧 stats APK 路由 | 公开 APK 应由 ROS immutable object + Catalog metadata 提供 |

### REDESIGN：现有假设会造成迁移或更新错误

| 文件/环节 | 具体问题 |
|---|---|
| scan-assets.ts 的路径/文件名即身份 | 目录变化会改 ID；短别名无法映射；语义关系隐含在字符串 |
| extract-phigros-update.py | 只比较新增 bundle，无法覆盖 changed existing bundle、移除、bundle 内多 Texture2D 对应关系 |
| publish 两个 PowerShell | 复制上一版作为基底，只表达 additions/overwrites，不表达删除、重命名和资源关系 |
| compress-arcaea-update.ts | 默认删除输入；getVersionFromDirectoryName 返回了错误的正则捕获组，可能选错版本目录 |
| APK checker | 无 HEAD/Range/resume、无 hash/签名/ZIP 结构校验；已有同名文件只按存在跳过 |
| current public/data/arcaea-apk.json | 公开/生成 schema 含原始 source URL 和本机 filePath，不能直接发布 |
| recent-updates/sitemap lastmod | 把文件 mtime 当业务更新日期，迁移或复制后会失真 |

## 5. 不应在本轮执行的脚本

以下脚本包含写文件、删除、SSH/SCP、远端移动或部署行为，本轮只阅读源码，没有运行：

- arcaea:check-apk / arcaea:check-apk:remote
- arcaea:extract
- arcaea:compress
- arcaea:publish
- phigros:extract / phigros:publish
- deploy.ps1
- stats-server.mjs
- generate-thumbnails.ts、scan-assets.ts、update-arcaea-metadata.ts 等旧项目写入脚本

本轮唯一运行的分析程序是 V2 目录内一次性 tools/legacy-audit.mjs；它只读取两个旧路径和旧生成数据，把 JSON 证据写入 V2/docs/audit/data。

