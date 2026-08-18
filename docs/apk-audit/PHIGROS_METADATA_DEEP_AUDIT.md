# Phigros Targeted Metadata Deep Audit

本报告只处理高层 metadata、章节关系、谱面存在性和 identity。它不是上一轮 Texture2D/Sprite/UI/Shader 全量审计的重写。所有结论来自本地 `Phigros_3.19.5.apk`、已有 APK inventory、Addressables 索引和本轮 IL2CPP metadata table reader；没有修改 APK、Catalog、extractor、Gallery 或网站。

## 1. 输入与证据边界

| 项目 | 值 |
| --- | --- |
| APK | `D:\Files\曲绘\Phigros\APK\Phigros_3.19.5.apk` |
| package | `com.PigeonGames.Phigros` |
| version | `3.19.5 / 153` |
| SHA-256 | `B9654316E52BF2D410FA2ECB3F0DF41246AFDC3DC8133456DEAFF07ECBCF28BF` |
| ZIP entries | 3,163 |
| Unity | 2022.3.62f2（UnityFS header、SerializedFile、bundle engine string 交叉确认） |
| scripting | IL2CPP；不是可直接读取的 Mono build |
| IL2CPP metadata | `assets/bin/Data/Managed/Metadata/global-metadata.dat`，10,310,628 B，magic `0xfab11baf`，metadata version 31 |
| native IL2CPP | `lib/arm64-v8a/libil2cpp.so`，66,634,792 B，ELF；SHA-256 `ea6c7f99f195450f92058abe0d03a4b97d20fd375ee46ff137ba478ba27d5be5` |
| Assembly-CSharp.dll | 不在 APK ZIP 中；`link.xml`/ScriptingAssemblies 中的名称是构建/保留证据，不是 APK 内程序集文件 |

Source: `data/phigros-manifest.json`, `data/phigros-il2cpp-metadata-summary.json`, `data/phigros-unity-scan-summary.json` and the APK ZIP itself. The APK was read directly; extracted/recombined temporary files are not source-of-truth.

## 2. IL2CPP metadata recovery

本轮使用 `.runtime/apk-audit/scripts/phigros_targeted_metadata.py` 的局部 table reader：

- metadata v31 `Il2CppTypeDefinition`：88 B；
- `Il2CppMethodDefinition`：36 B；
- `Il2CppFieldDefinition`：12 B；
- 读取 type/field/method name、range、token，不做完整 native method address dump；
- 输出 `data/phigros-il2cpp-types.csv`、`data/phigros-il2cpp-string-matches.csv` 和聚焦的 `data/phigros-high-level-class-evidence.csv`。

解析结果包含 12,161 个 type definitions、122,436 个 method definitions 和 54,810 个 field definitions 的表级计数。相关类型本身是 **Confirmed**；它们的运行时序列化实例值仍受 Unity custom MonoBehaviour typetree 不完整限制。

关键类型证据：

| type | recovered fields / methods | audit meaning | confidence |
| --- | --- | --- | --- |
| `Chapter` | `chapterCode; songInfo; unlockInfo` | 章节对象的结构级入口 | High |
| `ChapterSongInfo` | `title; subTitle; banner; songs`; getter/setter for `songsBypassLimited` | 章节歌曲集合结构，`songs` 不是猜测出的目录顺序 | High |
| `ChapterSongItem` | `songsId; unlockType; unlockInfo; secretType; secretInfo` | Track→chapter 外键候选字段是 `songsId` | High |
| `ChapterInfo` | `chapterCode; songInfo; unlockInfo; coverAssetCode; ...` | 章节选择/UI 控制器和封面引用 | High |
| `CollectionSong` | `index; chapterTitle; allNum; collectedNum; ...` | Collection UI/进度模型；不是已恢复的全曲目表 | High |
| `SpecialSongNameReplacement` | `songId; replacementObject` | 特殊标题替换机制的结构证据 | High |
| `SongListItem` | `songName; difficulty; locked; ...`; `SetRating`; `SetRatingWithScore` | 选曲 UI 有等级显示流程，但本轮未恢复数值来源 | High |
| `LevelInfo` | `mainObject; level; difficulty` | UI 等级/难度字段候选 | High |
| `Chart` | `formatVersion; offset; judgeLineList`; `GetNoteCount` | Chart JSON/model 结构；不含 Display Level | High |
| `SortBySongBase` | `songData` | 选曲排序对象候选 | High |
| `IdBuilder` | `BuildCoverImageId`; `BuildBlurImageId`; `BuildLowResImageId`; `BuildBackgroundImageId` | 资源 ID 构造 helper；不是已证明的 domain song ID | High |

