# 贡献与 Git 工作流

日常低风险改动默认在 `main` 上完成，不必为了形式创建功能分支或 Pull Request。适用范围包括常规资源与 Catalog/元数据更新、页面样式、小功能、普通 bugfix、文档和脚本维护。

## 日常流程

1. 用 `git rev-parse --show-toplevel` 确认仓库，再用 `git status --short --branch` 查看分支和工作区。保留已有的无关改动，不要重置、清理或纳入本轮提交。
2. 在干净的 `main` 上工作。若本地 `main` 落后于 `origin/main`，且同步不会影响用户改动，先运行 `git pull --rebase origin main`。当前处于其他分支时，保留该分支；只有确认工作区干净且没有本地工作会丢失时才切回 `main`。
3. 按改动风险运行必要检查。文档改动通常只需检查 diff；代码、Catalog 和资源更新运行相关生成器、目标测试或受影响子系统检查。不要仅因即将 commit 或 push 就运行全量套件。
4. 用 `git add -- <明确路径>` 暂存本轮文件，检查 staged diff、敏感值、临时文件、大型中间产物和未跟踪文件，再制作一个清晰、范围单一的 commit。
5. 规则允许时运行 `git push origin main`。普通站点更改由 `.github/workflows/pages.yml` 在 push 后完成完整检查和 Pages 部署；不需要另行手动部署。`.github/workflows/quality.yml` 为 Pull Request 提供 `check` 状态检查。

直接 push 必须遵守 GitHub ruleset 和 branch protection。若规则拒绝更新 `main`，不要绕过规则，也不要为了让 push 成功而自动改走 PR；报告触发的规则及 `Settings → Rules → Rulesets` 中需要由仓库所有者调整的设置，然后停止远端写入。

## 应使用分支和 PR 的改动

以下情况优先使用独立分支，并在合适时通过 PR 合入 `main`：

- 大规模重构或跨多个核心模块的架构修改。
- GitHub Actions、部署链路或发布机制的重大修改。
- Cloudflare Worker、后端、权限或安全方面的重要修改。
- 可能造成大量数据变化或不可逆影响的操作。
- 实验性且结果明显不确定的修改。
- 用户明确要求使用 branch 或 PR。

根据风险、影响范围和可回滚性判断；仅仅文件较多不构成必须使用 PR 的理由。高风险改动仍须运行与其风险相称的检查；普通 commit 或 push 本身不触发全量测试。
