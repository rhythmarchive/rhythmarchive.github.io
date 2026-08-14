# PublishPlan Contract

## 1. 目的

PublishPlan 是未来发布的 dry-run 合同，不是上传器，也不是 ROS API。它把“要创建的 Object、要改的 Catalog、要写的 ReleaseManifest、将来可能 GC 的 Object”放在同一个可审阅计划中。

原型字段：

- `objectsToCreate[]`：Object ID、immutable objectKey、sha256、大小和 MIME；
- `catalogMutations[]`：create/update/replace/tombstone 及 Resource/Variant/Rendition/Object 引用和人类可读 summary；
- `releaseManifestMutation`：create/update、manifest ID、target version；
- `objectsEligibleForGC[]`：Object、原因、`eligibleAfter`、计划后引用数；这只是资格记录，不是删除命令；
- `dryRun`、校验结果和强制 `humanApprovalRequired=true`。

PublishPlan 不包含 ROS credential、绝对本机路径或真正的删除动作。

## 2. 发布顺序

未来 PublishRun 必须遵循：

```mermaid
flowchart LR
  A[validate schema and references] --> B[create required Objects]
  B --> C[verify bytes, hash, size, MIME]
  C --> D[mutate Catalog]
  D --> E[commit and push Catalog]
  E --> F[Pages deploy]
  F --> G[retention window]
  G --> H[GC old unreferenced Objects]
  H --> I[cleanup verified staging]
```

不能先删除旧 Object 再上传新 Object。`replace-rendition` 必须先创建/验证新 Object，再提交 Catalog；旧 Object 进入 retention/GC 候选，而不是同一计划立即删除。

## 3. 一致性规则

`validatePublishPlanConsistency()` 检查：

- Object ID 与 sha256 相等，objectKey 含同一 digest；
- mutation 引用的 Object 已在 Catalog 或 `objectsToCreate[]`；
- 同一个 Object 不能同时在 `objectsToCreate[]` 和 `objectsEligibleForGC[]`；
- 被替换的 previous Object 不能在同一计划中立即 GC；
- 人工批准门槛恒为 true。

实际的 byte verification、ROS HEAD/Range、Catalog commit 和 Pages 状态属于后续阶段，Phase 2A 只定义字段和 dry-run validator。

## 4. 与 ReleaseManifest 的关系

一个 PublishPlan 关联一个 UpdateBatch 和一个 ReleaseManifest mutation。Plan 的 `catalogMutations` 是执行动作，ReleaseManifest 是版本级可长期查询的结果。二者不互相替代：

- Plan 可以 dry-run、反复生成和丢弃；
- Manifest 在发布成功后保留，用来回答“这个版本改了什么”；
- staging 清理只依赖成功的 PublishRun，而不是 Plan 生成成功。

## 5. 明确不做的事情

本阶段不连接 Rainyun ROS，不生成真实上传 URL，不提交 GitHub Catalog，不触发 Pages，不执行 Object GC，不清理 `_optimization.png`，也不把旧 overlay publish 脚本迁移进 V2。
