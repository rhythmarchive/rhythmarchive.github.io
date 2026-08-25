# 人工审核与发布准备

## 触发条件

需要查看版本差异、批准候选、准备 ReleaseManifest 或生成对象存储同步 dry-run。

## 规则

- `review` 必须生成可读的新增、修改、删除、改名和异常摘要。
- `approve` 只是明确记录 reviewer 和批准项；没有批准不得进入 READY_LOCAL_ONLY。
- `storage diff` 只依据 Manifest 的 hash、size 和 remote key。SAME 不操作，NEW/CHANGED 未来上传，REMOVED 仅 review，不执行删除。
- 本仓库无人值守任务禁止 ROS/对象存储写入、删除和生产发布；正式 publish executor 只能在另一个明确授权的流程中使用。

## 执行入口

`rhythmctl diff` → `review` → `check-approval`/`approve` → `storage diff` → `release prepare`。保留 Catalog 现有 URL 和 Object key 兼容性。
