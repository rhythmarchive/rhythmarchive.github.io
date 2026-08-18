# Phigros APK Structure Report

> 研究对象：本地 Phigros_3.19.5.apk。本报告为只读静态审计；没有修改 APK、没有上传资源、没有实现 extractor/Gallery/Catalog、没有 commit/push。

## 1. APK 基本信息

| 项目 | 值
| --- | ---
| APK path | D:\Files\曲绘\Phigros\APK\Phigros_3.19.5.apk
| 文件大小 | 2.47 GiB (2,652,431,993 B)
| 修改时间 | 2026-07-30 19:52:34 +08:00
| SHA-256 | B9654316E52BF2D410FA2ECB3F0DF41246AFDC3DC8133456DEAFF07ECBCF28BF
| ZIP entry 数 | 3163
| entry 未压缩总量 | 2.76 GiB (2,960,988,415 B)
| entry 压缩总量 | 2.47 GiB (2,651,846,427 B)
| package | com.PigeonGames.Phigros
| versionName / versionCode | 3.19.5 / 153

> 结论：Phigros 是 Unity Android IL2CPP build，并且本 APK 使用 Addressables 存放主要歌曲/图片/谱面内容。
> Source: Manifest、ELF libs、global-metadata.dat、UnityFS header、Addressables catalog/settings。
> Confidence: Confirmed

## 2. Android 壳层

| 字段 | 实际值
| --- | ---
| application label | @0x7f0a000b
| icon / roundIcon | @0x7f090000 / @0x7f090001
| minSdk / targetSdk | 26 / 30
| compile SDK | 30 (codename 11)
| main activity | com.unity3d.player.UnityPlayerActivity
| ABI | arm64-v8a; armeabi-v7a
| permissions | android.permission.INTERNET; android.permission.ACCESS_NETWORK_STATE

Manifest 只有 INTERNET、ACCESS_NETWORK_STATE 两项权限。组件计数：activity=6, provider=2；除 UnityPlayerActivity 外还有 TapTap、Google Play Games、TapTap provider 等登录/服务壳层。

## 3. 顶层结构与 Unity 版本

| 路径族 | 数量/大小 | 作用
| --- | --- | ---
| assets/aa/Android/*.bundle | 2,514 / 2,457,840,077 B | UnityFS Addressables bundles；歌曲和 UI/其他内容的主要资源层
| assets/aa/catalog.json | 3,735,915 B | Addressables key/bucket/entry/extra mapping
| assets/aa/settings.json | 1,594 B | Addressables runtime settings，版本 1.22.3
| assets/aa/AddressablesLink/link.xml | 6,063 B | 保留 Assembly-CSharp ChartNote 与 Unity asset types
| assets/bin/Data | 441 entries / 329,985,909 B | Unity player serialized files、Managed metadata、boot/config
| assets/bin/Data/Managed/Metadata/global-metadata.dat | 10,310,628 B | IL2CPP metadata
| lib/*/libil2cpp.so + libunity.so | 两个 ABI | IL2CPP native code + Unity engine

| 证据位置 | 实际值 | 置信度
| --- | --- | ---
| bundle header 0001488b03e729136338f081478beb81.bundle | UnityFS；字符串 2022.3.62f2 | Confirmed
| globalgamemanagers / .assets UnityPy SerializedFile | UnityVersion 2022.3f2；serialized header version 22 | Confirmed
| UnityPy BundleFile.version_engine | 2022.3.62f2 | High

综合值：Unity 2022.3.62f2；Player SerializedFile 格式版本 22。globalgamemanagers 与 globalgamemanagers.assets 同时存在，level0..level27 与多个 sharedassetsN.assets 存在，部分大文件在 APK 中以 .split0..N 分片。分片只在 .runtime/apk-audit/extracted/phigros/combined-data/ 临时拼接用于读取，未写回 APK。

