# 参与贡献

欢迎报告资源信息错误、改进页面体验、修复问题或补充文档。网站使用问题和资源纠错可以通过[意见反馈](https://rhythmarchive.github.io/feedback/)提交；代码问题和改进建议也可以在 GitHub Issues 中讨论。

## 开始之前

请描述问题页面、复现步骤、预期结果和实际结果。资源纠错最好附上游戏版本和可核对的来源。较大的功能、数据模型或部署改动，建议先开 Issue 讨论范围。

本仓库包含公开网站、Catalog、Stats Worker 和 Arcaea APK 自动更新器。私有提取工具、运维应用及游戏源输入不在这里，运行网站不需要它们。不要提交游戏安装包、个人存档、凭据、本机路径或临时报告。游戏素材的权利归原权利人所有；收录和公开访问不代表获得任意再分发许可。

## 本地运行

需要 Node.js 22.12 或更新版本，以及 npm。从自己的 fork 克隆仓库后，在仓库根目录执行：

```bash
npm ci
npm run site:dev
```

开发命令会从 Catalog 生成站点数据，再启动 Astro。默认图片来自公开对象存储，浏览器需要网络才能读取图片。统计服务不是运行静态站点的前提；本地 Worker 的启动方法见 [Stats Worker README](workers/stats/README.md)。

构建和预览：

```bash
npm run site:build
npm run site:preview
```

## 找到修改位置

| 内容 | 入口 |
| --- | --- |
| 页面、组件、浏览器交互 | `apps/site/src/` |
| Catalog、Browse 与更新记录 | `catalog/` |
| 数据类型、校验、存储 URL | `packages/domain/src/` |
| 公共数据生成 | `apps/site/scripts/` |
| 统计 API、D1 与提醒 | `workers/stats/` |

阅读[架构与开发说明](docs/development.md)、[数据模型](docs/catalog.md)、[界面设计](docs/site-design.md)和[更新记录模型](docs/update-timeline.md)。`apps/site/public/data/` 与 `apps/site/dist/` 是生成产物，修改源数据或生成器即可。资源身份、出处或公开权限不明确时，请先提供证据并讨论，避免用新 ID 替换既有资源或猜测元数据。

## 验证改动

选择与改动相关的检查，无需为纯文档改动构建全站：

| 改动 | 检查 |
| --- | --- |
| Markdown 文档 | `git diff --check`，检查相对链接 |
| 页面、样式、小功能或修复 | `npm run check:fast`；交互逻辑改动补充相关测试 |
| Catalog、Browse、更新记录 | `npm run update:fast`，生成并校验公开 registry |
| Stats Worker 逻辑或配置 | `npm run worker:check` |
| 仅公开 registry 数据 | `npm run stats:registry:check` |
| 共享契约、构建、Actions、基础设施或大规模数据变更 | `npm run ci:check` |

站点测试在 `apps/site/tests/`，Worker 测试在 `workers/stats/tests/`。单个站点测试可用 `node --import tsx --test apps/site/tests/<文件名>` 运行。回归测试应覆盖用户行为或数据契约。

## 提交 Pull Request

在自己的分支上完成修改，向本仓库的 `main` 提交 PR。说明解决的问题、最终行为及已执行的验证；涉及界面时附上必要截图，涉及资源时附上来源。让每个 PR 聚焦一个问题，避免混入格式化、缓存或无关数据变动。

贡献者不需要生产部署权限或维护者的私有工作区。合并后的发布由维护者负责，参见[维护者文档](docs/maintainers/README.md)。Coding Agent 使用 [AGENTS.md](AGENTS.md) 和已跟踪的 [Agent 技能](.agents/skills/update-timeline/SKILL.md)。
