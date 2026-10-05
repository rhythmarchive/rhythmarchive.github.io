# 更新记录模型

网站首页与更新页共用 `catalog/updates/index.json`，投影实现是 [`update-history.ts`](../apps/site/src/lib/update-history.ts)。记录反映公开内容的变化，不是部署日志。

## 文件与字段

顶层 `schemaVersion` 为 `1`，包含 `baselines` 与 `records`。游戏首次整体收录放入 `baselines`；后续公开内容的逻辑批次放入 `records`。

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定且唯一的批次标识 |
| `game` | 关联游戏 |
| `releaseIds` | 既有来源批次标识；同一逻辑批次可以关联多个 ID |
| `publishedAt` | 带时区的 ISO 内容更新时间，在首次提交前确定 |
| `contentVersion` | 有明确来源的收录内容版本，可省略；不代表官方最新版本 |
| `kind` | 后续正式更新使用 `update`；`baseline` 不进入更新动态 |
| `items` | 更新项，含 Catalog `resourceId` 与 `change` |

`change` 取 `added`、`supplemented` 或 `replaced`。每个批次的 `resourceId` 唯一；资源必须属于该游戏。baseline 不要求 `kind` 或 `items`。`releaseIds` 用于关联来源，不要求贡献者访问私有发布清单。

## 记录语义与展示

记录与对应 Catalog、Browse 内容一起准备。纯元数据纠错、排序调整、缩略图或存储整理、未变化资源及删除操作不形成内容更新动态。`publishedAt` 表达内容更新时间，Pages 部署完成时间只用于验证发布，不能替代它。

公共投影仅展示当前公开且属于该游戏的资源；之后隐藏的资源不会透出元数据。页面显示的“更新 N 项”来自投影后的资源，分类也来自当前公开数据。首页与更新页复用相同时间线和排序。

`npm run update:fast` 检查引用、时间、唯一性、排序、Browse 与 registry；投影逻辑改动可运行 `apps/site/tests/` 下相关测试。生产发布及提醒周期的自动收尾见[维护者发布说明](maintainers/publishing.md)。
