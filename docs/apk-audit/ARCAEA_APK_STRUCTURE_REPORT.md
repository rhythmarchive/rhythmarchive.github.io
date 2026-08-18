# Arcaea APK Structure Report — Semantic Correction & Deepening Pass

> 研究对象：本地 `arcaea_6.16.8c.apk`。本轮是只读静态审计纠错；没有修改 APK、没有上传资源、没有修改 Gallery/Public Site/Catalog/生产 extractor/Phase 6/Phase 7，没有 commit/push。

> 重要语义修正：`rating` 是 Display Level 的整数部分；`ratingPlus=true` 表示显示 `+`。它们不是 Chart Constant。Chart Constant 在本轮审计的 APK songlist/AFF/可读代码证据中未找到可靠字段，保持 `Not found / unresolved`。

## 1. APK basic information

| 项目 | 值 |
| --- | --- |
| APK path | D:\Files\曲绘\Arcaea\APK\arcaea_6.16.8c.apk |
| file size | 1,867,085,903 B (1.74 GiB) |
| modification time | 2026-08-18 16:35:39 +08:00 |
| SHA-256 | C2B58DCAD54203645057A859524789F59CFD5CA13613B610D04AD087B58AAC90 |
| ZIP entries | 7320 |
| uncompressed / compressed entries | 1,910,651,029 B / 1,865,928,462 B |
| package | moe.low.arc |
| versionName / versionCode | 6.16.8c / 1209752 |
| comparison APK | D:\Files\曲绘\Arcaea\APK\arcaea_6.16.0c.apk; 7,329 entries |

Source: `data/arcaea-files.csv`, `data/apk-basic-info.json`, `data/arcaea-version-comparison.json`. The comparison sample is used only for small metadata/path stability checks.

## 2. Method, tools and evidence boundary

The APK was opened as a ZIP through Python `zipfile`; the central directory and all entries were inventoried. Android binary XML/resource table parsers, magic detection, Pillow-derived image index data and targeted UTF-8/ASCII probes were used. No APK entry was rewritten. Temporary scripts and any samples remain under the ignored `.runtime/apk-audit/`; only text/CSV/JSON/Markdown audit outputs are in `docs/apk-audit/`.

Evidence order used in this pass: APK path/content → APK code/runtime-readable strings → official Android/technical format knowledge → reproducible open-source parser → Wiki/community cross-check. External pages are not the source of truth.

## 3. Android shell

| field | observed value | relevance |
| --- | --- | --- |
| package | moe.low.arc | stable Android package identity; not a song identity |
| application label | @0x7f0f0046 | resource-table reference |
| icon | @0x7f0d0000 (`mipmap/ic_launcher`) | launcher resource entry |
| roundIcon | not declared in audited manifest | no separate round resource reference |
| minSdk / targetSdk | 24 / 36 | install/runtime compatibility only |
| main activity | low.moe.AppActivity | Cocos2d-x Android shell entry point |
| ABI | arm64-v8a; armeabi-v7a | two native library variants |
| native libraries | 16 ELF entries; libcocos2dcpp.so, libfmod.so, libfmodProvider.so | supports Cocos2d-x + FMOD conclusion |
| DEX | classes.dex, classes2.dex | Android services/SDK/runtime glue; not the songlist source |
| Unity markers | UnityFS/globalgamemanagers/libil2cpp.so not found | Arcaea should not be analyzed as a Unity asset package |

Manifest evidence: `AndroidManifest.xml`, summarized in `data/arcaea-manifest.json`. The 20 permissions and declared providers/services/receivers are Android runtime, sign-in, billing, notification, analytics or file-provider concerns; they do not add Gallery metadata.

### 3.1 Launcher icon

Manifest `application android:icon` points to resource ID `0x7f0d0000`, name `mipmap/ic_launcher`. Resource-table resolution shows density-specific legacy PNGs and an API-26 adaptive-icon configuration:

| role | resource | format/size | evidence |
| --- | --- | --- | --- |
| manifest icon | `0x7f0d0000` / `mipmap/ic_launcher` | PNG variants 48, 72, 96, 144, 192 px | `data/arcaea-icon-inventory.json` |
| adaptive icon XML | `res/BW.xml` | binary XML adaptive-icon | background `@0x7f080074` + foreground `@0x7f0d0001` |
| background | `0x7f080074` / `drawable/ic_launcher_background` → `res/0w.xml` | vector, 108×108 viewport | resource XML node |
| foreground highest source | `0x7f0d0001` / `mipmap/ic_launcher_foreground` → `res/as.png` | RGBA PNG 432×432 | resource table + PNG magic |
| round icon | not present as manifest field/resource name | none | no `roundIcon`/`ic_launcher_round` record found |
| monochrome | not found | none | no `monochrome` node/resource found |

