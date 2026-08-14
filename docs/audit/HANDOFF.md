# Phase 1 Handoff：Arcaea / Phigros 资源站 V2 重构前审计

审计日期：2026-08-14  
审计范围：E:\rhythm-assets-gallery、E:\曲绘、旧站生成数据和旧 Git 状态  
本文件性质：面向下一位架构审查者的只读交接；所有 V2 方案均为 proposal，不是已实现合同。

机器可读证据位于 docs/audit/data/：

- archive-inventory.json：E:\曲绘 递归数量、类别、目录、版本、尺寸概览。
- archive-image-metadata.json：2,803 张图片的尺寸/格式读取结果。
- archive-hashes.json：2,803 张图片的 SHA-256、精确重复组、Arcaea 原图/AI hash 对照。
- legacy-index-analysis.json：旧站索引字段、分类、ID、关系、APK metadata 脱敏统计。
- published-assets-analysis.json：旧站 public/assets 与 index 的对齐检查。

## 1. Executive Summary

最重要的结论：

1. 旧站实际是 Astro 静态站 + React 图库组件 + build-time JSON index + Sharp 缩略图；不是只有 README 描述的简单文件浏览器。它还包含 Arcaea/Phigros 更新提取、人工超分/压缩、APK checker、旧 VPS API 和 SSH 发布链路。
2. E:\曲绘 有 2,806 个文件、3,237,208,420 B，包含 2,803 张图片、3 个辅助文件，但没有 APK。它是混合历史内容，不是规范化版本库。
3. E:\曲绘 的三个顶层目录分别是 Arcaea 主目录 2,176 文件、Arcaea（至6.16.0）增量 128 文件、Phigros 502 文件。6.16.0 目录不是完整快照；Phigros 没有可靠版本目录。
4. 旧站 public/assets 有 2,672 个文件、2,670 张图片；两个游戏 index 也正好有 2,670 条。文件到索引、索引到文件、ID 重算全部 0 缺失/冲突，说明旧站生成链路在当前快照内是自洽的。
5. 旧站 public/assets 不是 Legacy Seed 全量：它没有独立导入 6.16.0 目录的 99 张 LinkPlay 贴纸，并少于 Archive 中的新增/改名内容。
6. Arcaea 原图与 AI 超分按归一化文件名有 616/616 对配对，配对率 100%；其中 616 对的 SHA-256 全部不同，符合同一语义图的不同 rendition。
7. songId 不是 Resource ID：603 张原始 Arcaea 曲绘中有 530 个非空 songId，55 个 songId 有多个原始曲绘文件；7 个 songId 各有 3 个视觉变体。特殊难度和 _256 使“同 songId 一张图”的假设不成立。
8. Archive 有 19 组、39 个文件的精确重复 hash，既有别名、剧情重复，也有普通曲绘/April Fools、启动页/世界模式等跨分类重复。去重只能生成候选，不能自动删除或强制合并。
9. Arcaea extractor 的 selective APK/path diff、metadata 读取和可读命名有迁移价值；Phigros extractor 只比较新增 Addressables bundle，无法可靠发现既有 bundle 内容变化，应重写或至少加人工阻塞。
10. V2 应采用 ROS 二进制 + GitHub Catalog 的边界；objectKey 优先不可变 hash key，页面 URL 与 objectKey 解耦；Admin 应围绕 staging 审核和 PublishPlan，而不是泛化 CRUD。

本轮没有修改两个旧路径，没有上传、连接 ROS、连接 SSH、执行旧 publish/deploy/checker，也没有实现网站或 Admin。

## 2. 旧项目实际架构

核心数据链：

    ASSET_ROOT
      → scan-assets.ts
      → arcaea-index / phigros-index / summary / recent-updates / tags
      → generate-thumbnails.ts
      → Astro build
      → 静态首页、图库、搜索页、详情页、sitemap

scan-assets.ts 默认读取 public/assets，也可由 ASSET_ROOT 指向旧 VPS 的外部曲绘目录。它按路径判断游戏和类别，按 Arcaea filename 的 IDX/BPM/SIDE 锚点解析歌曲，再用 scripts/data/arcaea-metadata.json 补 metadata。ID 是 NFC 归一化 relativePath 的 SHA-1 前 16 位。

前端真实功能：

- 首页统计、最近更新、公告和 Arcaea APK 卡片。
- Arcaea、Phigros、跨游戏搜索。
- Fuse 单词搜索，多词全部命中；分类、曲包、侧别、版本筛选；排序和分页。
- 静态详情页，显示原图下载、尺寸、大小、metadata、标签、背景和相关资源。
- Arcaea 原图与 AI 互切；按 pack、characterId、storyPath、songId、bg 做相关推荐。
- 浏览器端多选 ZIP；逐个 fetch 原图，在内存中构造 ZIP。
- sitemap、SEO、缩略图和静态部署。

