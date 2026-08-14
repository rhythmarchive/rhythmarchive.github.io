# Legacy Seed 首次迁移分析

本报告只提出首次导入方案，不执行扫描导入、生成正式 Catalog、上传 ROS 或修改 E:\曲绘/旧项目。

## 1. 迁移目标和边界

E:\曲绘 只作为一次 Legacy Seed。V2 上线后：

- Rainyun ROS 保存正式图片、AI、缩略图、APK 和必要二进制。
- GitHub Catalog 保存正式 metadata、关系、objectKey、schema 和 provenance。
- E:\曲绘 不再是后续新增资源的长期归档。
- 本地 .runtime/staging 只保存当前更新批次、APK diff baseline 和可恢复的中间产物。

迁移程序应始终以只读方式读取 E:\曲绘，同时可读取旧站 public/assets/public/data 作为“已发布快照”对照；不能假定任一目录是唯一 source of truth。

## 2. 推荐流水线

    E:\曲绘 + 旧站索引/metadata
      ↓
    scanner
      ├─ sourceRoot/sourcePath
      ├─ extension、mime、size、mtime、dimensions
      ├─ SHA-256
      ├─ path category evidence
      └─ source snapshot id
      ↓
    candidate mapping
      ├─ 游戏/类别
      ├─ Arcaea IDX/songId/pack/character/story
      ├─ Phigros title/artist/key
      └─ confidence + evidence list
      ↓
    deduplication candidates
      ├─ exact hash
      ├─ same filename normalized key
      ├─ original ↔ AI pair
      └─ renamed/encoded aliases
      ↓
    Resource grouping
      ↓
    Variant/Rendition grouping
      ↓
    metadata mapping + review queue
      ↓
    migration report + human confirmation
      ↓
    ROS upload + object verification
      ↓
    Catalog generation/commit
      ↓
    verified cleanup of local staging only

本轮只完成了上游审计证据和 JSON 统计，没有执行后半段。

## 3. 可以完全自动完成的映射

| 映射/检查 | 依据 | 自动化等级 |
|---|---|---|
| 文件类型、大小、mtime、尺寸 | 文件系统 + Sharp | 高 |
| 游戏候选 | 顶层路径 Arcaea/Phigros | 高，但保留证据 |
| 基础类别候选 | 已知路径段/目录名 | 高，对未知目录标记 unknown |
| 原图/AI filename pair | 去扩展名、_opt/_optimization、NFC、小写 | 高：616/616 对配对 |
| rendition 尺寸/格式/hash | 文件内容和图像 metadata | 高 |
| 精确重复候选 | SHA-256 | 高，但只产出候选，不自动删 |
| 旧站是否已有同一 relativePath | public index/path | 高 |
| Arcaea difficulty suffix | 原始文件名 _0 到 _4 | 高：57 个原始候选 |
| objectKey 内容哈希 | SHA-256 | 高 |

## 4. 高可信但必须抽查

| 映射 | 依据和风险 |
|---|---|
| Arcaea 曲绘 → songId/标题/作者/曲包 | filename 的 IDX、长前缀、arcaea-metadata；短别名有 11 个无法可靠映射 |
| Arcaea 曲包封面 | 1080_select/1080_small/divider 文件名 + packlist；需要检查本地化名冲突 |
| Arcaea 角色 | char 数字、_icon/_mp + characters metadata；需确认变体/角色继承 |
| Arcaea 背景 | bg 字段和背景文件名归一化；背景 alias/重复需抽查 |
| Arcaea 原图与 AI | 当前 Legacy 100% 配对，但相同 hash 别名可能造成多对一 |
| 6.16.0 增量目录 | 目录名和与主目录差异；没有完整快照语义 |
| Phigros 标题/作者 | 文件名分隔符或 Addressables key；现有索引 artist 只有 22/496 条非空 |
| Phigros 普通曲绘 vs April Fools | 路径分类清楚，但至少两对 exact hash 相同，是否同 Resource 要抽查 |

## 5. 必须人工审核的映射

