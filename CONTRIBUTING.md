# 日常维护

默认直接维护 main：确认子仓库和状态 → 标准 Git 同步 → 集中修改 → 必要检查 → 一个 commit → 一次 git push origin main。
普通更新不调用 gh、GitHub 插件或浏览器，不创建临时分支、PR 或 Review/Merge。Git 凭据独立于这些工具；Git 正常时不要调查它们的认证。

| 任务 | 本地入口 | main push 后 |
| --- | --- | --- |
| 页面/样式/普通 bugfix | npm run check:fast，行为变化补一个目标测试 | Pages 构建、traffic/smoke、部署 |
| 1～10 个资源/元数据/Browse/Updates | Tooling ros:delta 只验证新增对象；Public npm run update:fast | 内容不变量检查、Pages；registry 文件真实变化才部署 Worker |
| Stats Worker 逻辑/配置/D1 | worker:check | Worker 完整检查与部署、Pages |
| 共享 schema/domain、生成器/构建、Actions、基础设施、ROS/发布机制、大规模数据、明确全面审计 | ci:check 一次 | change-aware FULL CI（含一次构建） |
| 文档 | diff --check | 必要 Pages 构建；AGENTS-only 跳过 |

风险决定深度。最终验收、完整证据、更安全、发布一致性不是 FULL 触发条件。无关历史问题只记录；可靠验证已经成功时，不继续排查辅助 HTTP 客户端。

Catalog、Browse、Updates、publishedAt 必须在首次提交前完成。publishedAt 表示内容更新时间；Pages 成功时间只用于确认，不写回源码。普通成功更新不补发布记录、审计字段或 Admin 副本而第二次 push。第二次 push 只限真实失败、线上内容错误或用户明确要求。

Stats registry 用生成器维护，元数据时间戳不触发 Worker 部署。registry-only 不跑 Worker 的 D1、提醒、Turnstile、限流和排行逻辑测试。保持源输入只读，不重新证明旧 ROS 对象存在。

保留未提交改动；暂存明确路径，检查秘密/临时产物及 diff。不要 force push 或绕过保护；被拒绝时报告实际错误与 Settings → Rules → Rulesets，不自动改走 PR。高风险评审或用户明确要求时才选择 branch/PR。

复用依赖与共享 cache；正常成功只输出摘要。临时文件使用 marked Workspace runtime；完成调用 Tooling workspace-runtime finish，失败诊断七天过期，--keep/--debug 可明确保留。普通更新不生成永久 review/approval/evidence bundle。
