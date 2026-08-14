# Phase 2B contract override

The Phase 2A text below is retained as historical design context. For the implemented Phase 2B engine, `ReleaseManifest` describes public Catalog changes only: it does not contain `ignoredCandidates`; rejected/ignored Candidates and review history live in `metadata/review-log.json`. Published rendition entries use `downloadFilename`, and the document uses `releaseSchemaVersion` independently from Workspace/Catalog/PublishPlan versions. See `docs/design/phase2b/07-phase2a-contract-revisions.md`.

# ReleaseManifest / Version Manifest

## 1. 正式概念

“Arcaea 6.17.0 的最终更新文件集合”不是 `work/` 的 filesystem snapshot，而是一个可长期保存的版本事实。Phase 2A 选择 `ReleaseManifest`，包含：

- `schemaVersion`、manifest ID、UpdateBatch ID、game、base/target version、创建时间和状态；
- `changes[]`：版本级变化；
- `affectedResourceIds[]`；
- `publishedRenditions[]`：Resource/Variant/Rendition/Object 和最终 display filename；
- `ignoredCandidates[]`：明确忽略及原因；
- notes。

状态为 `draft`、`validated`、`published`。它可以在 staging 清理后继续存在于 Catalog/release history 中。

## 2. 变化类型

原型支持：

- `added-resource`：新增语义 Resource；
- `added-variant`：已有 Resource 新增视觉/难度/事件 Variant；
- `added-rendition`：已有 Variant 新增 original/upscaled rendition；
- `replaced-rendition`：同一语义位置改用新 Object，并记录 previous Object；
- `metadata-changed`：title、artist、external identity 或结构化 metadata 变化；
- `alias-added`：新别名/路径证据；
- `ignored-candidate`：候选被排除但仍留下可解释原因。

每一项都要尽可能写 Resource/Variant/Rendition/Object/Candidate ID，而不是只保存一串文件名。新增 upscaled 文件必须同时能追溯 original Variant 和最终 Object。

## 3. 可回答的问题

未来只依赖 Catalog、ReleaseManifest 和 ROS Object，就可以回答：

- 6.17.0 新增了哪些 Resource、Variant、Rendition；
- 哪些 rendition 被替换，旧 Object 是什么；
- 哪些同 hash 文件只是 alias/不同语义入口；
- 哪些 Candidate 被忽略以及原因；
- 某个版本影响了哪些 Resource/Variant。

ReleaseManifest 不保存本机绝对路径，不要求 workspace 永久存在，也不等价于“当前 Catalog 的全部内容”。它是版本差分的审计记录，未来理论上可以结合 Catalog 和 ROS 重新导出该版本资源；Phase 2A 不实现导出/下载。

## 4. 一致性门槛

`validateReleaseManifestConsistency()` 检查：

- affected Resource、Variant、Rendition、Object 引用存在；
- `added-resource` 至少标识受影响 Resource；
- `added-rendition` 同时标识 Rendition 和 Object；
- published rendition 的四层引用完整；
- manifest 不是用绝对本机路径伪造版本信息。

它不代替人工判断“同 hash 是否同语义”，也不自动把 ignored Candidate 变成删除操作。