未发现独立 assets/bin/Data/StreamingAssets/ 树；便于读取的歌曲内容在 assets/aa/catalog.json + assets/aa/Android/*.bundle。

## 4. Mono / IL2CPP

| 证据 | 结果
| --- | ---
| lib/arm64-v8a/libil2cpp.so | 66,634,792 B，ELF；存在
| lib/armeabi-v7a/libil2cpp.so | 56,224,808 B，ELF；存在
| assets/bin/Data/Managed/Metadata/global-metadata.dat | IL2CPP-Metadata；存在
| Managed DLLs | 未发现 Assembly-CSharp.dll；ScriptingAssemblies.json 只保留程序集名清单
| libunity.so | 两个 ABI 均存在

结论是 IL2CPP，不是 Mono。AddressablesLink/link.xml 的 Assembly-CSharp 与 ScriptingAssemblies.json 中的 Assembly-CSharp.dll 表示构建时程序集/保留类型，不表示 DLL 作为可直接读取文件留在 APK。

global-metadata.dat 字符串可见 UnityEngine.AddressableAssets、Phigros2.Utils.Addressable、AddressableImageLoaderWithLowResPreview、Phigros2.ChapterSelector.Banners、Song information、Level information。它们用于确认代码包含 Addressables/歌曲/章节相关概念；未据此假设资源层不存在的字段。

## 5. Addressables catalog / bundle 关系

> 结论：logical key → dependencyKey bundle → Unity object 是可验证的主关系。
> Evidence: settings m_AddressablesVersion=1.22.3；catalog 解出 7936 keys、6425 entries、2514 bundle internal IDs；UnityPy object index 可 join 回 Texture2D/Sprite/TextAsset/AudioClip。
> Confidence: Confirmed

| catalog 指标 | 值
| --- | ---
| m_BuildTarget | Android
| m_CatalogLocations[0] | AddressablesMainContentCatalog → catalog.json
| m_AddressablesVersion | 1.22.3
| m_DisableCatalogUpdateOnStart | false
| m_IsLocalCatalogInBundle | false
| keys | 7936
| entries | 6425
| expanded key-location rows | 10372
| bundle internal IDs | 2514
| track illustration unique keys | 313（Texture2D+Sprite 位置共 626 rows）
| avatar unique keys | 109（Texture2D+Sprite 位置共 218 rows）

实际例子：Assets/Tracks/DataErr0r.Cosmograph.0/Illustration.jpg 的 Addressables location 资源类型有 UnityEngine.Texture2D 与 UnityEngine.Sprite，dependencyKey 为一个 *.bundle；该 bundle 在 APK assets/aa/Android/ 中存在，UnityPy 读出 object name Illustration、path ID、2048x1080 Texture2D。相同方法适用于 Chart_HD.json（TextAsset）与 music.wav（AudioClip）。

解释 catalog serialized layout 时参考了 Unity 官方 ContentCatalogData API（https://docs.unity.cn/Packages/com.unity.addressables%402.11/api/UnityEngine.AddressableAssets.ResourceLocators.ContentCatalogData.html，查询日期 2026-08-18）与 AddressablesTools 公开 parser/decoder（https://github.com/nesrak1/AddressablesTools，查询日期 2026-08-18）。关键数量和映射来自本地 APK。

## 6. SerializedFiles 与 Unity object 统计

本轮扫描了 2,514 个 Addressables bundle 与 58 个 player-data serialized source，共 2,572 个 source、23208 个 Unity objects。完整 object-level 记录见 data/phigros-unity-object-index.csv，按 source/type 统计见 data/phigros-unity-object-stats.csv。

| Object type | 数量
| --- | ---
| AssetBundle | 2514
| AudioClip | 379
| CanvasRenderer | 2582
| GameObject | 3416
| Material | 96
| MonoBehaviour | 4036
| MonoScript | 1388
| RectTransform | 3056
| Shader | 37
| Sprite | 1493
| TextAsset | 1008
| Texture2D | 1480
| VideoClip | 9

主要 object 结论：Texture2D 1,480、Sprite 1,493、TextAsset 1,008、AudioClip 379、MonoBehaviour 4,036、MonoScript 1,388、AssetBundle 2,514。AddressablesLink/link.xml 明确保留 Texture2D/Sprite/TextAsset/AudioClip/ChartNote 等类型，与实际对象统计交叉一致。

UnityPy parse error 共 3762，全部集中于 player-data 的 MonoBehaviour 读取，错误模式为 custom/IL2CPP serialized fields 不能按当前 typetree 读取；bundle 中的 Texture2D/Sprite/TextAsset/AudioClip 没有同类错误。该限制不影响已确认的 catalog key、object type、尺寸与 chart summary，但影响从 MonoBehaviour 恢复自定义 pack/level schema。

## 7. Texture2D / Sprite / UI 图片

| 资源族 | 数量/尺寸 | 证据
| --- | --- | ---
| 曲绘主图 | 313 Texture2D，2048x1080，TextureFormat 3=RGB24；每个有对应 Sprite | object name Illustration + Assets/Tracks/<folder>/Illustration.jpg
| 曲绘模糊图 | 313，256x135，TextureFormat 3=RGB24 | object name IllustrationBlur + catalog key
| 曲绘低清图 | 313，512x270，TextureFormat 3=RGB24 | object name IllustrationLowRes + catalog key
| avatar | 109 key / 109 Texture2D，通常 128x128，TextureFormat 34=ETC_RGB4；部分 47=ETC2_RGBA8 | Addressables key avatar.<name> + object name/尺寸
| 章节/联动封面 | 89 unique Assets/Tracks/#ChapterCover/<name>.jpg keys；常见 1024x540 | key path #ChapterCover + Texture2D/Sprite
| UI/gameplay | 其余 Texture2D 及 Sprite；如 Tap/Hold/MessagePanel/HitFX/章节 banner | object name、bundle catalog keys、尺寸与 AddressablesLink 类型

曲绘主图、Blur、LowRes 是同一 track folder 下的三个逻辑 key，不是三首歌曲。Texture2D 与 Sprite 是同一 Addressables key 的两个 resource locations；Gallery 需要选择 Texture2D 像素或 Sprite 裁剪语义，不能把两个 object 计为两张图。

## 8. Song metadata 与歌曲 identity

> 结论：本 APK 没有发现一个独立、可直接解析的 songlist/packlist JSON；歌曲的可读元数据主要编码在 Addressables key 的 track folder：Assets/Tracks/<title>.<artist>.<index>/...。
> Evidence: 319 个 track folder records；2356 个 unique track keys；319 个 folder 中 313 个有 Illustration.jpg。
> Confidence: High（key-derived），不是 canonical metadata 的 Confirmed。

| 字段 | APK 是否发现 | 实际来源/限制
| --- | --- | ---
| song id | No explicit field | 未发现独立 song ID；track folder/key 是最强本地 identity 候选
| title | High | key folder 第一段；可能是内部标题格式，不保证展示空格/标点
| artist | High | key folder 倒数第二段；存在中日韩/特殊字符，不能只按 ASCII
| chapter/collection/pack | Partial | #ChapterCover 提供封面逻辑 key，但没有发现 track→chapter foreign key
| version/release date | No song-level field | APK versionName 是 3.19.5；未发现 per-song release version/date
| illustrator | No separate field | 没有在 track key/catalog/Chart JSON 中发现 illustrator 字段
| BPM | Yes, chart-level | Chart JSON 每个 judge line 有 bpm；歌曲可能多 timing，不能强行压成一个 BPM

完整逐 track mapping 见 data/phigros-track-records.csv。319 个 track folder 中缺少曲绘的 6 个是 Random.SobremSilentroom.1..6，但仍有 music.wav/Chart_EZ 等资源；所有 319 个 folder 都有 music.wav。

## 9. Illustration ↔ Song ↔ Bundle ↔ Object

~~~text
Assets/Tracks/<title>.<artist>.<index>/Illustration.jpg
        │
        ├─ catalog location: Texture2D + Sprite
        ├─ dependencyKey: <hash>.bundle
        ├─ APK entry: assets/aa/Android/<hash>.bundle
        └─ Unity object: Texture2D name Illustration, pathId, 2048x1080

同一 folder
├─ music.wav ─────► AudioClip name music
├─ Chart_EZ.json ─► TextAsset name Chart_EZ
├─ Chart_HD.json ─► TextAsset name Chart_HD
├─ Chart_IN.json ─► TextAsset name Chart_IN
└─ Chart_AT/Legacy ► 只在部分 track 存在
~~~

这条关系链是本次 Phigros 最可靠的可提取数据链。它不依赖视觉猜测，也不依赖 bundle 文件名本身；bundle 只是 catalog 的 dependencyKey，逻辑 identity 是 Addressables key。

## 10. Chart metadata

扫描到 1,008 个 chart TextAsset：EZ 320（含 1 个 Error variant）、HD 319（含 1 个 Error variant）、IN 319（含 1 个 Error variant）、AT 46、Legacy 4。Addressables 正常 key 计数为 EZ 319、HD 318、IN 318、AT 46、Legacy 4；额外 key 是 Chart_EZ_Error.json、Chart_HD_Error.json、Chart_IN_Error.json。

定向 IL2CPP metadata 进一步确认 `LevelInfo.level`/`LevelInfo.difficulty` 与 `SongListItem.SetRating*` 等等级相关类成员存在；本轮没有恢复每个 track/difficulty 的序列化实例值。因此 Phigros Display Level 结论是 **partial structure evidence / numeric values unresolved**，不是“游戏没有等级”。详见 `PHIGROS_METADATA_DEEP_AUDIT.md` 与 `data/phigros-high-level-class-evidence.csv`。

| 字段/结构 | 覆盖 | 结论
| --- | --- | ---
| root keys | 1,008/1,008 | 只有 formatVersion、offset、judgeLineList；另有少量 numOfNotes
| formatVersion | 976=3，32=1 | 存在两种谱面 schema
| BPM | 1,008/1,008 | 在 judgeLineList 每条 line 的 bpm scalar 中；可有多个 BPM
| level/rating/constant | 0 条 chart JSON root/nested key；IL2CPP 有等级相关类成员但无实例值 | Display Level 数值 partial/unresolved；Chart Constant 未找到
| title/artist/songId/illustrator | 0 条 chart field | chart body 通过 Addressables key/track folder 关联，内容自身不带这些 metadata
| notes/lines | judgeLineList、notesAbove/notesBelow | 可得到 line/note 统计；完整玩法解析不在本任务范围

formatVersion、offset、judgeLineList 是 JSON 实际字段；BPM 位于 judge line 内的 bpm。Chart JSON 没有 level/rating/constant；IL2CPP 的等级相关成员只证明候选结构，不能填充每曲数值。完整 schema/key 统计见 data/phigros-chart-schema-stats.json，逐 chart 关系见 data/phigros-chart-index.csv。

## 11. Chapter cover、pack、StreamingAssets、UI、Audio

Assets/Tracks/#ChapterCover/ 有 89 个 unique cover keys；可见 MainStory4/5/6/7/8、SideStory1..4、Single、联动名及 locked/Blur/S 变体。IL2CPP metadata 还暴露 `Chapter`、`ChapterSongInfo.songs[]`、`ChapterSongItem.songsId` 等章节关系结构，但本轮没有恢复序列化实例外键，因此不能把 cover/目录顺序当作 Track→Chapter 关系。

未发现独立 StreamingAssets 目录；不要把 assets/aa 误写成 StreamingAssets。AudioClip 共 379；其中 319 个对象名 music 对应 319 个 music.wav key，另有 music_IN.wav 1 个及 Tap/Hit/Chapter/Message 等 SFX。

AddressablesLink/link.xml 明确列出 ChartNote、Texture2D、Sprite、TextAsset、AudioClip 等序列化/保留类型；它不是 song metadata，但能支持类型判断。

## 12. Launcher icon

> 结论：Phigros 使用普通 density PNG launcher icon，不是 adaptive icon。Manifest icon=@0x7f090000、roundIcon=@0x7f090001；resource table 解析出两组 36/48/72/96/144/192 PNG；没有发现 foreground/background/monochrome adaptive XML。
> Confidence: Confirmed

| 资源 | Resource ID | 最高密度 APK path | 尺寸/格式
| --- | --- | --- | ---
| app_icon | 0x7f090000 | res/oj.png | 192x192 PNG RGB
| app_icon_round | 0x7f090001 | res/FN.png | 192x192 PNG RGB

网页直接使用可选择 res/oj.png 或圆形 res/FN.png；二者都不是透明 RGBA adaptive foreground。icon 只在报告中记录，本轮没有复制到 Public Site。

## 13. 当前 Phigros extractor / Catalog / Public projection 对照

代码证据：历史 extractor extract-phigros-update.py:69-92 解析 catalog 后只计算 added keys/added bundles，并只扫描 added bundles；:180-201 自己解码 key strings；:289-304 用 object name/尺寸分类 Illustration 与 avatar；:298-307 通过 Assets/Tracks/<title>.<artist>.<index> 生成文件名。当前 apps/site/src/lib/game-config.ts:72-78 将 Phigros difficulty filter 设为 false；公共 whitelist 在 apps/site/src/lib/catalog-projection.ts:8-24 不包含 chart level/constant/章节 key 等字段。

| APK 信息 | 当前 extractor | Catalog/Public 现状 | 审计结论
| --- | --- | --- | ---
| Addressables key→bundle | 读取 catalog key，生成候选 image；只扫描新增 bundle | 可保存 phigros-key，但 key/bundle/object 全链尚未作为公开 metadata | Within-APK Yes；增量 changed-bundle detection 有边界
| title/artist | 从 track key rsplit 推导文件名 | artist 可作为通用 metadata；title 通常是 display title | High key-derived；非 canonical song table
| Illustration 主图 | 按 object name=Illustration、尺寸分类 | jacket category 可发布，但映射证据依赖 candidate/provenance | Yes；应保存 key/dependency/object evidence
| avatar | 按 <=200x200 分类并从 avatar key 命名 | character-avatar category 存在 | Yes；需保留 avatar key
| Chart EZ/HD/IN/AT/Legacy | 当前 extractor 不解析 chart TextAsset | Phigros difficulty filter 关闭 | APK 有 difficulty key；项目当前丢失
| BPM/notes/offset | 未解析 | Public 无字段 | APK chart JSON 有；可作为 future metadata
| level/rating/constant | 未解析；只保留 Chart_* key 与 IL2CPP 结构证据 | 无 public 数值字段 | Display Level numeric values partial/unresolved；Chart Constant not found；不能假填
| chapter/pack | 不建立 track foreign key | pack-cover category 不等于 track pack metadata | IL2CPP ChapterSongInfo/ChapterSongItem 结构存在，但实例 Track→Chapter FK unresolved

当前 extractor 的 addedBundles 策略适合发现新增 key/bundle，但如果未来版本复用同一个 bundle path/key 而替换内部内容，代码的静态逻辑不会自动把它当作 added bundle；本次只有一个本地 Phigros 版本，未做版本间实证。

## 14. Resource identity 与未来 Gallery

| 候选 identity | 稳定性 | 结论
| --- | --- | ---
| 完整 Addressables key | 在单 APK 内唯一；跨版本内部命名稳定性未实证 | 首选 asset identity
| track folder + role | 比 display title 强；index 目前为 0，Random 例外 | Song/asset grouping 候选
| dependency bundle hash | 可定位本 APK 内容；可能随构建/内容变化 | provenance/content locator，不宜单独做跨版本 identity
| display title/artist | 可改名、空格/标点不稳定 | 只作显示与搜索 alias

| 未来 facet | 可用性 | 依据
| --- | --- | ---
| 曲绘分类 | Yes | 313 Illustration key/object and 2048x1080 texture
| artist/title | Partial→Yes | 可由 key 解析；需保留原始 key 和清洗后显示值
| EZ/HD/IN/AT/Legacy | Yes | Chart key suffix 明确且逐 track 可 join
| level/constant | No | chart JSON 没有字段
| BPM | Yes（chart-level） | judgeLineList 的 bpm；多值歌曲要保留集合
| pack/chapter | Partial/No | 89 cover keys 有，但没有 track foreign key
| version/release | No | 只有 APK versionName
| avatar | Yes | avatar.<name> key + 128x128 Texture2D/Sprite
| game order | No/Partial | 未发现 song order table

## 15. Unknown / unresolved

语义 inventory 覆盖全部 3,163 entries。主要未知聚类是 181 个 assets/bin/Data/<32-hex> Binary entries，共约 23.0 MiB；它们没有通过本轮轻量 magic/UnityPy 路由被证明为某种可消费资源。

| semanticRole | type | 数量 | 总大小 | 说明
| --- | --- | --- | --- | ---
| unresolved Phigros asset | Binary | 181 | 23.00 MiB (24,118,188 B) | 保留；需额外 Unity/代码映射

最大 unresolved 不是曲绘/谱面 key，而是 player-data hashed blobs、无法被当前 typetree 读取的 MonoBehaviour 自定义字段、缺少 per-song canonical metadata，以及 chapter cover 到 song 的外键。

## 16. 复查入口

完整 entry inventory：data/phigros-files.csv；目录/类型/tree：data/phigros-directory-stats.csv、data/phigros-filetype-stats.csv、data/phigros-tree.txt。

Addressables：data/phigros-addressables-keys.csv、data/phigros-addressables-summary.json。

Unity object/texture/chart：data/phigros-unity-object-index.csv、data/phigros-unity-object-stats.csv、data/phigros-texture-index.csv、data/phigros-chart-index.csv、data/phigros-chart-schema-stats.json。

关系表：data/phigros-track-records.csv、data/phigros-chapter-cover-records.csv、data/phigros-relations-summary.json；Android/icon/code：data/phigros-manifest.json、data/phigros-icon-inventory.json、data/phigros-code-strings.json；语义/未知：data/phigros-semantic-inventory.csv、data/phigros-unresolved-summary.csv。

外部资料记录：Unity Addressables ContentCatalogData 官方 API（https://docs.unity.cn/Packages/com.unity.addressables%402.11/api/UnityEngine.AddressableAssets.ResourceLocators.ContentCatalogData.html，查询日期 2026-08-18）；AddressablesTools parser/decoder（https://github.com/nesrak1/AddressablesTools，查询日期 2026-08-18）。外部资料只用于解释 catalog layout；关键数量和映射来自本地 APK。

## 15. Targeted metadata / identity addendum (2026-08-19)

本轮使用原 APK 内 `global-metadata.dat` + `libil2cpp.so` 做了定向 IL2CPP table recovery，修正了“没有高层代码证据”的过宽表述：

- `Chapter.chapterCode/songInfo/unlockInfo`、`ChapterSongInfo.songs`、`ChapterSongItem.songsId` 和 `ChapterInfo.coverAssetCode` 已从 IL2CPP type/field table 确认；
- `LevelInfo.level/difficulty`、`SongListItem.SetRating/SetRatingWithScore` 已确认，但没有恢复 319 个 Track 的数值实例；
- 因此 Display Level 为 **Partial structure evidence / unresolved values**，不是已确认的数字；
- Track→Chapter 关系为 **structure found, instance foreign key unresolved**，不能用 cover 或目录顺序补齐；
- `Chart` type 仍只显示 `formatVersion/offset/judgeLineList`，Chart Constant 未找到；
- 完整 Track folder 在当前 APK 内唯一，但 folder suffix index 不是 global ID；本地没有第二份 APK，跨版本稳定性未验证。

详细证据：`data/phigros-high-level-class-evidence.csv`、`data/phigros-track-metadata.csv`、`data/phigros-identity-candidates.csv`、`data/phigros-targeted-audit-summary.json`；分开的结论报告见 `PHIGROS_METADATA_DEEP_AUDIT.md`、`PHIGROS_IDENTITY_STABILITY_REPORT.md` 和 `PHIGROS_DATA_QUALITY_AND_BROWSE_READINESS.md`。
