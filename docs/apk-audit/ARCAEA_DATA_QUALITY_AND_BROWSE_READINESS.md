# Arcaea Data Quality and Browse Readiness

> This audit separates APK data capability from recommended public usage. It does not authorize Gallery, Catalog or extractor changes.

## 1. Interpretation

`Data Capability` describes whether the APK contains a reproducible field/path relation. `Recommended Public Usage` is a stricter product recommendation: Available does not mean that a field should become a public facet.

| field | APK source | coverage | reliability | Data Capability | Recommended Public Usage | boundary |
| --- | --- | --- | --- | --- | --- | --- |
| songId | songlist.id → song directory | 543 normal records | High | Available | Internal identity only | not a default user facet |
| title | title_localized | 543 normal records | High | Available | Recommended search/display | select locale; retain source locales |
| title aliases | search_title + localized values | 541 search_title; multiple locales | High/Partial | Available | Recommended search aliases | do not flatten locale values |
| artist | song.artist + six difficulty overrides | 543 song-level; overrides separately | High | Available | Recommended search; optional facet | difficulty artist can differ |
| pack | song.set → packlist.id/name | 543 normal records; 61 packs | High | Available | Recommended facet | pack cover role has separate coverage |
| Difficulty Class | difficulty.ratingClass | 1,799 slots | High | Available | Recommended facet | PST/PRS/FTR/BYD/ETR |
| Display Level | rating + ratingPlus | 1796 playable metadata records; 3 placeholders | High | Available | Recommended facet for jacket browse | zero placeholders have no derived level |
| Chart Constant | no reliable APK field | 0 | Unresolved | Unavailable | Not recommended | never derive from rating |
| side | songlist.side + runtime/grouping evidence | 543 raw values; one missing/deleted | High raw / Medium label | Partial | Needs review / optional | keep sideRaw; numeric enum not fully decoded |
| version | song.version string | 543 normal records | High | Available | Optional facet/sort | preserve 6.10 as string |
| date | song.date Unix seconds candidate | 543 normal records | High | Available | Optional sort | release-date display semantics need product choice |
| idx | song.idx | 544 unique values; gaps/inversion | High | Available | Internal order only | not a permanent public rank |
| jacket override | difficulty.jacketOverride + actual files | 57 true records / 50 songs | High flag / Partial filename semantics | Partial | Needs review | numeric suffix and _256 remain separate evidence questions |
| BPM | song bpm/bpm_base + difficulty overrides | 543 song-level; 4 difficulty overrides | High | Available | Optional / not primary | retain original string and base value |

## 2. Character resources

> 7.0.0c 增量核对：只读 APK 元数据 `assets/char/characters.json` 共 99 条记录，新增 `character_id=97`（`saya_konzetsu`，显示名「咲弥」），`version_from=7.0.0`、`pack_id=konzetsu`；对应的 1 条立绘、1 条头像和 1 条 LinkPlay 预览已纳入当前关系表与站点语义投影。此前“未在 characters.json 找到”的提示是旧关系表漏项，不是 APK 元数据缺失。

| field | APK source | coverage | reliability | Data Capability | Recommended Public Usage |
| --- | --- | --- | --- | --- | --- |
| characterId | characters.json.character_id + numeric asset path | 99 | High | Available | Internal identity; optional filter |
| internal name | characters.json.name | 99 | High | Available | Recommended search/display |
| search strings | characters.json.search_strings | 99 | High | Available | Recommended search aliases |
| packId | characters.json.pack_id | present on subset | High where present | Partial | Optional / needs review |
| variant/uncap | path suffix + version fields | 27 `u` candidates | Medium/High | Partial | Needs review |
| avatar/icon | *_icon path | 130 mapped relation rows | High | Available | Optional resource role |
| LinkPlay preview | *_mp path | 149 mapped relation rows | High | Available | Optional resource role |

## 3. Story resources

| field | APK source | coverage | reliability | Data Capability | Recommended Public Usage |
| --- | --- | --- | --- | --- | --- |
| story path/title/act/order | story2/ordering + entry node key | 186 | High where node matches | Available | Optional story browse |
| storyType | entries_* storyType | 186 | High | Available | Optional facet |
| related song | clearSongId/playableSongBgmId | entry-dependent | High where non-sentinel | Partial | Optional / needs review |
| CG relation | entry.storyCgPath → cg path | 45/57 CGs direct | Confirmed for referenced; unresolved otherwise | Partial | Needs review |
| VN resource relation | .vns command → vn/res path | 6010/6270 refs resolved | High | Available/Partial | Optional story browse |

## 4. Non-jacket resources

| resource type | direct APK relation | coverage | Data Capability | Recommended Public Usage | main unresolved |
| --- | --- | --- | --- | --- | --- |
| Background | songlist bg/bg_inverse → assets/img/bg basename | 1029/1029 refs resolved | Available for song-linked rows; Partial for unreferenced | Optional resource browse | suffix role taxonomy |
| World | path families and numeric groups | 91 | Partial | Needs review | _b/_d/_t semantics and metadata FK |
| Pack cover | packlist.id → pack filename stem | 41/61 pack IDs; 44 rows | Partial | Optional pack resource browse; pack facet Recommended via song.set | custom banner/cutout and unmatched UI |
| LinkPlay sticker | family stem + raw/normalized locale suffix | 99 | Available for locale grouping | Optional resource role | character/sticker product relation |

## 5. Product-facing browse guidance

Recommended public search: title, localized aliases, search_title and artist.
Recommended public facets: pack, Difficulty Class and Display Level for jacket browse.
Optional / needs product review: version, date, BPM, Side, jacket role and upscaled rendition.
Internal only: songId, characterId, packId, idx and raw APK paths/object identities.
Not recommended: Chart Constant, because no reliable APK field was found.
Stable identity candidates remain `arcaea:songId=<songlist.id>`, `arcaea:characterId=<characters.json.character_id>`, `arcaea:packId=<packlist.id>` and story node keys; these are not automatically public facets.

## 6. Readiness boundary

Data Capability and Recommended Public Usage must be reviewed independently. A field marked Available may still be Internal only or Optional. In particular, songId is Available but Internal only; Display Level is Available and Recommended for jacket browse; Chart Constant is Unavailable and Not recommended.

## 7. Seasonal April Fools boundary

`songlist.id` is a reliable identity source for regular/persistent records in the audited APK, but it is not a historical-complete list of every legal special resource. The audit registry contains nine April Fools Error Tracks. Four have current permanent-BYD relations in the APK; five are represented only by Catalog special artwork plus a base-song relation in this APK. Therefore:

| capability | Data Capability | Recommended Public Usage |
| --- | --- | --- |
| identify April Fools special | Available for the nine audited baseline rows | Optional special category; do not merge into regular song identity |
| base-song relation | Available for all nine via APK base `songlist.id` | Internal relation; optional “derived from” display after review |
| seasonal/current status | Partial; depends on current APK version and Catalog provenance | Needs review; never infer removal from absent songlist row |
| permanent BYD relation | Available for 2018–2021 in current APK | Optional special marker on the BYD artwork; do not duplicate the Song entity |

Source: `data/arcaea-april-fools-registry.csv`, accessed external baseline `https://arcaea.fandom.com/wiki/Category:April_Fools` on 2026-08-19. The external page supplies player-facing naming only; APK fields and Catalog reconciliation supply the internal status.