Android 8+ composes the adaptive background and foreground inside the launcher mask; the legacy `ic_launcher` PNGs remain density fallback resources. For a future web use, the highest-quality *source* is the foreground PNG plus vector background, but the APK does not provide a single web-ready flattened logo in the audited resource table. This pass did not copy the icon into the site.

## 4. Top-level resource organization

```text
APK
├─ Android shell: AndroidManifest.xml / resources.arsc / res / lib / classes*.dex
├─ assets/songs: songlist, packlist, unlocks, per-song audio/jacket/AFF directories, pack UI
├─ assets/char: characters.json + character art, icons and _mp previews
├─ assets/app-data: story entries/CG/VN scripts/resources and story2 ordering
├─ assets/img: bg, world, course, multiplayer/stickers, story/UI/runtime image families
├─ assets/layouts: Cocos Studio/UI layout data grouped by screen
├─ assets/audio / voice / Fonts / models / particle: runtime sound/font/model/effect inputs
└─ assets/startup: startup/runtime images
```

Directory and type evidence is in `data/arcaea-tree.txt`, `data/arcaea-directory-stats.csv`, `data/arcaea-filetype-stats.csv` and `data/arcaea-semantic-inventory.csv`.

### 4.1 Major directory statistics

| directory | file count | uncompressed bytes | audit role |
| --- | --- | --- | --- |
| assets/songs | 2,075 | 662,980,396 | song metadata and song-local assets |
| assets/img | 2,009 | 411,859,705 | background/world/course/multiplayer/UI images |
| assets/char | 421 | 339,391,134 | character metadata and art |
| assets/app-data | 345 | 127,706,916 | story and other structured application data |
| assets/layouts | 1,674 | 86,644,494 | screen/layout runtime data |
| assets/audio | 136 | 179,282,904 | BGM/runtime audio |
| assets/startup | 55 | 15,696,267 | startup/runtime image family |
| lib | 16 | 50,415,500 | native ELF libraries |

Largest detected image/audio types: PNG 4,173; OGG 694; JPEG 1,585; WAV 92. There are 102 AFF entries (1,569,039 bytes), 35 extensionless JSON-like entries and 204 Android binary XML entries. See `data/arcaea-filetype-stats.csv`.


## 5. Actual Arcaea song model

The primary structured source is `assets/songs/songlist`. Its root is `songs`; this APK contains 544 records, of which 543 carry the normal song fields and `particlearts` is marked deleted/structurally incomplete. A song record contains `id`, localized title, artist, BPM (`bpm` and `bpm_base`), `set`, purchase/unlock flags, side, background keys, `date`, string `version`, `idx`, localization/search fields and a `difficulties` array.

The path relation is direct but has a download prefix: `songlist.id` → `assets/songs/<id>/` when present, otherwise `assets/songs/dl_<id>/`. This is a path/metadata relation, not a filename-title guess. `assets/songs/packlist` and `assets/songs/unlocks` are separate structured tables.

```text
songlist.songs[]
├─ id / idx / title_localized / search_title
├─ artist / search_artist / bpm / bpm_base / side / bg / bg_inverse
├─ set / purchase / date / version / unlock and remote-download flags
├─ difficulties[]
│  ├─ ratingClass → PST/PRS/FTR/BYD/ETR
│  ├─ raw rating + raw ratingPlus → derived Display Level
│  ├─ chartDesigner / jacketDesigner / hidden and override fields
│  └─ difficulty-specific title/audio/BPM/background/jacket flags
└─ songId → <id> or dl_<id> → jacket/audio/AFF when local
```

### 5.1 Local song asset coverage
| measure | value | interpretation |
| --- | --- | --- |
| song records | 544 | songlist records, including deleted/incomplete record |
| song directories | 543 | direct or `dl_` asset directory present |
| songs with local AFF | 31 | only a subset has chart bodies bundled |
| song-mapped AFF chart bodies | 100 | difficulty records with exact local `<class>.aff` file; two tutorial AFF are not songlist records |
| songs with jacket files | 543 | jacket files exist under 543 song directories |

