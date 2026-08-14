# Phase 2A Fixture Coverage

## 1. 来源与原则

`fixtures/phase2a/real-cases.json` 来自 Phase 1 HANDOFF、关系审计和机器可读 audit JSON。它记录真实相对路径、hash、尺寸和证据；不把 unresolved 语义伪装成已确认 Catalog。`valid-catalog.json`、`valid-candidate-manifest.json`、`valid-candidate.json`、`valid-update-batch.json`、`valid-release-manifest.json` 和 `valid-publish-plan.json` 是可运行的最小合同样本；invalid fixtures 专门验证边界。

没有批量复制 `E:\曲绘`。图像转换 fixture 只复制一张历史 AI JPG 到 V2，再派生 PNG；源目录没有写入、改名、删除或批量转换。

## 2. 覆盖矩阵

| 风险/业务案例 | 真实证据 fixture | 验证重点 |
|---|---|---|
| 普通 Arcaea original + upscaled | `arcaea-acid-god-original-ai`，6.16.0 Acid God，768→3072，原/AI hash | 同 Variant 两个 Rendition；616/616 pairing 事实 |
| base + BYD 独立曲绘 | `arcaea-by-difficulty-markers` 的 Ignotus `_3`，另有 same-hash alias case | difficulty Variant 候选，不按 songId 压平 |
| 三视觉 Variant songId #1 | `arcaea-avril-three-variants`：base、`_0` PST、`_1` PRS | 至少三个原图 Variant，difficulty marker 进入 evidence |
| 三视觉 Variant songId #2 | `arcaea-stasis-three-variants`：base、`_0` PST、`_1` PRS | 同上，覆盖不同实际尺寸/命名 |
| `_0/_1/_2/_3` marker | `arcaea-by-difficulty-markers`：Ävril、Lucid Traveler、Ignotus | `_0` PST、`_1` PRS、`_2` FTR、`_3` BYD；不凭 metadata 生成 `_4` |
| `_256` | `arcaea-asgore-256-unresolved`，384×384 | `kind=unknown`、`semanticStatus=unresolved`、`_256_semantics` 保留 |
| 原图/AI 多尺寸配对 | Acid God、Ävril、Asgore `_256` 的真实 original/AI records；审计总计 616/616 | normalized filename pairing、`.jpg_opt.jpg` 命名和 source/upscaled provenance |
| 同 SHA-256 不同语义 | Phigros normal/April Fools After ZABANIYA，hash `20f080...` | 一个 shared Object、两个 semantic Resource，不自动 merge |
| alias/renamed resource | Ignotus Afterburn 与 BYD 长名，hash `12bda...` | alias candidate，不自动删除/合并 |
| Arcaea 短别名 | `Overdead..jpg`、`Ignotus Afterburn.jpg`、`Red and Blue and Green.jpg`、`Singularity VVVIP.jpg` | low/unknown mapping，人工补 external identity |
| Character portrait/avatar/LinkPlay | `10.png`、`10_icon.png`、`5_mp.png` | 三种 asset role，不当作 original/upscaled |
| Story CG | `Arcaea/剧情/epilogue/last1_c3_epilogue.jpg` | story provenance；缺 metadata 保持 unknown |
| Phigros 普通/改名/April Fools | Antithese metadata 缺失、Cipher renamed、Oblivion event | 稀疏 metadata、版本未知、event 分类人工确认 |
| `_optimization.png` workflow | V2-derived `Acid God_optimization.png`、`Transparent_optimization.png` | filename alias match、multiple attempts、alpha block/explicit flatten |

## 3. 测试覆盖

`packages/domain/tests/domain.test.ts` 覆盖：

- 合法 Resource、Variant、Rendition、Object、UpdateBatch、Candidate、ReleaseManifest、PublishPlan；
- 非法 ID、绝对路径、hash、schemaVersion/approval 失败；
- UUIDv7、Object hash/objectKey 和 filename-independent identity；
- 改名后 Candidate ID 不变；
- ambiguous/unmatched/multiple optimization outputs；
- `_256` unresolved、三变体案例、缺失 Phigros artist；
- same Object / different Resource；
- Catalog、ReleaseManifest、PublishPlan 外键和本机路径边界；
- Candidate/Batch 状态机和真实 workspace 目录；
- JPEG 转换、source PNG retain、透明 PNG block/explicit flatten。

## 4. 证据限制

真实 fixture 记录的是 Phase 1 已确认的路径/hash/尺寸和分类证据，不宣称完成 Legacy Migration，不宣称每个文件的精确 APK source version，也不把 `_256`、ETR、Phigros changed bundle 或剧情贴图关系定性为最终答案。所有这些继续作为架构审查问题。
