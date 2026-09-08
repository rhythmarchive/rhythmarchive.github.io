# Rhythm Archive

Rhythm Archive 是一个面向玩家的音游图片资源归档与下载站，使用 Astro 静态站点、共享 Catalog/PublicSiteData 投影和按游戏注册的适配器。网站提供游戏分类、曲绘与其他图片浏览、搜索、预览、原图/超分版本下载，以及必要的资源反馈入口。

## 开发入口

```text
npm ci
npm run site:dev
```

质量门禁：`npm run ci:check`。它覆盖类型检查、测试、站点检查与构建、smoke 和 Browse projection 校验。

## 文档入口

- [项目规则](docs/project-rules.md)
- [工作流](docs/workflows.md)
- [架构边界](docs/architecture.md)
- [站点设计](docs/site-design.md)
- [rhythmctl](docs/rhythmctl.md)

外部包体、候选资源和发布状态遵循仓库规则；源 APK、AssetBundle、Addressables 与用户原始资源始终只读。网站只消费经过验证的 Catalog 和公开投影，生产发布与远端对象写入不属于本地开发命令的默认副作用。