The absence of an AFF file is not evidence that a song has no playable chart: `remote_dl=true` and download-gated content exist. It only means the chart body is not in this APK ZIP. This distinction is retained in `chartFilePresent` versus `isPlayableChart`.

## 6. Difficulty model: corrected terminology

### 6.1 Three distinct concepts

| term | APK representation | meaning |
| --- | --- | --- |
| Difficulty Class | `ratingClass` 0/1/2/3/4 | PST / PRS / FTR / BYD / ETR |
| Display Level | positive raw `rating` plus `+` when raw `ratingPlus` is true; rating=0 inactive slots stay blank | what the game displays, e.g. 9, 9+, 10+ |
| Chart Constant | no reliable field found in audited songlist/AFF/runtime-readable data | community/internal decimal value such as 9.7; unresolved in this APK audit |

Example from the APK: `assets/songs/songlist`, song `lasteternity`, class BYD has `rating: 9` and `ratingPlus: true`; the audit derives `displayLevel: 9+`. It must not be rendered as `9.x` or used as a Chart Constant.

### 6.2 Record slots versus playable metadata records

| difficulty | record slots | isPlayableChart=true | bundled AFF bodies |
| --- | --- | --- | --- |
| PST | 543 | 542 | 31 |
| PRS | 543 | 542 | 31 |
| FTR | 543 | 542 | 31 |
| BYD | 64 | 64 | 0 |
| ETR | 106 | 106 | 7 |

Total difficulty slots: 1799. Audit interpretation: 1796 metadata-defined playable chart records, 3 inactive placeholders. This is not a claim that 1,796 AFF bodies are packaged locally; only 100 song-mapped AFF bodies are present.

Recommended audit-only rule for this APK: `isPlayableChart=false` only when all correlated evidence is present — `rating=0`, `hidden_until=always`, and empty `chartDesigner` (the three Last | Eternity PST/PRS/FTR records). A positive raw rating is required for the true branch. Empty `chartDesigner` alone is not a universal invalidity rule: other rated records use it. The rule is `High` confidence for this audited sample, but should be revalidated against future versions.

Raw and derived values are in `data/arcaea-difficulty-records.csv`: raw `rating`, raw `ratingPlus`, derived `displayLevel`, `isPlayableChart`, `playabilityEvidence`, `recordRole`, `chartFilePresent` and `chartBodyPath`.

### 6.3 Chart Constant search result

The targeted search covered songlist/packlist/unlocks, extensionless structured assets, story/VN text, AFF-like data, DEX and native libraries for `constant`, `chart_constant`, `chartconstant`, `ratingvalue`, `difficultyvalue`, `potential`, `ratingplus`, `ratingclass`, override and hidden-field terms. Ordinary story prose produces `constant`/`potential` hits; these are not metadata fields. No reliable Chart Constant field was assigned.

Conclusion: **Chart Constant: Not found / unresolved**. Evidence and hit classification: `data/arcaea-chart-constant-search.json`. Native/DEX string hits, if any, are not sufficient to claim a chart-constant schema without a decoded data path.

External cross-checks support the separation, not the APK data source: ArcaeaChartRender passes `rating`/`ratingPlus` in songlist data and `constant` as a separate renderer argument; the Last references list display levels 9/9+ separately from constants 9.6/9.7. See `data/arcaea-external-references.json`.

### 6.4 Last / Last | Moment / Last | Eternity case study

| songlist id | class | raw rating | display | raw flags/fields | local assets |
| --- | --- | --- | --- | --- | --- |
| last | PST/PRS/FTR | 4 / 7 / 9 | 4 / 7 / 9 | hidden_until=song; chartDesigner=Arcaea | `assets/songs/dl_last/` has base + 1080_3 jackets and `3.ogg`, but no local 0–3.aff |
| last | BYD | 9; ratingPlus absent | 9 | title_localized=Last | Moment; audioOverride=true; jacketOverride=true; hidden_until=difficulty | same `dl_last` directory; no local 3.aff |
| lasteternity | PST/PRS/FTR | 0 / 0 / 0 | not a level | hidden_until=always; hidden_until_unlocked=true; chartDesigner/jacketDesigner empty | `dl_lasteternity` has base jacket + preview only; no 0–2.aff |
| lasteternity | BYD | 9; ratingPlus=true | 9+ | hidden_until=difficulty; chartDesigner=Arcaea | same directory; no local 3.aff |

