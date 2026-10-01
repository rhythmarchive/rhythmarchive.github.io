# 更新记录

唯一来源是 catalog/updates/index.json，投影由 apps/site/src/lib/update-history.ts 生成。不要编辑 public/data、src/generated 或 dist。

准备本次 Catalog、Browse 和 Updates 时一起完成时间线，随后 update:fast、一个 commit、一次 push main。资源上传并验证本次新增对象即可准备公开记录，不需要等 Pages 部署成功。publishedAt 是本次内容更新时间，在首次提交前选择带时区 ISO 时间并固定；部署成功时间只用于验证，绝不写回源码。

游戏首次整体收录放 baselines，后续逻辑批次放 records。id 稳定且唯一；game 关联游戏；releaseIds 沿用既有批次来源标识，合并同批次多个 ID，但不要求生成或复制 Admin ReleaseManifest；kind 为 update；items 使用唯一的 Catalog resourceId 和 added/supplemented/replaced；contentVersion 仅填写来源明确的公开版本。

排除 metadata-only、排序变化、thumbnail/storage churn、UNCHANGED 和删除动态。每个 resourceId 只出现一次。页面显示更新 N 项，分类来自当前公开资源；后来隐藏的资源不得泄露到公开投影。

普通入口：npm run update:fast（registry 生成 + Catalog/引用/时间/唯一性/排序/Browse/registry 检查）。内容增加不修改硬编码数量、最新 ID 或部署时间测试。实现逻辑变化补一个目标测试；FULL 只遵循根 AGENTS 的明确风险条件。

首次提交前检查 baseline 排除、公开引用、批次详情路径和首页/updates 相同排序。Pages 自动构建部署后做一次简短确认，不补时间、不补记录、不扩散 Admin、不第二次 push。
