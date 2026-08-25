# 新游戏首次接入

## 触发条件

用户要求分析并接入从未上架的游戏，或提供 APK、安装目录、AssetBundle、Addressables 数据并要求建立站点接入。

## 边界

- 源文件只读；先 probe，再把所有工作放入 `temp/`。
- “发现资源”不等于“发布资源”。用 Game Profile 的 `selectionPolicy` 固化收录类别，未选择类别保持在分析报告中但不进入正式 Catalog。
- In Falsus 的现有 Catalog 状态是历史基线；不要因为本 Skill 自动扩大其正式收录范围。

## 执行入口

1. `npm run rhythmctl -- games`
2. `npm run rhythmctl -- probe --game <id> --source <path>`
3. `npm run rhythmctl -- ingest --game <id> --source <path> --version <version>`
4. 复用 profile 中列出的 adapter/extractor，输出到 workflow state 对应的 `temp/rhythmctl/<game>/<version>/`。
5. `normalize` 后运行 `diff`、`review`，确认人工审核包，再由已有 publish dry-run 逻辑准备 ReleaseManifest。

不要在网站页面中加入新的 per-game 页面；新差异应留在 Profile/Adapter 或清晰的 browse projection extension point。
