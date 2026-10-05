# 更新记录

唯一来源是 catalog/updates/index.json，投影由 apps/site/src/lib/update-history.ts 生成。不要编辑 public/data、src/generated 或 dist。

准备本次 Catalog、Browse 和 Updates 时一起完成时间线，随后 update:fast、一个 commit、一次 push main。资源上传并验证本次新增对象即可准备公开记录，不需要等 Pages 部署成功。publishedAt 是本次内容更新时间，在首次提交前选择带时区 ISO 时间并固定；部署成功时间只用于验证，绝不写回源码。

游戏首次整体收录放 baselines，后续逻辑批次放 records。id 稳定且唯一；game 关联游戏；releaseIds 沿用既有批次来源标识，合并同批次多个 ID，但不要求生成或复制 Admin ReleaseManifest；kind 为 update；items 使用唯一的 Catalog resourceId 和 added/supplemented/replaced；contentVersion 仅填写来源明确的公开版本。

排除 metadata-only、排序变化、thumbnail/storage churn、UNCHANGED 和删除动态。每个 resourceId 只出现一次。页面显示更新 N 项，分类来自当前公开资源；后来隐藏的资源不得泄露到公开投影。

普通入口：npm run update:fast（registry 生成 + Catalog/引用/时间/唯一性/排序/Browse/registry 检查）。内容增加不修改硬编码数量、最新 ID 或部署时间测试。实现逻辑变化补一个目标测试；FULL 只遵循根 AGENTS 的明确风险条件。

## 发布后结束更新提醒周期

现有 Pages 工作流在 build 与 deploy 均成功后运行 resolve-reminders。仅 main 的 push 参与：对比 github.event.before 与此次发布提交的 catalog/updates/index.json，只选择新增 id、kind=update、items 非空且 publishedAt 晚于该游戏已有时间线的正式更新记录，按游戏去重。该记录就是现有内容更新流程的完成标记，必须与本次实际完成的 Catalog/Browse 更新一起提交；metadata-only、普通代码/样式提交、baseline、修改旧记录和历史补录不作为完成标记。其他游戏不受影响。失败部署、首次没有比较基线的推送和 workflow_dispatch 不执行自动 resolve；失败发布应重跑原来的 push 工作流。

收尾通过现有 Worker 管理 resolve API 完成，保留历史周期和邮件记录。结束周期后，下一次有效提醒自然建立新周期，周期计数从 1 开始，游戏累计有效提醒数继续保留。调用带 createdBefore，读取该 Actions run 所有尝试中第一次成功的 Pages deploy job 完成时间，仅结束该时间之前已存在的周期；发布进行中建立的周期也可正常结束，同一工作流重跑不会关闭成功发布之后新建的周期。该边界不改写内容 publishedAt，也不要求第二次提交。若多个游戏中只有部分 resolve 成功，重跑即可完成其余游戏，不会误关新周期。

一次性配置：在 Stats Worker Secret 和 GitHub Actions 的 stats-production Environment Secret 两处设置相同的 UPDATE_REMINDER_ADMIN_TOKEN。沿用 PUBLIC_STATS_API_URL 与现有 Worker 鉴权，无需 D1 migration、新增 Cloudflare API 权限或新队列。没有新正式更新的发布不需要此 Token；有更新但 Token 缺失/不一致或管理 API 失败时，收尾 job 明确失败，已成功的 Pages 发布不会回滚，周期不会被无鉴权关闭。修复配置后重跑该 push 工作流的失败 job。

首次提交前检查 baseline 排除、公开引用、批次详情路径和首页/updates 相同排序。Pages 自动构建部署后做一次简短确认，不补时间、不补记录、不扩散 Admin、不第二次 push。
