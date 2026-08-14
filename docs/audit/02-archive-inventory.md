# E:\曲绘 Legacy Seed 只读盘点

审计日期：2026-08-14  
来源：递归读取 E:\曲绘，没有移动、重命名、删除、压缩或写回任何源文件。

机器可读证据：

- docs/audit/data/archive-inventory.json
- docs/audit/data/archive-image-metadata.json
- docs/audit/data/archive-hashes.json
- docs/audit/data/published-assets-analysis.json

## 1. 总量和顶层结构

| 顶层目录 | 文件数 | 总大小 | 只读解释 |
|---|---:|---:|---|
| Arcaea | 2,176 | 2,334,175,354 B | 主体历史内容，含 2 个辅助脚本；不是带版本号的快照 |
| Arcaea（至6.16.0） | 128 | 58,292,029 B | 6.16.0 相关增量/补充目录，不是完整 Arcaea 快照 |
| Phigros | 502 | 844,741,037 B | 平铺历史内容，含 1 个压缩报告；没有版本目录 |
| 合计 | 2,806 | 3,237,208,420 B | 约 3.237 GB（十进制） |

真实文件类型：2,803 张图片、0 个 APK、3 个辅助文件。图片扩展名分布：

| 扩展名 | 文件数 | 总大小 |
|---|---:|---:|
| .jpg | 1,542 | 1,935,077,824 B |
| .png | 1,261 | 1,302,058,821 B |
| .py | 1 | 7,315 B |
| .bat | 1 | 63,692 B |
| .json | 1 | 768 B |

因此“APK 分布”在本目录中的结论是：没有 APK。旧项目的 APK 在另一个路径：E:\rhythm-assets-gallery\public\downloads\arcaea 里有一个 1,847,391,612 B 的 arcaea_6.14.12c.apk，另有一个同大小、无扩展名的 URL 编码样式文件；这不是 E:\曲绘 的内容。

## 2. 按游戏和类别分布

| 游戏/类别 | 文件数 | 总大小 |
|---|---:|---:|
| Arcaea / 曲绘 | 616 | 180,735,664 B |
| Arcaea / 曲绘（AI超分后） | 616 | 1,580,531,504 B |
| Arcaea / 曲包封面 | 195 | 49,407,355 B |
| Arcaea / 游玩背景 | 156 | 78,864,816 B |
| Arcaea / 角色/LinkPlay预览 | 148 | 98,107,902 B |
| Arcaea / 剧情 | 147 | 96,242,550 B |
| Arcaea / 角色/立绘 | 139 | 230,955,907 B |
| Arcaea / 角色/头像 | 130 | 8,492,506 B |
| Arcaea / LinkPlay贴纸 | 99 | 13,720,547 B |
| Arcaea / 启动页面 | 39 | 31,438,317 B |
| Arcaea / 世界模式 | 17 | 23,899,308 B |
| Phigros / 曲绘 | 320 | 772,516,236 B |
| Phigros / 头像 | 107 | 2,082,511 B |
| Phigros / 曲包封面 | 41 | 31,521,658 B |
| Phigros / April Fools | 33 | 38,619,864 B |

按目录直接观察到的结构：

    Arcaea/
    ├─ 曲绘/
    ├─ 曲绘（AI超分后）/
    ├─ 曲包封面/          游玩背景/          启动页面/          世界模式/
    ├─ 角色/立绘/         角色/头像/         角色/LinkPlay预览/
    ├─ 剧情/{cg,epilogue,finale,lephon,meeting,nihil,prelude,vs,zettai}/
    ├─ change.py
    └─ rename_script.bat

    Arcaea（至6.16.0）/
    ├─ 曲绘/              曲绘（AI超分后）/
    ├─ 曲包封面/          游玩背景/
    └─ LinkPlay贴纸/

    Phigros/
    ├─ 曲绘/              头像/              曲包封面/          April Fools/
    └─ 曲绘/phigros-compress-report.json

## 3. 目录形成过程的证据解释

### Arcaea 主目录

Arcaea 主目录含 603 张原始曲绘和 603 张 AI 曲绘，另外含完整的角色、剧情、背景、启动页、世界模式和曲包封面集合。它没有版本号，不能仅凭目录名确定最后对应哪一个游戏版本。

