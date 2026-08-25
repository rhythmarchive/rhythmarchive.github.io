# 统一网站 UI 与搜索

## 触发条件

新增游戏页面、搜索、卡片、筛选、下载入口或需要迁移旧的 per-game 页面。

## 规则

- 优先修改共享 `BaseLayout`、`SearchBox`、`Gallery`、`ResourceCard`、`catalog-projection` 和配置；不要复制一套游戏页面。
- 游戏差异只通过 Game Config、PublicSiteData 和 browse projection adapter 表达。共享交互、状态、响应式布局、主题和下载动作保持一致。
- 搜索必须使用同一 `searchIndex`，同时服务全站搜索和游戏内搜索。
- 修改后运行 `npm run site:check`、`npm run site:build`、`npm run site:smoke`，必要时检查桌面和移动视口。
