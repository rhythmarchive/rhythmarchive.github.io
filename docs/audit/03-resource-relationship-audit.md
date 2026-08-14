# Resource / Variant / Rendition 关系审计

## 1. 结论先行

初步模型被真实数据部分支持，而且比直接使用旧 AssetItem 模型明确得多：

- 原图与 AI 超分文件确实是同一语义曲绘的不同文件 rendition：Arcaea 主目录 603 对、6.16.0 增量目录 13 对，合计 616 对；按文件名归一化可 100% 配对，精确内容哈希则 616 对全部不同。
- 但 songId 不是 Resource 主键：一个 songId 可以对应多个真正不同的原图变体；同一内容也可能有多个文件名别名。
- 因此 V2 至少需要“语义图片 Resource + 内容/难度 Variant + 文件 Rendition + provenance/alias”四类信息，不能只把旧目录名映射成三层。

## 2. 原图 ↔ AI 超分配对

### 使用的方法

旧详情页与本轮审计使用同一类归一化思路：

1. 去掉最后一个扩展名。
2. 去掉 .jpg_opt、_opt、_optimization 后缀。
3. NFC 归一化并小写。
4. 在同一游戏、同一根目录、曲绘 与 曲绘（AI超分后）之间按键配对。

结果：

| 根目录 | 原图 | AI | 唯一归一化键 | 原图配对率 | AI 配对率 |
|---|---:|---:|---:|---:|---:|
| Arcaea | 603 | 603 | 603 | 100% | 100% |
| Arcaea（至6.16.0） | 13 | 13 | 13 | 100% | 100% |
| 合计 | 616 | 616 | 616 | 100% | 100% |

哈希证据：2,803 张 Legacy 图片全部计算 SHA-256；616 个一对一原图/AI 配对中，sameContentCount=0、differentContentCount=616。这符合“同一语义图的另一文件版本”，不符合“重复文件”。尺寸也强烈支持这一点：全库最常见的 768x768 有 570 张，3072x3072 有 571 张；主曲绘中通常原图是 768x768、AI 是 3072x3072。

### 异常

配对率为 100% 只说明当前命名规则下没有单边 rendition，不说明每个文件都是唯一内容。精确重复哈希发现若干别名：

- dropdead..._3 与 Overdead.. 的原图、AI 文件分别同内容。
- Ignotus Afterburn、Red and Blue and Green、Singularity VVVIP 与带 metadata 长前缀的文件同内容。

所以应把“配对”与“去重”分开：先建立 rendition pair，再把同哈希文件记录为 alias/candidate merge，不要静默删除。

## 3. 同一 songId 的多个真正不同曲绘

旧站 603 张原始 Arcaea 曲绘中：

- 592 张有非空 songId，11 张 legacy 文件无法被当前 filename parser 可靠映射（例如 Overdead..jpg、Ignotus Afterburn.jpg 一类短别名）。
- 有 530 个非空 songId 值。
- 55 个非空 songId 拥有多个原始曲绘文件；7 个 songId 各有 3 个原始变体，48 个各有 2 个。
- 典型 3 变体：avril、ii、prism、protoflicker、stager、stasis、tothefurthestdream，其文件名是 ..._0、..._1、..._base。
- 典型 2 变体：普通/base 与 BYD _3，例如 antithese、eccentrictale、ignotus、kyogenkigo 等。
- asgore 同时有普通文件与 _256 文件；当前 extractor 明确排除 _256，但历史发布内容保留了它。这是“当前提取目标不等于历史全量”的实例。

结论：songId 适合作为外部歌曲身份，不能直接作为 Resource ID。最小 Variant identity 至少需要：songId + assetRole(jacket) + sourcePath/filename variant key + difficulty/source marker；最后仍应保留内容哈希来检测冲突。

## 4. PST/PRS/FTR/BYD/ETR 命名和数量

按原始文件名末尾 _0 到 _4 检测，主 Arcaea Legacy Seed 有 57 个独立难度文件：

| 后缀 | 难度 | 原图文件数 | 原图+AI 索引记录数 |
|---|---|---:|---:|
| _0 | PST | 7 | 14 |
| _1 | PRS | 7 | 14 |
| _2 | FTR | 1 | 2 |
| _3 | BYD | 42 | 84 |
| _4 | ETR | 0 | 0 |
| 合计 |  | 57 | 114 |