change.py 是一次性人工改名工具：它读取硬编码的 songlist.csv 和 D:\Files\arcaea，按文件名末尾 ID 匹配 songlist，并生成 rename_script.bat / rename_log.txt。批处理日志显示历史上 534/538 个条目匹配成功。它证明当前长文件名前缀来自人工/半自动整理，但不是 V2 可直接信任的 provenance。

### Arcaea（至6.16.0）

该目录只有 13 张原图、13 张 AI 曲绘、1 张曲包封面、2 张背景和 99 张 LinkPlay 贴纸，共 128 个文件。它是覆盖/增量集合，而不是从 APK 完整导出的 6.16.0 快照。把它与 Arcaea 直接合并会产生新旧内容、别名和版本来源混合；迁移时必须保留原始根目录作为 provenance。

### Phigros

Phigros 没有 3_19_2、3_19_3 等版本目录。phigros-compress-report.json 记录一次针对 3_19_3 输出目录的压缩操作：输入两个 *_optimization.png，输出两个 _opt.jpg，质量 95，删除原始优化文件。报告本身不证明整个 Phigros 目录都来自 3.19.3。

## 4. 版本、临时和异常目录判断

| 观察 | 证据 | 结论/置信度 |
|---|---|---|
| 有明确版本名的顶层目录 | 只有 Arcaea（至6.16.0） | HIGH：它是增量/补充目录，不是完整快照 |
| Phigros 版本 | 顶层无版本；压缩报告目标路径含 3_19_3 | MEDIUM：目录混合了多个时期，无法仅从目录确定每个文件版本 |
| 临时/发布 staging | 旧仓库存在 automation/incoming、logs、processed、rejected、.deploy-work；Legacy Seed 本身没有同名 staging 树 | HIGH：staging 主要在旧仓库，不应把 .deploy-work 当正式资源 |
| 人工超分 | Arcaea 有完整同名 AI 目录；Phigros 只有压缩报告，没有同规模 AI 目录 | HIGH |
| 备份/重复 | 发现 19 组精确重复哈希，39 个文件；同一图在不同逻辑目录/别名下重复 | HIGH：不能自动删除或直接合并 |
| APK 提取结果 | E:\曲绘 无 APK、无完整 assets 提取树 | HIGH |

## 5. 与旧站实际发布内容的交叉核对

旧站 public/assets 有 2,672 个文件，其中 2,670 个图片；public/data/arcaea-index.json + phigros-index.json 有 2,670 条记录。实际核对结果：

- 索引到文件、文件到索引均为 0 缺失。
- 0 个重复相对路径。
- 所有索引 ID 都符合当前 SHA-1(relativePath) 算法。
- public/assets 没有把 Arcaea（至6.16.0）作为一个独立根导入；因此 6.16.0 目录中的贴纸 99 张没有进入当前旧站索引。
- Archive 相比旧站，多出：6.16.0 目录的 99 张贴纸、13+13 张新曲绘、1 张封面、2 张背景，以及 Phigros 净新增约 5 个内容；这是“Legacy Seed 大于当前发布快照”的直接证据。
- Phigros 有 3 对“文件名变化但内容相同”的文件：Cipher、Labyrinth in Kowloon、Stardust；Archive 与 public 文件的 SHA-256 相同，只是特殊字符被旧流程改成了 %3A、%3C%7C 等形式。

## 6. 精确重复哈希的风险样本

19 组/39 文件的重复哈希中，典型情况包括：

- dropdead..._3.jpg 与 Overdead..jpg，原图和 AI 目录都各有同内容别名。
- Ignotus Afterburn.jpg 与带完整长前缀的 BYD 文件。
- Red and Blue and Green.jpg 与带长前缀的 BYD 文件。
- Singularity VVVIP.jpg 与带长前缀的 BYD 文件。
- 剧情/lephon、剧情/epilogue 内带不同前缀的相同 CG。
- Phigros 普通曲绘与 April Fools 下的两个同内容文件。
- Arcaea 启动页背景与世界模式图片存在同内容重复。

这些是“内容去重候选”，不是删除指令。迁移报告应同时保存 sourcePath、sha256、分类证据和人工合并结果。