`ChapterSongItem.songsId` 是本轮最重要的章节关系发现，但没有在 3,163-entry APK 的可读 serialized instance 中恢复对应的值列表。因此不能把任意 `Assets/Tracks` 目录填入某个章节。

## 3. Display Level

### 3.1 结论

**Display Level：Partial structure evidence / unresolved values。**

已经恢复：

1. `LevelInfo.level` 与 `LevelInfo.difficulty` 字段；
2. `SongListItem.SetRating`、`SetRatingWithScore` 方法；
3. `SongListItem.difficulty` 和 `ratingDisplayController` 字段。

尚未恢复：

1. 319 个 Track × EZ/HD/IN/AT/Legacy 的静态等级数字；
2. 从某个 Track identity + difficulty 到 `LevelInfo.level` 的序列化实例关系；
3. 玩家显示值与任何 internal constant 的独立映射。

Chart TextAsset 不是等级来源。`data/phigros-chart-schema-stats.json` 的 1,008 条 chart 记录 root fields 只有 `formatVersion`、`offset`、`judgeLineList`；`level`、`rating`、`constant` 都是 0 条 root/nested 字段。Chart 中可确认的是 judge-line 内的 BPM 集合，不是显示等级。

因此当前 audit 不写 `levelEZ` 等数值，保留空值并写 `displayLevelConfidence=partial-unresolved`。这不是“游戏没有等级”，而是“本轮静态资源中只恢复到 UI/model 字段，未恢复每曲每难度的实例数据”。

Source paths: `assets/bin/Data/Managed/Metadata/global-metadata.dat`（type/field/method table）；`assets/Tracks/<track>/Chart_*.json`（schema）；`data/phigros-track-metadata.csv`、`data/phigros-high-level-class-evidence.csv`。Confidence: **High** for field existence, **Unresolved** for values.

### 3.2 Internal Constant

**Internal Constant：Not found。**

本轮搜索了 Chart JSON root/nested fields、Addressables key、Track record、IL2CPP type/field/method names和可读 metadata strings；没有找到可可靠归属到曲目/难度的 constant 字段。不能从 BPM、note count 或外部曲目表推导。

## 4. Track → Chapter / Collection

### 4.1 已恢复的结构

```text
Chapter
├─ chapterCode
├─ songInfo
│  └─ songs[]
│     └─ ChapterSongItem.songsId
└─ unlockInfo

ChapterInfo
├─ chapterCode
├─ coverAssetCode
└─ UI / unlock / title / subtitle fields
```

这是 APK 代码 metadata 给出的结构，不是根据章节封面名字反推的模型。`ChapterSongItem` 还包含 `unlockType`、`secretType` 等字段，说明“是否可见/如何解锁”可能与歌曲集合同时存储。

### 4.2 尚未恢复的关系

`data/phigros-chapter-cover-records.csv` 有 89 个 `Assets/Tracks/#ChapterCover/*` cover records；Addressables 也有 `ChapterSelector`、`Phigros2/Chapter8/Chapter8SelectMusic` 等 scene/key evidence。但这些只是 cover/scene 资源，未提供 319 个 Track folder 到 `chapterCode` 的实例外键。

因此：

- `Chapter` / `Collection` 结构：**High**；
- `Track → Chapter` 实际关系：**Unresolved**；
- 用封面、资源顺序、目录顺序人工补齐：**禁止**；
- 当前建议的产品词：先使用中性的“章节/合集”内部术语；在真实 `chapterCode` 与 `songsId` 值恢复前，不把它发布为正式“曲包”Facet。

## 5. Track resource model

当前 APK 中最可靠的资源关系为：

```text
Assets/Tracks/<title>.<artist>.<index>/
├─ Illustration.jpg
├─ IllustrationBlur.jpg
├─ IllustrationLowRes.jpg
├─ music.wav
├─ Chart_EZ.json / Chart_HD.json / Chart_IN.json
├─ Chart_AT.json（部分）
└─ Chart_Legacy.json（少量）
        │
        └─ Addressables key → dependency bundle → Unity object
```

本 APK 有 319 个 Track folders、626 个 Illustration key rows（Texture2D 与 Sprite location 各一份），313 个有主图；所有 319 个 Track folder 都有 `music.wav`，但 `Random.SobremSilentroom.1..6` 等特殊 family 缺少主图。该关系由 Addressables key 和 bundle/object index 直接证明，confidence **High**。

