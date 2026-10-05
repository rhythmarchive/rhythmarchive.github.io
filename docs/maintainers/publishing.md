# 内容发布与维护

本文面向正式站点维护者。第三方贡献通过分支和 PR 参与，见[贡献指南](../../CONTRIBUTING.md)。提取、ROS 上传、私有运维应用与源输入由维护者在公开仓库之外管理。

## 日常流程

日常低风险维护使用 `main`：确认子仓库和 Git 状态 → `git fetch` / `git pull --rebase origin main` → 集中修改 → 必要检查 → 一个逻辑提交 → 一次 `git push origin main` → 自动部署 → 简短线上确认。保留无关改动，只暂存明确路径。高风险评审或明确要求时使用分支和 PR；保护规则拒绝推送时，查看实际错误及 Settings → Rules → Rulesets，不绕过保护或强推。

标准 Git 凭据独立于 gh、插件和浏览器登录；日常发布使用正常 Git 流程。维护者的私有工作区与 scratch 生命周期由工作区规则管理，不是公共项目的安装前提。

## 检查范围

| 变更 | 本地检查 |
| --- | --- |
| 文档 | `git diff --check` 与链接检查 |
| 页面、样式、小功能或修复 | `npm run check:fast`，行为变化补相关测试 |
| 普通资源、元数据、Browse、Updates | `npm run update:fast`；私有 Tooling 仅核验本批新增 ROS 对象 |
| 仅公开 registry 数据 | `npm run stats:registry:check` |
| Worker 逻辑、配置或 D1 | `npm run worker:check` |
| 共享契约、生成器、构建、Actions、基础设施、ROS/发布机制、大规模数据或明确全面审计 | `npm run ci:check` 一次 |

检查深度由实际改动决定。普通内容维护不要求历史对象全量校验、Admin 同步或独立发布证据包；后续文档修改不使已有代码验证失效。

## 内容与部署顺序

Catalog、Browse、Updates 与 `publishedAt` 在首次正式提交前一起准备。时间线规则见[更新记录模型](../update-timeline.md)。`publishedAt` 是内容更新时间，Pages 完成时间只用于验证；成功发布后不因时间戳、记录、审计字段或 Admin 副本再次提交。第二次推送用于真实部署失败、线上内容错误或明确要求。

Pages 工作流按变更选择检查。公开 registry、Worker 代码/配置或共享 UUID 运行代码变化才触发必要的 Worker 部署；纯时间戳、Browse、Updates 或页面修改不触发 Worker 部署。部署后 `/health.registryHash` 与生成的 registry 哈希匹配，再发布 Pages。registry 与对应 Catalog 一起提交，生成器维护的 registry 和公共投影不手工编辑。

## 更新提醒周期收尾

现有 Pages 工作流在 build 与 deploy 均成功后运行 `resolve-reminders`。仅 `main` 的 push 参与：比较推送前后 `catalog/updates/index.json`，选择新增 ID、`kind=update`、`items` 非空且 `publishedAt` 晚于该游戏已有时间线的记录，按游戏去重。该记录与实际完成的 Catalog/Browse 更新一起提交。

metadata-only、普通代码/样式提交、baseline、修改旧记录和历史补录不关闭周期。失败部署、首次没有比较基线的推送和 `workflow_dispatch` 不自动 resolve；失败发布应重跑原来的 push 工作流。

收尾调用现有 Worker 管理 resolve API，保留周期与邮件历史。`createdBefore` 使用该 Actions run 所有尝试中第一次成功的 Pages deploy job 完成时间，仅结束此时间之前已存在的周期；重跑不会关闭成功发布之后新建的周期。部分游戏失败时，重跑可完成其余游戏。

一次性配置：Stats Worker Secret 与 GitHub Actions 的 `stats-production` Environment Secret 设置相同的 `UPDATE_REMINDER_ADMIN_TOKEN`。沿用 `PUBLIC_STATS_API_URL`，无须新队列、D1 migration 或额外 Cloudflare API 权限。没有新正式更新时不需要此 Token；有更新而 Token 缺失、不一致或管理 API 失败时，收尾 job 失败，已成功的 Pages 发布不回滚，周期不会无鉴权关闭。修复后重跑该 push 工作流的失败 job。

关闭周期后，下一次有效提醒建立新周期，周期计数从 1 开始，游戏累计有效提醒数保留。Worker 配置与迁移见[运维说明](stats-operations.md)。
