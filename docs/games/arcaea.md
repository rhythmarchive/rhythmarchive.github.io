# Arcaea

- Lifecycle: published; existing Catalog and shared site route.
- Source and engine: APK and legacy report inputs; the current package is a Cocos2d-x layout. Stable markers are assets/songs/songlist, assets/songs/packlist, assets/char/characters.json, and assets/app-data/story2/ordering.
- Adapter/extractor: adapterId arcaea-apk; packages/domain/src/extractors.ts legacy report adapter and tools/arcaea-apk-update.ts.
- Identity and scope: preserve song/source identity and existing Catalog Object/URL identity. Default scope includes jacket, pack cover, character, story/background categories subject to the profile selection policy; unresolved artwork remains review/diagnostic-only.
- Traps: filename markers such as IDX/BPM/SIDE are evidence, not public title text; 7.0 adds the Inscribed chart class. In the 7.0 songlist it is encoded as \`ratingClass=3\` plus \`ratingClassAlias=1\`, so only DREAD AREA, Riven Pilgrimage, Cataclysm Cry, and DEINOS PHAINEIN are Inscribed; the other 64 \`ratingClass=3\` rows remain BYD. \`rating\`/\`ratingPlus\` are display levels rather than chart constants; special April Fools relations and historical duplicates require review.
- Update strategy: reuse the adapter and previous published Manifest; require an actual source pair for cross-version claims and send removed or ambiguous items to review.
- Last validated assumptions: current profile and shared projection are local repository evidence; no production write is implied.
