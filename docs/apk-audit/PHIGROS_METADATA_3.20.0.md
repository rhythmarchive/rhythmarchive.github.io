# Phigros 3.20.0 GameInformation metadata baseline

本文件记录 Phigros 3.20.0 APK 内的曲包、曲目、难度和详情元信息，供下一次 APK 更新做 baseline。源 APK 保持只读。

## Source

- APK: `apk/Phigros_3.20.0.apk`
- package: `com.PigeonGames.Phigros`
- versionName/versionCode: `3.20.0` / `154`
- SHA-256: `15f410d39dc8189dd6295488c1f1607665bfa7971f5587cc61257924327ab82d`
- GameInformation: `assets/bin/Data/level0`, MonoBehaviour pathId `49`
- Unity: `2022.3.62f2`; Addressables: `1.22.3`; IL2CPP metadata: v31

## Recovered records

- 33 chapters and 314 chapter-song rows;
- 315 `SongBase` songs: `mainSongs=45`, `extraSongs=247`, `sideStorySongs=22`, `otherSongs=1`;
- `Introduction` is in `otherSongs` but not in a chapter;
- `Random.SobremSilentroom.0..6` are Addressables special-family tracks outside SongBase;
- 855 Key records and 111 legacy combo records;
- serialized object parse closed at `155980 / 155980` bytes.

`SongsItem.difficulty[]` is indexed by `SongsItem.levels[]`. Non-zero difficulty coverage is EZ 315, HD 314, IN 314, AT 47, Legacy 4. The 1,015 `Chart_*` TextAssets contain chart structure/BPM/offset but no level/rating/constant source; display difficulty therefore comes from GameInformation, while chart key existence/content comes from Addressables.

## Versioned evidence

- `data/phigros-gameinfo-3.20.0.json`
- `data/phigros-gameinfo-summary-3.20.0.json`
- `data/phigros-gameinfo-chapters-3.20.0.csv`
- `data/phigros-gameinfo-chapter-song-map-3.20.0.csv`
- `data/phigros-gameinfo-song-difficulty-3.20.0.csv`
- `data/phigros-gameinfo-catalog-chart-crosscheck-3.20.0.json`
- `data/phigros-chart-schema-stats-3.20.0.json`

Future updates should match by `songsId`/Track path first, then diff chapter membership, composer, illustrator, charter, difficulty, chart keys, and unlock fields. Do not infer pack or difficulty from jacket filenames alone.
