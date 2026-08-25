# Arcaea

- Lifecycle: published; existing Catalog and shared site route.
- Source and engine: APK and legacy report inputs; current profile markers include globalgamemanagers, assets/bin/data, songs, and _metadata/songlist.json. Unity package evidence is handled by the existing Arcaea adapter.
- Adapter/extractor: adapterId arcaea-apk; packages/domain/src/extractors.ts legacy report adapter and tools/arcaea-apk-update.ts.
- Identity and scope: preserve song/source identity and existing Catalog Object/URL identity. Default scope includes jacket, pack cover, character, story/background categories subject to the profile selection policy; unresolved artwork remains review/diagnostic-only.
- Traps: filename markers such as IDX/BPM/SIDE are evidence, not public title text; special April Fools relations and historical duplicates require review.
- Update strategy: reuse the adapter and previous published Manifest; require an actual source pair for cross-version claims and send removed or ambiguous items to review.
- Last validated assumptions: current profile and shared projection are local repository evidence; no production write is implied.