The APK has no separate `lastmoment` songlist ID. `Last | Moment` is a difficulty-level title override under `songlist.id=last`, while `Last | Eternity` is a separate songlist record. `assets/songs/unlocks` contains the cross-record conditions around `last`/`lasteternity`, including the character-awakening condition for Eternity BYD and the inverted `lasteternity` BYD condition on the Last branch. This supports a conditional song-family relation; it does not justify flattening the family into one ordinary Song record.

`data/arcaea-last-family.csv` keeps all eight raw slots and the derived role. The exact association between `dl_last/3.ogg` and the two conditional BYD presentations is strongly suggested by the override/asset pattern but is not directly named in the file, so the audio-to-Moment/Eternity assignment remains `High/Unresolved` rather than hardcoded.

### 6.5 Other special song cases

| case | APK evidence | examples |
| --- | --- | --- |
| difficulty-specific title + audio + jacket | difficulty `title_localized`, `audioOverride`, `jacketOverride` | PRAGMATISM, Ignotus, Axium Crisis, Red and Blue, Singularity, dropdead, Vicious Heroism, Last |
| difficulty-specific artist/BPM/background | difficulty `artist`, `bpm/bpm_base`, `bg/bg_inverse` | six artist overrides; four BPM overrides; background overrides are counted in song analysis |
| difficulty-specific jacket night | difficulty `jacket_night` | three records; semantic role is not a normal difficulty class |
| ratingClass composition | all normal compositions are PST/PRS/FTR with optional BYD or ETR; no only-BYD/only-ETR record found | `particlearts` is the one incomplete/deleted structural record |

The special-case output has 99 evidence rows, with per-case counts in `data/arcaea-special-song-summary.json` and detail in `data/arcaea-special-song-cases.csv`.

## 7. Artwork Variant and jacket mapping

Song-local jacket files are under `assets/songs/<id>/` or `assets/songs/dl_<id>/`. In the audited sample, 543 songs have a default `base`/`1080_base` jacket; 50 songs have numeric image variants; the raw difficulty records contain 57 true `jacketOverride` flags across 50 songs. A `jacketOverride=false` record also exists (`quonwacca` BYD), so presence of the key is not equivalent to true override.

The APK supplies the strongest relation through the combination `songlist.id` → song directory, difficulty `jacketOverride` → alternate candidate, and the actual `base`, `0`, `1`, `2`, `3`, `4` files. It does **not** contain a direct string field saying `jacket file = 1080_base_3.jpg`. The current project’s numeric mapping follows the ratingClass order, but this audit keeps the mapping as an evidence-backed candidate rather than declaring every numeric suffix globally proven. `Last` is a strong local example: BYD override plus `1080_3.jpg`/`1080_3_256.jpg`.

`_256` is an actual lower-resolution/alternate file family in the APK. It is not proven to be a distinct artwork semantic variant; it should remain an unresolved rendition/quality marker until runtime code or multiple-version behavior proves more.

The current adapter itself marks `_256` as unresolved (`packages/domain/src/extractors.ts:261-270`) and maps `1080_base_N` to difficulty labels (`packages/domain/src/arcaea-update.ts:32-36`). This is a useful implementation clue, not a replacement for the APK evidence.

## 8. Pack model and pack covers

`assets/songs/packlist` contains 61 pack records. `song.set` is the direct pack ID relation. Pack names/descriptions are localized objects; `packOrder` in the audit is the array order because no separate order key was found. Fields include `pack_parent`, `section`, `is_extend_pack`, `is_active_extend_pack`, `custom_banner`, `small_pack_image`, `cutout_pack_image`, `plus_character` and limited-sale fields.

There are 195 image files under `assets/songs/pack/`. They are not all formal covers: the relation table has 44 main/small-select cover rows covering 41 unique pack IDs, 81 matched select/divider/overlay UI rows, and 70 image files that remain unmatched. The pack-to-cover join is path-ID based and `Confirmed` when the stem matches `packlist.id`; `custom_banner`/cutout semantics are metadata flags and not automatically equated to one image file.

See `data/arcaea-pack-cover-relations.csv`, `data/arcaea-pack-cover-summary.json` and the original `data/arcaea-pack-records.csv`.

## 9. Side, version, date and idx

### 9.1 Side

