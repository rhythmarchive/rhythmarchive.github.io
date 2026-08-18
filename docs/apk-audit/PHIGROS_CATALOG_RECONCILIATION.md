# PHIGROS_CATALOG_RECONCILIATION

本报告是只读审计输出。它不修改 `catalog/index.json`、生产 extractor、Phase 6/7、Gallery 或 Site。

## 1. Inputs and hashes

- Catalog: `E:\rhythm-assets-gallery-v2\catalog\index.json`; SHA-256 `a5733ec270d4871fb1de5102e6576a91785594fc721c90d0238ea9a6e2301dc4`。
- APK: `D:\Files\曲绘\Phigros\APK\Phigros_3.19.5.apk`; SHA-256 `b9654316e52bf2d410fa2ecb3f0df41246afdc3dc8133456deaff07ecbcf28bf`。
- Addressables/Unity relation input: `.runtime/apk-audit/data/phigros-3195/relations/phigros-track-records.csv`。
- APK image evidence: `assets/aa/Android/*.bundle` 中按 Addressables relation 定位的 `Texture2D`；脚本只在内存中读取，不写出游戏图片。

## 2. Counts

| Scope | Count | Interpretation |
|---|---:|---|
| Formal Phigros Catalog resources | 501 | 包含曲绘、April Fools、头像、曲包封面 |
| `resourceType=jacket` | 320 | 普通/历史曲绘资源集合 |
| `resourceType=phigros-april-fools` | 33 | 独立 special 资源集合；不强行当普通 Track |
| Current APK Track records | 319 | `Assets/Tracks/*` relation CSV 中的 Track records |
| Current APK primary `Illustration.jpg` slots | 313 | 主语义 artwork slot |
| Current APK Track records without primary Illustration | 6 | 不是缺失 Catalog jacket 的自动结论 |

### Catalog → APK

| matchStatus | Count | Meaning |
|---|---:|---|
| confirmed | 25 | full decoded pixel equality |
| high | 289 | near-identical decoded image under audit threshold |
| medium | 0 | candidate only |
| ambiguous | 0 | near tie or unresolved collision |
| unmatched | 39 | no accepted current Track image relation |

| semanticStatus | Count |
|---|---:|
| april-fools-artwork | 33 |
| current-track-artwork | 313 |
| historical-artwork | 7 |

### APK → Catalog

| coverageStatus | Count |
|---|---:|
| covered | 312 |
| multiple-catalog-matches | 1 |
| ambiguous | 0 |
| missing-from-catalog | 0 |

## 3. What was matched

匹配先使用 Catalog provenance 对应的本地源图，再与 APK `Illustration.jpg` 的 Texture2D 解码 RGB 进行比较。比较记录了完整解码像素 SHA、32×18 归一化 hash，以及 128×68 RGB MAE。
- `confirmed`: 完整解码 RGB pixel SHA-256 相同。
- `high`: 128×68 RGB MAE ≤ 2.0，并且没有近似同分候选。
- `medium`: MAE ≤ 8.0 但证据不足以确认。
- pHash 未被用作 Confirmed；标题/艺术家只作为解释和 review evidence，不能单独确认。
- `IllustrationBlur.jpg` 与 `IllustrationLowRes.jpg` 只记录为同一 Track illustration 的 derived rendition-like resources，没有生成独立 Catalog artwork slot。
- Reverse coverage closes at 313 primary slots: 0 missing, 0 ambiguous, 1 multiple-match slot。本轮未发现有证据支持的明显错误挂载。

## 4. 319 Track / 313 Illustration difference

当前 APK 的 319 行 Track relation 中，313 行有主 `Illustration.jpg`。其余 6 行不是普通 Track 缺图猜测，而是 `Random.SobremSilentroom.1..6`。它们都有 music 与 EZ/HD/IN chart，但没有 `Illustration.jpg`、Blur 或 LowRes；`.0` 才有主 Illustration。这个家族的末尾数字保留为 source key index，不提升为正式稳定 song ID。