旧后端与部署：

- stats-server.mjs 监听 VPS loopback 3001，提供访客统计、APK metadata、GET/HEAD/Range 下载。
- check-remote-arcaea-apk.ps1 通过 SSH 到远端 source 目录执行 checker。
- publish-arcaea-update.ps1 和 publish-phigros-update.ps1 用 SSH/SCP 复制或上传远端目录，再默认触发 deploy.ps1。
- deploy.ps1 的 remote-build 在 VPS 生成 index、thumbs、dist，并通过 Nginx/Baota 切换 release。
- 当前不存在 .github/，没有旧仓库内 Actions workflow 证据。

旧仓库初始状态已有未提交修改，main 比 origin/main ahead 1；本轮仅读取，未改变状态。

## 3. E:\曲绘 实际结构

| 根 | 文件数 | 大小 | 解释 |
|---|---:|---:|---|
| Arcaea | 2,176 | 2,334,175,354 B | 主体历史内容，含 change.py、rename_script.bat |
| Arcaea（至6.16.0） | 128 | 58,292,029 B | 增量/补充，不是完整 6.16.0 快照 |
| Phigros | 502 | 844,741,037 B | 无版本根；含压缩报告 |
| 合计 | 2,806 | 3,237,208,420 B | 约 3.237 GB |

图片为 1,542 JPG、1,261 PNG；没有 APK。辅助文件为 Arcaea/曲绘/change.py、Arcaea/曲绘/rename_script.bat、Phigros/曲绘/phigros-compress-report.json。

按类别：

- Arcaea：曲绘 616、AI 超分 616、曲包封面 195、游玩背景 156、角色 LinkPlay 预览 148、剧情 147、角色立绘 139、角色头像 130、LinkPlay 贴纸 99、启动页 39、世界模式 17。
- Phigros：曲绘 320、头像 107、曲包封面 41、April Fools 33。

形成过程判断：

- Arcaea 主目录的长文件名来自历史人工/半自动改名；change.py 硬编码 songlist.csv 和 D:\Files\arcaea，批处理日志显示 534/538 匹配成功。
- Arcaea（至6.16.0）只有 13 原图、13 AI、1 封面、2 背景和 99 贴纸，因此是增量 overlay。
- Phigros 压缩报告只证明曾处理 3_19_3 目录中的两个 optimization 输入，不证明整个 Phigros 根属于 3.19.3。
- 没有名为 temp、processed、backup 的 Legacy Seed 顶层目录；旧仓库另有 automation staging 和 .deploy-work。不要将部署工作区视为正式资源。
- 精确 hash 有 19 组/39 文件重复；重复跨剧情别名、曲绘别名、April Fools、启动页/世界模式等场景。

旧站交叉核对：

- public/assets 2,672 文件、2,670 图片、3,165,547,898 B。
- Arcaea index 2,174，Phigros index 496。
- 文件/索引缺失均为 0；重复相对路径为 0；stable ID mismatch 为 0。
- public/assets 的 Arcaea 主曲绘有 603 原图 +603 AI；Archive 还有 6.16.0 增量。
- Phigros Archive 中 Cipher、Labyrinth in Kowloon、Stardust 有 3 对改名但同 hash 的文件；另有约 5 个净新增内容未进入旧站快照。

## 4. 当前资源类型和分布

当前旧站的资源类型是路径类别，不是独立的 Resource graph：

- Song jacket：Arcaea 603 original +603 AI；Phigros 315。
- Difficulty jacket：Arcaea 原图 57 个带 _0/_1/_2/_3 后缀的独立文件，AI 对应再加 57。
- Pack cover：Arcaea 195（Archive）/194（旧站），Phigros 41。
- Background：Arcaea 156（Archive）/154（旧站）。
- Character portrait：139；character avatar：130；LinkPlay preview：148；LinkPlay sticker：99。
- Story CG：147；源码支持剧情贴图路径，但当前 Archive 没有独立剧情贴图类别。
- Startup：39；world mode：17。
- Phigros avatar：107；April Fools：33，无 AI 对应目录。