| raw side | song count | audit label | confidence/evidence |
| --- | --- | --- | --- |
| 0 | 255 | Light | High: group/background alignment + external cross-check |
| 1 | 275 | Conflict | High: group/background alignment + external cross-check |
| 2 | 6 | Colorless / Achromic | Medium: APK group + runtime Colorless strings; external terminology; no numeric enum table |
| 3 | 7 | Lephon | High: seven-song Lephon group; preserve raw value |
| missing | 1 | unresolved | particlearts deleted/incomplete record |

No literal `side enum = label` table was found in the structured songlist. Native `lib/arm64-v8a/libcocos2dcpp.so` strings do provide runtime/UI evidence for `Light Side`, `img/bg_colorless.jpg`, `img/bg_byd_light.jpg`, `img/bg_glow_lephon.png` and `LephonHelper`, while `ratingPlus`, `ratingClass`, `jacketOverride` and `hidden_until` also appear as readable field/UI strings. The APK/runtime string uses `Colorless`/`colorless`; current external terminology may call the same side `Achromic`, so the label itself is version/locale-sensitive. This confirms the label/path families but not a decoded numeric enum table. The labels above are therefore an APK grouping interpretation, not a replacement of `sideRaw`; derived `sideLabel` should remain nullable or explicitly marked derived. See `data/arcaea-side-runtime-search.json`. The six raw-side-2 IDs are Testify, Loveless Dress, Last, Last | Eternity, Callima Karma and To the Furthest Dream. Raw-side-3 IDs are Swan Song, Renegade, Rays of Remnant, Breach of Faith, Lament Rain, Designant. and Astral Quantization.

### 9.2 Version/date/idx

`version` is a string and must remain a string (`6.10` must not become numeric `6.1`). `date` values behave as Unix epoch seconds in sampled records: `sayonarahatsukoi` 1487980800 → 2017-02-25 UTC; `last` 1657756801 → 2022-07-14 UTC; `zephyrlast` version `6.10`, date 1763769602 → 2025-11-22 UTC. The field is therefore a release/addition timestamp candidate, not APK build time; exact product display timezone is not encoded here.

`idx` is unique for 544 records, ranges 0–545, has gaps 492 and 544, contains a deleted `particlearts` record and one array-order inversion 406→400. It is a strong internal ordering key in this APK, but not a guaranteed permanent public rank. See `data/arcaea-index-quality.json`.

## 10. Localization and search aliases

Song title localization fields are present for 543 normal records. Observed title locale keys include `en`, `ja`, `ko`, `kr`, `zh-Hans`, `zh-Hant`, and dialog-specific keys `ko_dialog`, `zh-Hans_dialog`, `zh-Hant_dialog`. `search_title` appears on 541 records and `search_artist` on 542. `packlist.name_localized`/`description_localized` have multiple locale keys, including the same East Asian locales.

Recommended future search alias layers: primary display title from `title_localized` (locale-selected), alternate title values from the remaining locale keys, raw `search_title`, artist plus `search_artist`, and pack `name_localized`. Do not flatten all locale values into one displayed title. Character `search_strings` are similarly useful aliases but are not locale-tagged in the APK; retain the original array.

## 11. Character resources

`assets/char/characters.json` contains 98 character metadata records. The image relation table covers 420 image assets under `assets/char/`. Numeric path prefixes join to `character_id`; `pack_id`, `version_from`, `uncap_version_from`, `name`, skill fields and `search_strings` come from the JSON. The JSON has search/localized strings but no separate locale-labelled display-name object.

| observed family | count/evidence | semantic result |
| --- | --- | --- |
| 1080 main character art | 139 image-index entries | path-confirmed character main/full-art family |
| other 1080 character art | 151 image-index entries | variant/skill/mask/auxiliary families; suffix semantics vary |
| avatar/icon | 130 image-index entries | `*_icon` path-confirmed avatar/icon family |
| _mp preview | 148 | multiplayer character preview; `-1_mp` is a placeholder candidate |
| uncap candidate | 27 | numeric `u` suffix + uncap metadata is high-confidence candidate, not universal proof |

