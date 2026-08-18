# Phigros Data Quality and Browse Readiness

本表把“数据技术上可获得”与“建议向普通用户公开使用”分开。它不授权修改 Catalog、Public projection 或 Gallery。

## 1. Field readiness

| field / capability | Data Capability | source | coverage / evidence | Recommended Public Usage |
| --- | --- | --- | --- | --- |
| title | Available | Track folder/key tokens | 319 current Track records；不是 canonical song table | Recommended for display/search, with original key retained |
| artist | Available | Track folder/key tokens | 319 current Track records；rename/escaping semantics未跨版本验证 | Recommended for display/search, review unusual separators |
| illustration reference | Available | Addressables `Assets/Tracks/<folder>/Illustration.jpg` | 313 main-image folders；Blur/LowRes are related renditions | Recommended for artwork display; keep logical key internal |
| music reference | Available | Addressables `Assets/Tracks/<folder>/music.wav` | 319 Track folders | Internal source relation; public audio exposure is product policy, not audit conclusion |
| Difficulty Class | Available | `Chart_EZ/HD/IN/AT/Legacy.json` keys | EZ319, HD318, IN318, AT46, Legacy4 | Recommended facet; distinguish key existence from unlock/playability |
| chart existence | Available/Partial | Addressables key + parsed TextAsset | structurally non-empty: EZ319, HD318, IN318, AT46, Legacy4 | Recommended internal metadata; public facet optional after special-chart review |
| Display Level | Partial | IL2CPP `LevelInfo.level/difficulty`, `SongListItem.SetRating*` candidates | 0/319 numeric per-track values recovered | Not ready for public level facet; do not fill from external tables |
| Internal Constant | Unavailable | searched chart JSON, Addressables, IL2CPP names | no reliable field found | Not recommended; remain unavailable |
| Chapter / Collection | Partial | IL2CPP `ChapterSongInfo.songs[]`, `ChapterSongItem.songsId`, 89 cover keys | structure found; instance Track→Chapter relation unresolved | Internal candidate only; public facet needs review |
| Track identity | Partial | full Track folder / Addressables logical key | unique within current APK; cross-version unavailable | Internal identity only until APK pair validation |
| Addressables key | Available | `assets/aa/catalog.json` | unique current logical resource keys with bundle dependencies | Internal only; not a normal user facet |
| folder index | Available as raw token | Track folder suffix | 312/319 are `0`; not unique | Internal diagnostic only; do not expose as order/ID |
| BPM | Available/Partial | chart judge-line `bpm` | chart-level values; some songs have multiple values | Optional internal metadata; not primary facet without aggregation rule |
| version / release date | Unavailable | APK version only | no per-song release field found | Not ready |
| illustrator | Unavailable | no reliable Track-level field recovered | no standalone field in audited high-level sources | Not ready |

## 2. Recommended future browse minimum

Current evidence supports a future internal/public preview with:

- title and artist search;
- illustration relation;
- Difficulty Class facet based on non-empty chart-resource evidence;
- optional chart-presence marker;
- internal Track logical key for provenance and diff.

It does **not** yet support a reliable public facet for Display Level or Chapter. A future implementation should keep `displayLevel` nullable and distinguish `chartKeyPresent`, `chartStructurallyNonEmpty`, and `playable/unlocked`.

## 3. Data quality blockers

1. Restore serialized `ChapterSongInfo.songs[]` / `ChapterSongItem.songsId` instances or another APK-side table before claiming chapter coverage.
2. Recover the numeric source feeding `LevelInfo.level`/`SongListItem.SetRating` before exposing level filters.
3. Obtain an adjacent APK pair and compare full Track keys, title/artist changes, chapter records, illustration keys and chart presence.
4. Keep `Random.SobremSilentroom.0..6`, Error chart variants and Legacy as explicit special cases.

## 4. Current extractor loss

The current extractor can preserve Addressables/image provenance and derive title/artist from keys, but it does not expose a verified level source, chapter relation, full chart-key availability, or special chart status. These are audit findings only; no production code was changed.