角色路径的实际语义是 char/1080 → 立绘，char/*_icon → 头像，char/*_mp → LinkPlay 预览，img/multiplayer/stickers → 贴纸。角色字段约覆盖 98 个 metadata character ID，characterVariant 有 14 个非空变体。

## 5. 原图 ↔ AI 超分关系

配对方法是去扩展名、去 .jpg_opt/_opt/_optimization、NFC、小写；旧详情页也用近似规则寻找 rendition。

- Arcaea 主目录：603/603 配对。
- Arcaea（至6.16.0）：13/13 配对。
- 合计：616/616 配对，原图和 AI 两侧均 100%。
- 全部 616 对的 hash 不同；常见尺寸模式是原图 768x768、AI 3072x3072。
- 同 hash 别名包括 dropdead/Overdead、Ignotus Afterburn、Red and Blue and Green、Singularity VVVIP 等。

结论：Resource/Variant/Rendition 模型是合理方向，但必须补 provenance/alias：

- Resource：语义上同一张可展示图片。
- Variant：difficulty、事件、source path 或视觉内容确实不同的变体。
- Rendition：original、AI upscaled、compressed、thumbnail 等文件表现。
- Object/provenance：sha256、objectKey、源路径、源 APK/版本、审核证据。

原图和 AI 应是同一 Variant 的两种 Rendition；同 songId 的 base/PST/PRS/BYD 应是 Variant 候选，不应只依赖 songId；同 hash 不同名字应先做 alias candidate。

## 6. 特殊难度曲绘

原始文件名末尾后缀统计：

- _0 / PST：7 原图，14 原图+AI index records。
- _1 / PRS：7 原图，14 records。
- _2 / FTR：1 原图，2 records。
- _3 / BYD：42 原图，84 records。
- _4 / ETR：0。
- 总计：57 原图，114 原图+AI records。

当前 metadata 中的 bydVersion/etrVersion 只表示歌曲有相应谱面，不代表当前文件是独立难度曲绘。ETR metadata 存在也不能自动生成 ETR Variant。

同 songId 多视觉变体的证据：

- 603 原始曲绘中 592 张能得到 songId，11 张短别名/历史文件无法可靠得到。
- 530 个非空 songId 中，55 个有多个原始曲绘文件。
- 7 个 songId 各有 base、_0、_1 三个原始文件；48 个各有两个。
- asgore 有普通和 _256 两套；旧 extractor 排除 _256，但历史索引包含它。

对 V2 的影响：difficulty marker、source APK path、base/_256 和事件类别必须进入 Variant candidate，不能把所有同 songId 文件压成一个 Resource。

## 7. Arcaea / Phigros 更新链路

### Arcaea

新版 APK → checker 从官方页面找 CDN anchor → 全量下载到 .part 并 rename → history metadata → new/old APK selective extraction → 以 APK 相对路径 SHA-1 比较 → 新增/变化图片候选 → 读取 songlist/packlist/characters/story metadata → 生成可读前缀文件名 → 人工审核和 AI 超分 → compress 转 JPEG → publish overlay 上传旧 VPS → remote-build 重新 scan/thumb/build。

实际人工审核发生在 extract 输出之后、publish 之前；AI 超分也在这一区间。compress 不是语义审核，只是图像格式/尺寸处理。publish 不生成删除/重命名 manifest，而是复制上一版远端目录作为基底后上传分类目录。

### Phigros

新版/旧版 APK → 按版本名选择最高和前一版 → 读取 Addressables catalog key 与 bundle 文件集合 → 只发现新增 key/新增 bundle → UnityPy 扫描 Texture2D → Illustration 大图归为曲绘，小图归为头像 → 从 key 或 object/bundle 名推断文件名 → 人工核对/改名 → publish 只上传曲绘/头像 → 旧 VPS overlay + remote-build。

已知硬限制：既有 bundle 内容变化不会被资源级比较；一个 bundle 内多个 Texture2D 与 catalog key 的顺序对应也可能需要人工确认。这个流程不能作为 V2 的完整增量发布依据。

## 8. 可复用旧代码分类

### KEEP（保留思路/核心算法）

- src/components/GalleryGrid.tsx：搜索、筛选、排序、批量选择的产品语义。
- src/pages/asset/[id].astro：详情页应展示的关系类型和 original/AI 入口。
- src/lib/client-zip.ts：基本 ZIP 语义和同名处理。
- scripts/update-arcaea-metadata.ts：读取 songlist、packlist、character、story 的核心思路。
- scripts/generate-thumbnails.ts：Sharp 尺寸、质量和增量跳过思路。
- stats-server.mjs 的 safe filename、HEAD/Range、ETag/Last-Modified 经验。

### ADAPT（核心有价值，接口必须改）

- scripts/scan-assets.ts：保留 Arcaea metadata enrichment 和类别识别，但改成 manifest + provenance + 显式审核结果。
- scripts/extract-arcaea-update.ts：保留选择性抽取和初步 diff，增加 renamed/removed/semantic mapping。
- scripts/extract-phigros-update.py：保留 catalog/key 解码和 UnityPy 导出，重做 changed bundle 和人工 mapping。
- scripts/compress-arcaea-update.ts：保留 Sharp 参数，去除默认 destructive delete，修正版本选择。
- scripts/import-incoming-assets.ts：保留 dry-run 计划框架，补 CandidateFile/ReviewDecision。
- scripts/validate-assets.ts：补 MIME、尺寸、hash、schema、重复、关系和 object verification。
- scripts/generate-search-suggestions.ts、scripts/generate-sitemap.ts：改为从 V2 Catalog 生成。
- scripts/check-sensitive-staged.mjs：扩展到 ROS/GitHub token、本机路径和 Catalog secret guard。
- scripts/check-arcaea-apk.ts：保留官方页面定位/版本归一化，重做 checker、verifier、artifact manifest。

### REMOVE（旧 VPS/SSH/目录体系）

- scripts/publish-arcaea-update.ps1
- scripts/publish-phigros-update.ps1
- scripts/check-remote-arcaea-apk.ps1
- deploy.ps1 的 SSH/SCP、远端 ASSET_ROOT、remote-build、Nginx/Baota 部分
- stats-server.mjs 的 PM2 访客统计和旧 APK runtime 服务
- public/downloads 和旧 /api/ APK 公开下载路径

### REDESIGN（不能原样迁移）

- scan-assets.ts 的 relativePath hash 身份模型。
- extract-phigros-update.py 的新增 bundle-only diff。
- 两个 publish 的“复制上一版作为基底 + 上传目录” overlay 语义。
- compress 的默认删除和版本正则 bug。
- checker 的无 hash/签名/结构验证、无 Range/resume、已有文件只按存在跳过。
- public/data/arcaea-apk.json 的 source URL、本机 filePath schema 漂移。
- mtime 作为最近更新/lastmod 的业务语义。

## 9. 首次迁移风险

最大风险按优先级：

1. 关系误合并：songId、标题或 basename 把不同 Variant 合成一个 Resource。
2. 关系漏合并：AI、改名、特殊字符编码、短别名被当成独立资源。
3. 版本/provenance 丢失：无版本根的 Arcaea 主目录和 Phigros 根被伪造为某个 APK 版本。
4. metadata 缺失或错误：Phigros artist 只有 22/496 非空；11 个 Arcaea 短别名无法可靠映射；剧情贴图、ETR、_256 语义未完全确定。
5. 发布不可回滚：旧 overlay 逻辑不表达删除/重命名；ROS 覆盖同 key 会受到长缓存和 Catalog 不一致影响。

缓解原则：完整 file manifest、sha256、sourcePath、category evidence、confidence、人工 decision、PublishPlan、对象验证、Catalog diff、延迟 GC；不自动删除源文件。

## 10. Admin WebUI 推荐职责

MVP 必须服务于实际工作流：

- Dashboard：Catalog 数量、待审更新、APK latest/previous/hash、ROS health、最近 publish、staging 占用。
- 更新中心：候选预览、metadata diff、added/changed/alias/unmapped、Arcaea special difficulty、Phigros key/bundle/Texture2D、接受/拒绝/merge/new variant/new rendition。
- 资源管理：按 Resource/Variant/Rendition 搜索，查看 hash/provenance，编辑 metadata/关系，保存审计 diff。
- 发布中心：dry-run、上传字节数、validation、thumbnail、ROS upload、object verify、Catalog diff/commit、Pages workflow、成功后 staging 清理。
- 系统页：本机任务、日志、磁盘、ROS 配置存在性、互斥锁；不做公网 Admin、不复活旧 stats API。

后做：自动 GC、回滚、近似图、OCR、全自动调度控制台、统计服务、账号权限。第一版不要先做通用 CRUD。

## 11. APK 自动化建议

建议把 APK 拆成三类对象：

1. private check record：source URL、HTTP headers、ETag、下载尝试、runner 路径。
2. internal immutable APK artifact：版本、sha256、size、ROS objectKey；至少保留 latest 与 previous。
3. public latest metadata：version、filename/displayName、size、sha256、objectKey、publishedAt；不含本机路径，不默认暴露 source URL。

GitHub Actions 可定时检查、临时下载、验证 SHA-256/长度/ZIP 结构/可选签名、上传 ROS internal prefix、HEAD/Range 验证、运行 extraction、发布候选 report。人工批准后再更新 Catalog 和公开指针。

公开区主要保留最新版不妨碍 diff：previous APK 需要 internal retention，并在 diff manifest 中记录精确 old/new objectKey。previous 不存在时任务应阻塞，而不是选择不确定的旧文件。public latest 采用 Catalog 指针或 immutable target；不要覆盖同 key 后依赖浏览器缓存刷新。

Playwright 目前是旧脚本实现依赖，但源码未证明技术上不可替代；应先探测稳定 HTTP/API，再把浏览器作为 fallback。

## 12. 建议的 V2 架构（proposal）

    GitHub repository
      ├─ Astro site
      ├─ Catalog schema/data
      ├─ search index generation
      ├─ APK public metadata
      └─ Actions / validation

    Local Admin + local worker
      ├─ Legacy scanner
      ├─ APK checker/extractor
      ├─ staging/review database or files
      ├─ Resource graph editor
      ├─ PublishPlan/validation
      └─ ROS uploader/verifier

    Rainyun ROS
      ├─ immutable original/AI objects
      ├─ thumbnails
      ├─ public latest APK object
      ├─ internal previous APK/diff baseline
      └─ optional binary resources

建议 objectKey 使用 sha256 或 sha256+extension 的 immutable 结构，例如 objects/<sha256>/<ext>。Catalog 引用 objectKey、sha256、size、mime、尺寸和 provenance；页面 URL 使用 Internal stable Resource/Variant ID，二者解耦。

Arcaea external songId/characterId 作为 external identity；内部 ID 应包含 namespace、resourceType、variantKey。无官方 ID 的资源使用规范化 identity tuple + hash/UUID，并保留人工 override。不能用 title alone，也不能用 relativePath hash 作为永久语义 ID。

## 13. Open Questions

以下是本轮源码和真实文件仍无法确定、而不是可以通过继续读旧代码解决的问题：

1. Arcaea 官方页面是否有稳定的非浏览器下载接口；Playwright 是否必须长期保留。
2. 官方 APK 是否提供可验证 hash、签名或证书策略。
3. Rainyun ROS 的实际 S3 endpoint、CORS、Range、multipart、metadata、versioning、lifecycle、credential/GitHub OIDC 能力。
4. previous APK 应在 internal prefix 保留多久，怎样保证历史 extractor 可复现。
5. 同 SHA-256 的不同路径/类别是否在产品上是同一个 Resource 的 alias，还是要保留多个页面入口。
6. _256 是 Rendition、独立 Variant 还是应被隐藏的历史兼容资源。
7. ETR metadata 与当前历史文件的实际独立曲绘关系；当前没有 _4 文件，但 metadata 有 ETR 记录。
8. Phigros archive-only 内容的真实 APK/source version，以及 changed bundle 内的可靠资源身份。
9. 当前 Arcaea 主目录中每个文件的准确 source version；目录没有完整版本标记。
10. 当前剧情目录是否混入了原本应作为剧情贴图的资源，以及缺失的 VN texture 是否只是未收集。
11. ROS object 删除、Catalog tombstone、rollback 和人工批准的最终保留政策。

## 14. Recommended Phase 2

下一阶段建议按以下顺序推进：

1. 固定本轮 audit JSON 和报告作为 baseline，不再修改旧项目和 E:\曲绘。
2. 设计并评审 V2 Catalog schema，先解决 Resource/Variant/Rendition、alias/provenance、external identity。
3. 用本轮高风险样本建立 identity fixtures：7 个三变体 songId、BYD/base、_256、AI pair、重复 hash、剧情、Phigros April Fools 和改名文件。
4. 在 V2 内实现只读 scanner/candidate manifest，不上传、不改源、不生成正式公开 Catalog。
5. 获得两版真实 Arcaea APK 和两版 Phigros APK 后，在隔离 staging 验证 extractor，优先补 changed/renamed/removed 和人工阻塞。
6. 明确 ROS key、缓存、删除、previous APK retention、GitHub Actions credential 和人工批准门槛。
7. 先做本地 Admin 的 review queue、metadata diff、Resource graph 和 PublishPlan；再做 ROS 小批量验证。
8. 最后实现 Catalog commit、Pages build 和 staging 清理。

暂时不应做：

- 继续把新资源归档到 E:\曲绘。
- 修改旧项目“顺手修复”或迁移旧 publish/deploy。
- 直接按 songId 合并所有曲绘。
- 直接上传全量 Legacy Seed 或删除旧文件。
- 先做公网 Admin、登录、数据库、统计后端。
- 在没有 previous APK 和对象校验时自动发布图片。

**Phase 1 状态：只读探索、审计和迁移前建模完成；没有进入实现。**