The 139/151/130 image counts are image-index classifications; the 420-row relation table is the file-level audit. Within the relation table, 96 numeric `assets/char/1080/<id>.png` files are exact main-art rows; the image-index category also contains 43 non-numeric/variant paths, so the category count and semantic-role count are intentionally different. The relation table preserves `variantRaw` for suffixes such as `u`, `o`, `l`, `skill`, `mask`, `s1`, `s2`, `angry`, `cut` and `twisted`. Only main-art/icon/_mp role names are path-confirmed; less common suffix semantics remain Medium/Unresolved. See `data/arcaea-character-relations.csv` and `data/arcaea-character-summary.json`.

## 12. Story, CG and VN resources

The story system has three useful metadata layers:

1. `assets/app-data/story/main|side/entries_*`: entry metadata (`minor`, `storyType`, `clearSongId`, `requiredPurchase`, character icon IDs, `storyCgPath`, `storyData`, BGM/playable-song overrides).
2. `assets/app-data/story/paths`: path type/main/act/character-icon records.
3. `assets/app-data/story2/ordering`: act/path title/type/characters/node ordering, e.g. `20-1`…`20-8` → Lucent Historia and `23-*` → Liminal Eclipse.

| resource layer | audited count | relation result |
| --- | --- | --- |
| story entry metadata | 186 | entry→node/path/act/order/clearSongId when ordering key matches |
| story CG | 57 | 45 referenced by `storyCgPath`; 12 not referenced by that field |
| VN scripts | 55 | 6270 show/hide/move/play/stop/volume references; 6010 resolved to APK paths |
| VN text data | main/vn + side/vn | localized story text keyed by story nodes; text was not copied into the report |

Classification used: `story-cg` = `assets/app-data/story/cg/*`; `story-vn-resource` = `assets/app-data/story/vn/res/*` referenced from `.vns`; `story-ui-or-texture` = `assets/img/story/*` runtime/UI image family. A CG can be associated to an entry/path with `Confirmed` evidence when `storyCgPath` names it. The 12 unreferenced CG files remain Unresolved rather than being assigned by filename alone.

VN parsing was structural only. Representative command references include `show`, `hide`, `move` and `play`; locale suffixes are `en`, `ja`, `ko`, `zh-Hans`, `zh-Hant`. See `data/arcaea-story-resource-relations.csv`, `data/arcaea-story-vn-references.csv` and `data/arcaea-story-summary.json`.

## 13. Background

`assets/img/bg/` contains 293 image assets. Song-level and difficulty-level `bg`/`bg_inverse` keys were matched to basename stems under `assets/img/bg/`; the relation table has 1029 reference rows, of which 1029 resolve to an asset. Remaining images are retained as unreferenced/role-candidate rows. Suffixes such as `clear`, `light`, `conflict`, `boss`, `nightmare`, `debris`, `wagd` and `srt` are preserved; they are not all song identities.

This separates song→background metadata from visual guesses. See `data/arcaea-background-relations.csv` and `data/arcaea-background-summary.json`.

## 14. World Mode

`assets/img/world/` has 91 images. Numeric groups and `1080/` main-art/UI paths are distinguishable. `_b`, `_d`, `_t` are retained as background/decor/tile role candidates with Medium confidence; the audited structured data did not provide an authoritative suffix enum. The report therefore does not claim that every `_b/_d/_t` meaning is proven.

See `data/arcaea-world-relations.csv` and `data/arcaea-world-summary.json`.

## 15. LinkPlay / multiplayer

`assets/img/multiplayer/stickers/` has 99 sticker images. The parser checks `_sc_tc` before `_tc` and preserves the raw suffix in `rawLocaleSuffix`: `_jp`/`_kr` become `normalizedLocale=ja/ko` only as an audit-derived search label; they are not renamed in the raw field. Character `_mp` files form a separate character-preview relation; UI/runtime multiplayer images remain low suitability for an archive. See `data/arcaea-linkplay-relations.csv` and `data/arcaea-linkplay-summary.json`.

## 16. Pack cover, startup, course and other runtime assets

Pack covers and state images are mapped in Section 8. `assets/startup/` has 55 entries (51 image-index category entries); `assets/img/course/` has 136 files including course banners, difficulty icons, timers and UI decorations. These are runtime/UI assets without a demonstrated song foreign key; public archive suitability is Low unless a future review intentionally publishes them as non-song assets.

Other major non-song runtime groups are `assets/layouts/` (1,674), `assets/audio/` (136), `assets/voice/` (14), `assets/models/` (20), `assets/particle/` (11), fonts and Cocos Studio screen data. The semantic inventory keeps all file-level entries; unclassified structured/text and binary files are not silently discarded.