重要区别：bydVersion/etrVersion 是歌曲 metadata 里存在对应谱面，不代表这张文件就是独立 BYD/ETR 曲绘。当前索引中 difficulty 只有 114 条记录，ETR 为 0；不能由“有 ETR metadata”自动创建 ETR Variant。

## 5. Phigros 关系

当前数据没有与 Arcaea 类似的 AI 超分目录。Phigros/曲绘 320 张、头像 107 张、曲包封面 41 张、April Fools 33 张；旧站发布快照的曲绘为 315 张，Archive 与 public 之间有 3 对改名但同 SHA-256 的文件，以及净新增约 5 个内容。

Phigros April Fools 中至少两张与普通曲绘精确重复（After ZABANIYA、Oblivion）。这可能是展示场景/分类差异，也可能只是重复备份；V2 应将 seasonal/event 作为分类/provenance 候选，不直接把它们合并为同一 Resource。

## 6. 角色资源应如何区分

Arcaea extractor 和 scanner 的路径语义相对清楚：

| APK/历史路径语义 | Legacy 类别 | 当前数量 |
|---|---|---:|
| char/1080/... | 角色/立绘 | 139 |
| char/*_icon | 角色/头像 | 130 |
| char/*_mp | 角色/LinkPlay预览 | 148 |
| img/multiplayer/stickers | LinkPlay贴纸 | 99（仅 6.16.0 增量目录） |

索引中角色相关字段覆盖约 98 个唯一角色 metadata ID，characterVariant 有 14 个非空变体值。完整立绘、头像、LinkPlay 预览不是简单的 rendition：它们通常是不同用途/裁剪/布局，应首先建模为 assetRole 或不同 Variant，而不是互相标记为 original/upscaled。

## 7. 剧情、背景和次要资源

- app-data/story/cg 进入剧情 CG；app-data/story/vn/res 和 img/story 进入 剧情贴图。当前 Archive 的 147 张剧情图实际按 剧情/{cg,...} 存储，报告中没有独立 剧情贴图 文件，因此“源码支持该分类”不等于“Legacy Seed 有该类样本”。
- story2/ordering、entries_main、entries_side 可提供 story path、node、type、act、关联歌曲和角色。当前索引有 228 个 story node metadata，但只有少量文件记录真正有 story 字段；缺失应保留为 unknown，不应填空猜测。
- Arcaea 背景 156 张、启动页 39 张、世界模式 17 张。旧详情页用 bg 文件名归一化后链接背景，背景详情页反向推荐使用该背景的原始曲绘。
- 旧站将所有这些资源平铺成 AssetItem，但它们的 canonical identity 不同；V2 应用 assetRole/resourceType 明确区分 jacket、background、story-cg、story-texture、character-portrait、avatar、sticker、pack-cover、startup、world。

## 8. 对 V2 三层模型的建议性修正

建议保留用户提出的概念，但加两条边界：

    Resource（语义上同一张可展示图片）
      └─ Variant（内容/来源/难度/事件确实不同的视觉变体）
           └─ Rendition（original、AI、thumbnail、压缩或其他文件表现）
                └─ Object/provenance（sha256、objectKey、源 APK/路径、人工决策）

- 原图与 AI：同一个 Variant 下的两个 Rendition，renditionType=original|ai-upscaled。
- ..._base、..._0、..._1、..._3：同一歌曲下的不同 Variant 候选；是否都是独立语义图由文件名、metadata、预览共同确认。
- 同 SHA-256 的别名：作为多个 provenance/alias 指向一个内容对象，是否共用语义 Resource 需要人工确认。
- songId、characterId：作为外部 identity，不直接替代内部 Resource ID。
- Phigros 无 AI 配对和丰富 metadata，不能强行套 Arcaea 的 difficulty/rendition 规则。

CONFIDENCE：HIGH（Arcaea 原图/AI 配对、尺寸、哈希、特殊后缀、角色路径）；MEDIUM（Phigros 历史目录形成过程、部分 alias 的业务语义）；LOW（没有实际 APK/源图上下文时，对某些剧情贴图、_256、ETR 是否对应独立游戏语义的最终判定）。