`Introduction` 也不符合 `<title>.<artist>.<index>` 文件夹模式，但 APK 直接提供 `Assets/Tracks/Introduction/Illustration.jpg`、Blur、LowRes、music 和 `Chart_EZ.json`，同时存在 `avatar.Introduction` 与 `LevelMod/Introduction` key。因此它是一个有可播放/结构化资源的系统或教程 Track candidate；本报告保留它，但不把它强行变成普通 title.artist.index identity。

## 5. Special charts

- `Chart_EZ_Error`、`Chart_HD_Error`、`Chart_IN_Error` 均通过 Addressables 指向 `Assets/Tracks/望影の方舟Six.SeURa.0/`，作为 special chart variant。它们不改变普通 EZ/HD/IN 的结构存在性判断，也不创建 artwork Variant。
- 当前发现 4 个 `Chart_Legacy.json` relation；Legacy 在本报告中保留为 special chart metadata，不默认解释成普通永久难度。

## 6. April Fools / special Catalog

Catalog 中有 33 个 `phigros-april-fools` Resource。它们的 provenance 均为 `Phigros/April Fools/...`，与普通 `jacket` 分开统计。即使某个 special 源图与当前 Track Illustration 像素相同，reconciliation 仍保留 `semanticStatus=april-fools-artwork`，不把它改写成普通 Track artwork。没有可靠 Track relation 的 special 资源保持独立/未解析。

## 7. Display metadata review

Catalog `displayTitle` 与 Addressables key 解析出的 `sourceTitle` 分开保存。source title/artist 来自 `Assets/Tracks/<...>` logical key，不被自动升级为玩家侧 canonical title。

| comparison | Count |
|---|---:|
| exact | 130 |
| normalized-equivalent | 166 |
| different-but-likely-corrected | 17 |
| suspicious | 0 |
| unresolved | 7 |

对已通过图像证据关联的资源，人工 Catalog displayTitle 在公开显示上通常比压缩/拼接后的 source key 更合适；但 `different-but-likely-corrected` 只是保留人工修正的审计意见，不是自动覆盖指令。

## 8. Duplicate and canonical candidates

检测到 2 个 duplicate candidate pair，详情在 `data/phigros-duplicate-candidates.csv`。它们区分 exact object、decoded pixel 和 visual candidate；binary dedup 不等于 semantic merge。对于同一个 APK Illustration slot 的多个 Catalog Resource，输出 `canonicalCandidate` 仅为建议，未删除或合并任何 Resource。

## 9. Browse projection preview

`data/phigros-track-browse-projection.preview.json` 按当前 319 Track records 生成，只引用已有 Catalog Resource ID。`displayLevel` 与 `chapter` 全部保持 `null`；`sourceIdentityCandidate` 仍是当前单 APK 的候选，不是已晋升的正式 externalIdentity。普通 Track 有主图且反向 coverage 为 covered 时，Track-centric browse projection 已具备审计级数据基础；Random family、Introduction、April Fools 与 special charts 需要显式展示为特殊/不完整状态。

## 10. Production boundary and recommendation

本轮没有修改 Catalog、Resource/Variant/Rendition/Object、extractor、Phase 6/7、Gallery、Site 或下载链接。

建议下一阶段以 Track-centric browse projection 作为 Phigros 的产品入口，同时保留 Catalog Resource identity。首版公共字段应允许 `displayTitle`、source title/artist、Illustration Resource、difficulty structural presence；`displayLevel`、chapter/collection、正式 stable track identity 继续 nullable/unresolved。等待第二份 APK 做 cross-version validation 后，再决定是否把完整 Track path 或 Addressables key 晋升为正式 identity。

## 11. Unresolved

- 当前只有一个本地 Phigros APK，无法证明 Track path、末尾 index 或 Addressables key 的跨版本稳定性。
- Display Level numeric values 尚未从当前 APK 的高层数据恢复，preview 不填 Wiki 值。
- Chapter/Collection 的 IL2CPP class structure 已知，但 Track → Chapter instance relation 未恢复。
- April Fools special source 与普通 Track 的部分语义 relation 仍没有 APK 内外键，未强行填充。