## 17. Existing extractor / Catalog / public projection audit

The following is a static code comparison, not a code change. Evidence paths are production files in the repository; they were read only.

| APK information | APK evidence | current extractor | Catalog / Public projection |
| --- | --- | --- | --- |
| songId | songlist.id; directory `<id>`/`dl_<id>` | Yes: `packages/domain/src/extractors.ts:261-313` | Catalog externalIdentity can preserve it; public metadata allowlist includes `songId` |
| title/localization/search aliases | songlist title_localized/search_title/search_artist | Primary title read; complete alias set not emitted | Public search uses stored metadata/aliases, but locale/search fields are not systematically projected |
| artist | song-level and six difficulty overrides | Yes for selected context | Public allowlist includes artist |
| pack/set | songlist.set → packlist.id/name_localized | Pack ID for pack-path candidates; song pack foreign key not fully emitted | Public allowlist includes pack/packName if already stored |
| Difficulty Class | ratingClass 0–4 | Filename-derived `1080_base_N` context only | Variant difficulty can be stored, but full song difficulty table is not public |
| Display Level | raw rating + ratingPlus | Not emitted by current adapter metadata | Not present as a dedicated public field |
| Chart Constant | not found in audited APK | Not available; must not be fabricated | Not available |
| jacket variants | base/numeric/_256 + override flags | Main target is `1080_base[_N]`; `_256` marked unresolved | Variant records can exist, but source semantic link is incomplete |
| side | raw 0/1/2/3 + one missing/deleted record | Not emitted | Public allowlist has side only if upstream stored it |
| version/date/idx | song/difficulty structured fields | Not emitted as complete song metadata | No guaranteed public fields |
| character/story/background/world/LinkPlay | separate APK relations produced this pass | Target categories exist in `arcaea-update.ts:11-20`; relations/metadata are not fully joined | Some generic categories/metadata keys exist, but no full relation graph is projected |

The current source inventory target list is in `packages/domain/src/arcaea-update.ts:10-20`; its metadata object is empty at source-inventory creation (`:89-102`). The legacy adapter reads songlist/packlist/characters (`packages/domain/src/extractors.ts:287-313`) but emits a limited candidate metadata object (`:336-353`). The public allowlist is `apps/site/src/lib/catalog-projection.ts:8-28`; filename parsing remains in `apps/site/src/lib/public-display.ts:9-73`. The audit conclusion is therefore “APK has more structured data than the current public projection guarantees”, not “Catalog schema cannot hold it”.

## 18. Stable Resource Identity

Recommended primary identity candidate: `namespace=arcaea`, `key=songId`, `value=songlist.id`. It is unique for normal records, directly joins song directories, pack/set, chart records and jacket/audio paths, and its content hash is stable between the local 6.16.0c and 6.16.8c samples for `assets/songs/songlist`, `packlist`, `unlocks` and `characters.json`. Preserve `idx` as a separate ordering field, not identity. For characters use `character_id`; for packs use `packlist.id`; for story nodes use `story path/chapter/minor` or ordering node key, not CG filename alone.

Version stability evidence: `data/arcaea-version-comparison.json`. It is still only a two-version local sample; a future incremental updater should compare raw metadata hashes plus path/content hashes and keep a changed-resource review queue.

## 19. Implications for Rhythm Archive

Reliable future extraction candidates from this APK are: `songId`, locale-aware title/search aliases, artist, `set`/pack, raw side, BPM string/base, string version, Unix date candidate, idx, Difficulty Class, Display Level, chartDesigner/jacketDesigner, raw unlock flags, jacket/audio/background override fields and the path-level jacket/audio/AFF relations. Chart Constant is not one of them until a separate source is found.

For a future data model, keep song metadata, difficulty record, playable-chart/body, music variant and artwork variant conceptually separate. The Last family demonstrates why a difficulty title/audio/jacket override can live inside one song record while another conditional BYD lives under a related song ID. This report does not prescribe a Catalog schema change.

## 20. Unknown / unresolved inventory

Unresolved does not mean omitted. The full semantic inventory contains every APK entry. Current high-impact unresolved items are: Chart Constant source; universal runtime playability logic beyond the audited placeholder rule; exact `Last` audio-to-conditional-BYD assignment; global semantic mapping of numeric jackets and `_256`; literal side enum/UI code; 12 CGs not named by `storyCgPath`; `_b/_d/_t` world suffix meanings; some character suffixes; and remote/downloaded chart content absent from this APK.