- 同一个 songId 下的 base、PST、PRS、FTR、BYD 文件是否真的是独立 Variant；文件名能发现候选，但不能代替视觉确认。
- ETR metadata 与独立曲绘的关系；当前历史文件没有 _4 独立曲绘。
- _256 文件是否应作为低分辨率 Rendition、独立 Variant 还是历史兼容别名。
- 同 SHA-256 不同标题/分类/目录的业务含义：Overdead/dropdead、短名/BYD 长名、剧情重复、启动页/世界模式、April Fools/普通曲绘。
- Arcaea 剧情 CG 与剧情贴图的分类；Legacy Seed 只观察到 剧情，没有独立剧情贴图样本。
- Phigros 8 个 archive-only 文件的版本和业务来源；其中 3 个只是与旧站文件改名后的同内容，剩余约 5 个需要来源确认。
- 缺失 metadata、未知目录、非法/特殊字符文件名。
- 任何删除、覆盖、合并或 public visibility 决定。

## 6. 首次导入的报告格式建议

每个文件至少记录：

    sourceRoot
    sourcePath
    sourceSnapshot
    categoryEvidence[]
    guessedGame
    guessedResourceType
    title/artist/externalIds
    sourceVersion
    sizeBytes/width/height/mime
    sha256
    normalizedPairKey
    duplicateHashGroup
    candidateResourceId
    candidateVariantKey
    candidateRenditionType
    confidence
    evidence[]
    reviewStatus
    reviewerNote

每个 Resource/Variant/Rendition 分组还应记录：

- members 和 aliases；
- chosen canonical file；
- original source paths；
- why grouped；
- unresolved conflicts；
- target ROS objectKey proposal；
- whether old public snapshot already contains it。

## 7. 不应把“去重”当成删除

本次哈希统计发现 19 组/39 文件 exact duplicates。首次迁移应：

1. 先把每个源文件都登记。
2. 产生 exact duplicate candidate group。
3. 选择 canonical object 只影响未来 ROS 上传次数，不影响 provenance。
4. 保留 alias/source reference，直到人工确认它们是否只是同一资源的不同路径。
5. Catalog 公开一个对象还是多个页面入口，由 Resource/Variant 业务决策决定。
6. 不从 E:\曲绘 或旧项目删除任何文件。

## 8. 迁移风险和缓解

| 风险 | 缓解 |
|---|---|
| 同一个文件被识别为多个资源 | hash + normalized key + metadata 三路证据，人工 review |
| 同名不同内容 | hash 不同则不得仅按 basename 合并 |
| 不同名同内容 | alias group，不自动丢弃 |
| songId 多个 Variant | 使用 variantKey，songId 只做 external identity |
| 旧目录无版本 | sourceRoot + observedAt + confidence，不能伪造 sourceVersion |
| mtime 被复制污染 | 同时保存 archive mtime、扫描时间、推断来源，不把 mtime 当发布日期 |
| 旧站与 Archive 不一致 | 双快照分别登记；public snapshot 只作对照 |
| 元数据缺失 | reviewStatus=needs-metadata，不填猜测值 |
| ROS 上传中断 | immutable hash key、可重试上传、上传后 HEAD/范围校验 |
| Catalog 写入成功但对象缺失 | 发布顺序必须是对象验证 → Catalog commit |
| 迁移后本地清理过早 | 以 PublishRun/验证状态为门槛，Phase 1 不清理 |

## 9. 首次导入的建议阶段

1. 冻结本轮审计 JSON 和报告，建立可复现的 source snapshot。
2. 只读生成完整 file manifest 和 candidate mapping，不上传。
3. 先人工处理少量高风险样本：7 个三变体 songId、特殊 BYD、_256、重复别名、剧情、Phigros April Fools。
4. 固化 V2 schema 和 identity rules。
5. 在隔离 staging 生成 migration report 和待审核 UI。
6. 对确认项做 ROS 小批量试传和对象验证。
7. 生成 Catalog diff，人工审阅后再公开。
8. 最后才设计清理策略；本轮不执行。

