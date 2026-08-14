# Phase 2A Domain Model

状态：Phase 2A 原型，等待架构审查。本文定义 V2 的领域合同，不实现公共网站、Admin、extractor 或 ROS。

# Phase 2B contract override

The implemented Phase 2B engine uses independent `catalogSchemaVersion`, `workspaceSchemaVersion`, `releaseSchemaVersion` and `publishPlanSchemaVersion` fields. The legacy generic `schemaVersion` is compatibility-only; it is not a future synchronization contract. See `docs/design/phase2b/07-phase2a-contract-revisions.md`.

## 1. 适用边界

本合同服务于本地的“旧 APK + 新 APK → Version Workspace → 人工整理 → 待发布”流程。输入 APK 必须由用户在本机提供。云端定时获取和分发 Arcaea APK 是另一个完全独立的系统，见本阶段 handoff 的 `Public Arcaea APK Distribution — OUT OF SCOPE`。

Phase 2A 只实现：

- TypeScript 类型和 Zod runtime schema；
- Catalog、UpdateBatch、Candidate、ReleaseManifest、PublishPlan 的校验原型；
- 本地 workspace 目录助手、状态转移和 `_optimization` 配对助手；
- 非破坏性 PNG → JPEG 转换原型；
- 基于 Phase 1 真实报告的高风险 fixture 和自动测试。

不实现 scanner、正式 extractor、SQLite、WebUI、ROS、Catalog 生成/提交、上传、GitHub Pages 或云端 APK checker。

## 1.1 CandidateManifest 边界

Legacy scanner、Arcaea APK extractor、Phigros extractor 和 manual add 未来都可以输出同一外壳 `CandidateManifest`：sourceType、game、sourceSnapshot、extractor version、Candidate IDs/count 和 notes。它统一的是 review/processing 的入口合同；每个 Candidate 仍保留 source-specific evidence，不把 Phigros 的低置信 key 或 Legacy 的历史别名伪装成同一种证据。

## 2. Published Catalog 的四层模型

```text
Resource（用户语义：这是什么）
  └─ Variant（确实不同的视觉/语义变体）
       └─ Rendition（同一 Variant 的文件表现）
            └─ Object（未来 ROS 保存的 bytes）
```

### Resource

Resource 是用户认为“同一个可展示资源”的语义节点，例如一首歌的曲绘、角色立绘、剧情 CG 或背景。它有：

- `id`：V2 生成并持久化的 UUIDv7 opaque ID；
- `game`：`arcaea` 或 `phigros`；
- `resourceType`：`jacket`、`pack-cover`、`background`、`character-portrait`、`character-avatar`、`linkplay-preview`、`sticker`、`story-cg`、`story-texture`、`startup`、`world-mode` 等；
- 可缺失的 `title` 和结构化 `metadata`；缺失 metadata 保留为空/unknown，不猜测；
- `externalIdentities[]`：songId、characterId、storyNode、Phigros key 等外部身份；
- `aliases[]`、显式 `relations[]` 和不可变 `provenance[]`；
- `lifecycle`：`draft`、`published`、`tombstoned`。

songId、title、filename、relativePath 都不是 Resource primary key。一个 songId 的多个不同曲绘必须能够形成多个 Variant，必要时也形成多个 Resource；关系只能经人工确认写入。

### Variant

Variant 是视觉内容或展示语义确实不同的版本。常见 `variantKey` 可以是 `default`、`pst`、`prs`、`ftr`、`byd`、`etr`、事件键或人工键，但键本身不是永久 ID。

Variant 不假设所有 Resource 都有 difficulty。普通 Resource 通常只有 `default`。只有文件、metadata 和人工预览共同支持时，才创建 difficulty/event Variant。`kind=unknown` 与 `semanticStatus=unresolved` 用于 `_256` 等未定语义。

`_0/_1/_2/_3` 是候选证据，分别可映射 PST/PRS/FTR/BYD；Phase 1 的事实是它们存在，不是所有带谱面 metadata 的歌曲都必然有独立曲绘。ETR metadata 不能自动创建 `_4` Variant。

### Rendition

Rendition 是 Variant 的文件表现：

- `original`：从 APK、Legacy 或人工输入得到的源表现；
- `upscaled`：外部 AI 工具产生、再经人工确认和 JPEG conversion 的可下载表现；
- `thumbnail-320`、`thumbnail-640`、`thumbnail-1280`、`other-derived`：派生、只读展示用途。

`upscaled` 的 `origin` 是 `derived`，但 `publishable=true`；缩略图的 `origin=derived` 且 `publishable=false`。Rendition 通过 `objectId` 引用 Object，不能从文件夹名或 `_opt` 字符串推断其类型。

### Object

Object 是未来 ROS 保存的不可变二进制对象，至少含：

- `sha256` 与 `id=sha256:<digest>`；
- `mime`、规范化扩展名、`sizeBytes`、`width`、`height`、`alpha`；
- `objectKey=objects/<sha256>/<extension>`；
- 创建时间和可迁移 provenance。

Object 内容变化必须生成新 Object。两个不同 Resource 可以引用同一个 Object；同 SHA-256 只证明 bytes 相同，不证明业务语义应合并。Phase 1 的普通曲绘/April Fools、剧情别名、启动页/世界模式重复都依赖这个不变量。

## 3. Catalog 持久化形态

Catalog 使用 `schemaVersion: "1.0"`，以四个顶层数组保存实体：`resources[]`、`variants[]`、`renditions[]`、`objects[]`。引用关系通过 ID 解析，便于 diff、审计和未来迁移；它不是 Legacy 的平面 AssetItem 快照。

Zod 负责单实体的 runtime shape；`validateCatalog` 负责外键、同 Variant 派生关系、Object hash/objectKey 一致性、缩略图不可下载和本机绝对路径禁入。未实现通用 migration framework；未来按 `schemaVersion` 写显式 `1.0 → 1.1` migration，并在迁移前后重新验证，不在加载时静默猜测字段。

## 4. Provenance 边界

Published Catalog 只保留可迁移信息：`sourceType`、游戏版本、APK 内部 relative path、原始 filename、hash、证据、review 时间和备注。`sourceType` 固定覆盖：`legacy`、`arcaea_apk`、`phigros_apk`、`manual`。

本地 UpdateBatch 可以记录 `E:\...`、APK 绝对路径、workspace root 和运行日志；这些字段不进入 Catalog。Validator 会拒绝 Catalog 内的 Windows drive path、UNC path 和 Unix absolute path。

## 5. Phase 1 证据约束

模型直接接受以下事实：Arcaea 616/616 原图与 AI 可配对且 hash 全不同；同 songId 有多个真实视觉变体；`_0.._3` 存在；`_256` 未定性；同 hash 可跨语义分类；Phigros metadata 稀疏；relativePath hash 不能成为永久身份。fixture 细目见 `08-fixture-coverage.md`。
