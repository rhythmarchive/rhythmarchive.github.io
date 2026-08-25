# Rhythm Assets Gallery v2

这是统一网站平台加游戏适配器项目。上游包体知识留在 Game Profile、Adapter 和 extractor；共享网站只消费 Catalog、PublicSiteData、Unified Manifest、Delta 和 SearchIndex。

## 不可违反的边界

- APK、AAB、安装目录、AssetBundle、Addressables 和用户原始资源永久只读；分析、候选、报告、截图、workflow state 和 scratch 只写仓库 temp/。
- 无人值守任务不执行 git push、生产发布、ROS/对象存储写入或删除、DNS/凭据修改、reset 或 clean。REMOTE WRITE 不是本地完成条件。
- Catalog、公开 URL、remote key 和 Object identity 是兼容边界；REMOVED 只进 Review/Storage Diff，不自动删除。

## Intent router

- 未注册 APK/安装目录/资源包 → .agents/skills/game-reconnaissance。
- reconnaissance 已完成、准备正式接入 → game-onboarding。
- 已有游戏新版本 → game-update；确定 Adapter 后的 probe/extract/normalize/validate/manifest → asset-pipeline。
- 手动文件、活动图、metadata、分类、variant、rendition 新增 → content-addition。
- NEW/CHANGED/REMOVED、rename、异常、AI 超分、最终批准 → human-review。
- Delta、Storage Diff、release prepare、上线前 dry-run → release-publishing；本地发布不等于生产发布。
- 网站原则、视觉基线、响应式、未来主题 → site-design；网站代码、共享路由、搜索、卡片、投影 → site-development。
- tests、typecheck、site check/build/smoke、workflow gate → validation-ci；历史 Phase、脚本、重复文档和删除审计 → repository-maintenance。

## 基本协作规则

先读 canonical docs 和对应 Skill，再检查 git status、现有 state、Profile、上一正式 Manifest 和真实测试。不要复制 per-game 页面，不要为了整洁重建 Catalog，不要把未知候选强行加入正式 Game registry。

修改后至少运行 npm run test:all、npm run site:check、npm run site:build、npm run site:smoke、git diff --check，并报告完整 git status。显式处理本次文件，禁止用 git add . 掩盖未知修改。

当前规则入口：docs/project-rules.md、docs/workflows.md、docs/architecture.md、docs/site-design.md 和 .agents/skills/。