Existing unresolved file clusters are summarized in `data/arcaea-unresolved-summary.csv`; this pass adds targeted unresolved rows in the special, character, story, world, background and pack relation CSVs.

## 21. External references / cross-checks

All were accessed on 2026-08-18 and are recorded with purpose in `data/arcaea-external-references.json`:

- [ArcaeaChartRender](https://github.com/Arcaea-Infinity/ArcaeaChartRender): rating/ratingPlus versus separate renderer constant.
- [Arcaea Wiki: Last](https://arcaea.fandom.com/wiki/Last): Last family display-level/constant cross-check.
- [Arcaea Wiki: Songs data](https://arcaea.fandom.com/wiki/Songs_data): field distinction cross-check.
- [Arcaea Wiki*: Last](https://arcwiki.mcd.blue/index.php?title=Last): two BYD/audio-family cross-check.
- [Arcaea Wiki: Song Backgrounds](https://arcaea.fandom.com/wiki/Song_Backgrounds): side/background label cross-check.
- [Arcaea Wiki*: Pack order](https://arcwiki.mcd.blue/index.php?title=Pack_order): pack-order context cross-check.

External material explains terminology only; APK evidence remains authoritative for this report.

## 22. Reproducibility checklist

- Main APK SHA-256 was checked before/after and remains the value in Section 1.
- `arcaea-files.csv` has 7,320 non-directory ZIP entries; generated inventory paths are APK-relative.
- CSV outputs are UTF-8; raw and derived difficulty fields are separate.
- No APK, unpacked tree or exported proprietary asset was added to the repository.
- No production business code was modified.

## 23. April Fools / seasonal Error Track source model correction

The regular/persistent song model remains `assets/songs/songlist.songs[]` → `songlist.id` → `assets/songs/<id>` or `assets/songs/dl_<id>`. The 2018–2026 April Fools registry shows why that source is not a historical exhaustive set of every legal game song/resource:

- 2018–2021 special tracks are represented in the audited APK through the base song records `ignotus`, `redandblue`, `singularity` and `dropdead`, each with a BYD-level title/audio/jacket override. Their current numeric artwork and override flags are APK evidence for a permanent BYD representation, not proof that the seasonal Error Track was originally a normal independent Song entity.
- 2022, 2023, 2024, 2025 and 2026 special titles have no separate Error Track `songlist.id` in APK `6.16.8c`. Their base songs (`maliciousmischance`, `ifi`, `hivemind`, `livefastdieyoung`, `unknownlevels`) are present, but the special seasonal records/artwork are not current regular song records in this APK.
- The current Catalog contains curated special artwork for all nine baseline entries. Five Catalog Resources are now audit-classified `april-fools-special-song-artwork`; the early four remain `current-difficulty-artwork` with `specialType=april-fools` because their pixels and APK BYD relation are current. Seven additional related rows are retained as `legacy-duplicate-candidate`.
- `HIVEMIND INTERLINKED` is retained as `mashup-of` with primary base `hivemind`; it is not flattened into a single-source remix relation.
- `Ignotus Afterburn 2` is not in the formal nine-entry registry. Its absence from APK/Catalog would be expected for the external teased/fake/cancelled joke entry.

Therefore, an updater must not interpret `not present in current songlist → removed song` without distinguishing regular song, seasonal special, historical seasonal artwork and permanent BYD representation. This is an audit implication only; Phase 6/7 behavior was not changed.

Machine-readable evidence: `data/arcaea-april-fools-registry.csv`, `data/arcaea-april-fools-artworks.csv`, `data/arcaea-reconciliation-summary.json` and the `aprilFoolsSpecialArtworks` section in `data/arcaea-song-browse-projection.preview.json`.

External cross-checks, accessed 2026-08-19: [Arcaea Wiki April Fools category](https://arcaea.fandom.com/wiki/Category:April_Fools), [Ignotus Afterburn](https://arcaea.fandom.com/wiki/Ignotus_Afterburn_%28April_Fools%29), and [HIVEMIND INTERLINKED](https://arcaea.fandom.com/wiki/HIVEMIND_INTERLINKED). They define player-facing seasonal semantics; `assets/songs/songlist`, difficulty records, APK paths and Catalog reconciliation remain the internal evidence.
