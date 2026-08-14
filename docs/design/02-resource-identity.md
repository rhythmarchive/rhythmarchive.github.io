# Resource Identity and Object Identity

## 1. 最终推荐

V2 选择：

| 层 | 推荐身份 | 规则 |
|---|---|---|
| Resource | UUIDv7 opaque ID | 首次创建时生成并持久化；不从 title、filename、songId 或 path 重算 |
| Variant | UUIDv7 opaque ID | `variantKey` 只是可读标签；修改标签不改 ID |
| Rendition | UUIDv7 opaque ID | 同一 Variant 的不同文件表现各有自己的记录 |
| Candidate | UUIDv7 opaque ID | extractor 创建后写入 batch manifest；人工改名不改 ID |
| Object | `sha256:<64 hex>` | bytes 的内容身份；bytes 变化即新 Object |
| ROS objectKey | `objects/<sha256>/<ext>` | immutable storage key，与页面 URL 和 Resource ID 解耦 |

UUIDv7 采用 RFC 9562 的时间有序前缀和随机部分：便于本地列表按创建时间排序，又不把业务语义编码进 ID。实现生成的是 UUIDv7，Zod 也检查 version/variant 位。ID 一旦落入 Catalog 或 batch manifest，就只能通过显式 migration/tombstone 生命周期管理，不能因文件改名而重新生成。

## 2. 不变量

- 改 `sourceFilename`、`suggestedFilename`、`reviewedFilename` 或 `finalFilename`，Resource/Variant/Rendition/Candidate ID 不变。
- 修改 Resource title、外部 songId 映射、metadata 或 alias，不改 Resource ID。
- ROS `objectKey` 变更不改 Resource ID；若 bytes 变更，生成新的 Object，并在 Rendition/ReleaseManifest 中表达替换。
- 同一个 Object 可以由多个 Rendition 引用，也可以由不同 Resource 的 Rendition 引用。
- Object hash 相同只产生 alias/dedup candidate，不自动合并 Resource，不自动删除文件。
- `songId`、`characterId`、`storyNode`、Phigros key 只进入 `ExternalIdentity`。

## 3. 为什么不使用语义 ID

`arcaea:song:<songId>:jacket:<variant-key>` 可以作为审计显示键或候选 identity tuple，但不能作为永久主键。Phase 1 已证明 55 个非空 songId 关联多个原图、7 个 songId 各有 3 个视觉变体；短别名也不能可靠取得 songId。title、basename 和 relativePath 同样会因人工改名、编码、版本路径和历史别名变化。

真正安全的流程是：创建 Candidate → 人工确认 Resource/Variant → 分配 UUIDv7 → 写入 Catalog。无法确认的对象保持 review-scoped Candidate，不提前承诺永久语义。

## 4. 备选方案评估

### ULID

ULID 同样时间有序、实现简单，也可以作为备选。这里选择 UUIDv7 是因为它是标准 UUID 家族的一部分、生态工具兼容性更好，且不需要额外引入 ULID 解析约定。

### 带 namespace 的 deterministic UUID

例如将 `game + resourceType + songId + variantKey` 做 UUIDv5。它适合“输入 identity 已经可靠且不可歧义”的实体，但本项目恰好存在 songId 多视觉变体、短别名、`_256` 未定语义和 Phigros 低置信 metadata。错误的 tuple 会把错误合并固化成看似稳定的 ID，因此不能作为默认方案。

### 可读 opaque ID

例如 `res_01...`、ULID 或随机 UUID 均可作为外观格式。V2 原型没有在 ID 内嵌游戏、title、difficulty，避免未来改语义时需要重命名实体。

## 5. Alias 与 binary dedup

Alias 记录原始文件名、历史路径、同 hash 名称或外部身份的可追溯值。alias 不等于 merge：

- `Ignotus Afterburn.jpg` 与 BYD 长文件名同 hash 时，先建立 alias candidate；
- Phigros 普通曲绘与 April Fools 同 hash 时，可共享 Object，但保留两个人工确认的 semantic Resource；
- 616 对原图/AI hash 全不同，表示同一 Variant 的不同 rendition，不是 duplicate Object。

任何合并、删除、tombstone 或 Object GC 都要通过 ReviewDecision 和 PublishPlan，不能由 hash 扫描直接执行。

## 6. Published 与 local identity 的分离

本地候选可以用 `workspaceRelativePath`、绝对 root 和临时文件 ID 协助恢复工作，但正式 Catalog 只引用 portable relative path、hash、游戏版本和审计证据。`E:\曲绘`、`.runtime`、用户 Windows 名称和 APK 绝对路径永远不进入 Published Resource/Object provenance。