## 6. Chart existence

本轮把“key/file 存在”与“永远可玩”分开：

| difficulty | key-present tracks | structurally non-empty chart records | absent |
| --- | ---: | ---: | ---: |
| EZ | 319 | 319 | 0 |
| HD | 318 | 318 | 1 |
| IN | 318 | 318 | 1 |
| AT | 46 | 46 | 273 |
| Legacy | 4 | 4 | 315 |

结构性判定为：Addressables key 存在、TextAsset 成功解析、`judgeLineCount > 0` 且文本字节数大于 0。当前没有发现已解析的空 chart。该规则足以标注“APK 中存在非空 chart resource”，但不能单独证明玩家在所有条件下都能选择/解锁它。

特殊观察：

- `Chart_EZ_Error.json`、`Chart_HD_Error.json`、`Chart_IN_Error.json` 各有一个错误/活动变体，均与 `望影の方舟Six.SeURa.0` 相关；它们不是普通五难度字段；
- `Random.SobremSilentroom.0..6` 是一个 special track family，末尾数字不能直接当全局 song ID；
- Legacy 有 4 个 structurally-nonempty chart；本轮不将 Legacy 自动等同于普通永久难度。

## 7. 代码与当前 extractor 对照

当前项目代码证据：

- `tools/phase6-phigros-diff.py` 以 bundle hash 做快速变化筛选，再用 bundle path + Unity object path ID/name 比较 Texture2D 内容；它不恢复 Track/Chapter/Level metadata；
- `packages/domain/src/diff.ts` 的 Phigros identity 优先级包含 `addressablesKey`，无明确 domain `songId` 时回退到 `bundleObject`/`bundlePath` 等 source identity；
- `docs/PHASE6_HANDOFF.md` 明确当前没有真实 old/new APK pair，也没有为大量 legacy resource 证明稳定 external identity；
- 当前 extractor 读取了 Addressables/image provenance，但不输出完整 Chart key existence、`ChapterSongItem.songsId`、Display Level candidates、special chart flags或 high-level IL2CPP class evidence。

本轮没有修改这些生产文件。高价值缺口是：Display Level 数值、Track→Chapter 实例 relation、可跨版本验证的 domain identity，而不是继续解析普通纹理。

## 8. Cross-version status

本地 `D:\Files\曲绘\Phigros\APK` 只有 `Phigros_3.19.5.apk`。`3_19_2`、`3_19_3`、`3_19_4` 目录中的 `phigros-update-report.json` 是旧分析报告，不是仍可读取的 old APK。`data/phigros-cross-version-track-diff.csv` 已把它们标为 `report-provenance-only`，不能作为 identity unchanged/changed 证据。

结论：本轮没有完成 APK-to-APK stability proof；不要把本报告的 current uniqueness 写成跨版本稳定。

## 9. Unresolved

1. Display Level 的每 Track/难度数字来源；
2. internal constant；
3. `ChapterSongInfo.songs[]` 的实例数据与 `songsId` 的具体值；
4. `IdBuilder` 生成的 ID 是否只是资源 key，还是有 domain-level 复用；
5. Track folder title/artist/index 在相邻版本改名、迁移、排序中的稳定性；
6. special/error/Legacy chart 的长期可玩性和更新策略；
7. illustrator、release version/date 等独立 song metadata。

## 10. External / technical references

外部资料只解释 IL2CPP/Unity 数据结构和 Addressables 格式，不覆盖 APK 证据：

| title | URL | accessed | purpose |
| --- | --- | --- | --- |
| Unity Addressables `ContentCatalogData` API | https://docs.unity.cn/Packages/com.unity.addressables%402.11/api/UnityEngine.AddressableAssets.ResourceLocators.ContentCatalogData.html | 2026-08-19 | 解释 catalog location/dependency/key 关系 |
| AddressablesTools | https://github.com/nesrak1/AddressablesTools | 2026-08-19 | 交叉核对 Addressables catalog parser 思路 |
| Il2CppDumper `MetadataClass.cs` | https://github.com/Perfare/Il2CppDumper/blob/master/Il2CppDumper/Il2Cpp/MetadataClass.cs | 2026-08-19 | 交叉核对 metadata v31 type/method record layout |
| Cpp2IL IL2CPP Data Structures | https://github.com/SamboyCoding/Cpp2IL/wiki/IL2CPP-Data-Structures | 2026-08-19 | 解释 IL2CPP metadata table 版本差异 |

