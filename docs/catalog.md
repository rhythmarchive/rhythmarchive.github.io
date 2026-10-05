# Catalog 与公开数据

`catalog/index.json` 是公开资源的正式源数据。字段与校验定义在 [`schema.ts`](../packages/domain/src/schema.ts)，跨记录引用校验在 [`validation.ts`](../packages/domain/src/validation.ts)。候选提取清单与私有发布输入不是网站的直接数据源。

## 数据模型

| 实体 | 表达内容 | 身份与关联 |
| --- | --- | --- |
| Resource | 游戏中的逻辑资源、名称、别名、来源与生命周期 | 稳定 UUIDv7 |
| Variant | 同一资源的难度、活动等语义变体 | UUIDv7，引用 `resourceId` |
| Rendition | 某变体的原图、高清图、缩略图等文件用途 | UUIDv7，引用 `variantId` 和 `objectId` |
| AssetObject | 实际文件字节、格式、尺寸、大小及出处 | `sha256:<digest>`，含不可变 `objectKey` |

关联链为 Resource → Variant → Rendition → AssetObject。逻辑资源身份、字节身份、文件用途、下载文件名与公开 URL 各有职责：修改标题或下载名不需要更换资源 ID；相同文件可被多个 rendition 引用。UUID 保持详情链接稳定，SHA-256 标识内容，存储 URL 由对象键和公开存储地址构造。

`provenance` 记录来源及证据；来源不明确的版本或变体含义不应被当作已确认元数据。游戏标识受 `Game` 枚举与站点配置约束，新增游戏涉及契约和消费者适配，不只是增加字符串。

## Browse 与公共投影

`catalog/browse/` 补充游戏特有的曲目、分类、排序及展示语义。站点在构建时把这些数据与 Catalog 结合成 `PublicSiteData`、搜索索引、图库和下载投影，入口见 [`site-data.ts`](../apps/site/src/lib/site-data.ts)。浏览器消费投影，不直接消费提取器输出。

公共投影只包含可展示的资源、名称、别名、预览、下载和经确认的元数据。生成目录 `apps/site/public/data/` 与 `apps/site/dist/` 可以重建；数据纠错发生在源数据或投影逻辑中。

页面隐藏不等于保密：Git 中的 Catalog 本身公开，已知对象键也不能充当访问控制。绝对本机路径、凭据、私人输入和内部存储诊断不属于公开数据。真正私密的输入和对象位于公开仓库之外。

## 数据变更

元数据纠错尽量保留资源、变体及文件身份。新增资源需要可核对的出处和完整引用，避免为清理名称重新生成 UUID 或移动不可变对象键。现有检查覆盖 schema、稳定详情路由、Object/Rendition 引用、公共 URL、下载文件名与 Browse 投影。

Catalog/Browse/更新记录改动使用 `npm run update:fast`；仅检查公开 registry 使用 `npm run stats:registry:check`。时间线的批次语义见[更新记录](update-timeline.md)，上传和正式发布见[维护者发布说明](maintainers/publishing.md)。
