# Rhythm Assets Gallery v2

## 高优先级规则

- 这是“统一网站平台 + 游戏适配器”项目。网站层只消费 Catalog、PublicSiteData、统一 Manifest/Delta，不把 APK、AssetBundle 或具体游戏包体逻辑放进共享页面。
- 外部 APK、安装目录和原始资源默认永久只读。所有分析、提取、候选文件、报告和 workflow state 只能写入仓库 `temp/`；不要在源目录写缓存。
- 无人值守本地任务不得执行 `git push`、生产发布、ROS/对象存储上传或删除、DNS/凭据修改，也不得使用 reset/clean 覆盖用户数据。
- 正式 Catalog 和公开 URL/remote key 是兼容边界。迁移时优先复用现有数据和稳定 Object identity，不做无证据的大规模移动。
- 新游戏先走 `npm run rhythmctl -- probe/ingest/extract/normalize/diff/review/check-approval`；已有游戏更新优先复用 profile/adapter 和上一正式 Manifest，只在 adapter 失效时重新侦察。
- `REMOVED` 只进入人工审核和 storage diff，不自动删除远端内容。release prepare 必须是本地 dry-run，并且通过审核 gate。
- 修改后至少运行 `npm run test:all`、`npm run site:build`、`npm run site:smoke`；检查 `git diff --check` 和完整 `git status`。显式添加本次文件，禁止用 `git add .` 掩盖未知修改。

具体流程见 `.agents/skills/` 和 `docs/unified-platform.md`。
