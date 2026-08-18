# APK Comparison and Rhythm Archive Implications

> Scope: local Arcaea 6.16.8c (with a small 6.16.0c stability sample) and Phigros 3.19.5. This is a read-only audit report; it does not implement extractor, Catalog, Gallery or updater behavior.

## 1. Corrected metadata comparison

| dimension | Arcaea | Phigros | implication |
| --- | --- | --- | --- |
| primary resource layer | Cocos2d-x/Cocos Studio paths + JSON-like songlist/packlist/unlocks | Unity IL2CPP + Addressables catalog/bundles/SerializedFiles | Arcaea path/metadata joins are direct; Phigros needs catalog/object provenance |
| song identity | `assets/songs/songlist.id` for regular records; April Fools may be seasonal or permanent-BYD related | Addressables full Track folder/key candidate; no explicit domain song ID proven | Arcaea regular identity is high confidence but not historically exhaustive; Phigros requires an APK pair |
| song title/artist | structured localized title + artist/search fields | key-derived title/artist plus chart TextAsset context | Arcaea can retain aliases directly; Phigros should preserve original key |
| difficulty class | ratingClass → PST/PRS/FTR/BYD/ETR | Chart_EZ/HD/IN/AT/Legacy key suffix | both can expose class labels with source evidence |
| Display Level | Yes: raw `rating` + raw `ratingPlus` → derived `displayLevel` such as 9+ | Partial structure evidence (`LevelInfo.level/difficulty`, `SongListItem.SetRating*`), numeric values unresolved | do not treat these as equivalent completeness |
| Chart Constant | Not found / unresolved in audited APK metadata; never derive from rating | unresolved; chart JSON has no reliable level/rating/constant field | neither should be filled from external tables without an explicit source |
| chart body | 102 AFF entries; 100 map to songlist difficulty records, many charts remote/download gated | 1,008 chart TextAssets across EZ/HD/IN/AT/Legacy | body availability and metadata playability must be separate |
| jacket/illustration relation | song ID/dl_ID directory + jacket patterns + override flags | catalog key → dependency bundle → Texture2D/Sprite | Arcaea is easier but numeric jacket semantics still need review |
| pack/chapter | song.set → packlist.id; 61 packs | IL2CPP `ChapterSongInfo.songs[]` / `ChapterSongItem.songsId` structure found, instance Track→Chapter foreign key unresolved | Arcaea pack facet is ready; Phigros chapter facet is not ready |
| version/release | song/difficulty string version/date/idx fields | APK version only; no per-song release field found | Arcaea can expose source fields with provenance |
| runtime model | Cocos2d-x + FMOD native code | Unity 2022.3.62f2 IL2CPP + Addressables | toolchains should remain game-specific |

## 2. Reliability and automation

| capability | Arcaea | Phigros | reason |
| --- | --- | --- | --- |
| discover main image | Yes | Yes | direct song image paths versus catalog Texture2D provenance |
| stable song identity | High for regular songlist records; Partial for seasonal special relations | Partial/current-only | Arcaea `songlist.id` is unique for regular records; Phigros full Track key is unique only in one APK |
| display title/artist | High | Partial | structured localization versus key-derived values |
| Difficulty Class | High | High | explicit ratingClass / Chart_* key suffixes |
| Display Level | Yes | Partial structure / Not ready values | Arcaea `rating`/`ratingPlus`; Phigros UI/model fields found but no numeric track values |
| Chart Constant | Not ready | Not ready | not present as a reliable audited field |
| pack/chapter facet | Yes | Not ready | direct Arcaea set→packlist relation versus Phigros unresolved instance chapter FK |
| artist/search aliases | Partial/High | Partial | Arcaea has fields but current public projection is incomplete; Phigros key parsing needs review |
| incremental updater | High for songlist/packlist IDs; medium for jacket semantics | Partial | Arcaea metadata hashes stable in two samples; Phigros bundle hashes/key changes need adjacent sample |
| manual review | Required for variants/special families/side label | Required for key-derived semantics/chapter relation | unresolved evidence must remain explicit |

## 3. Arcaea-specific consequences

- Use `songlist.id` as the leading resource identity candidate; keep `idx` as raw order metadata.
- Store raw `rating` and raw `ratingPlus`; derive a Display Level string only in audit/consumer code. Do not call either field a Chart Constant.
- Keep difficulty record slots separate from metadata-defined playable records and from locally bundled AFF bodies.
- Model artwork relations independently from chart relations. `Last | Moment` is a difficulty-level override under `last`; `Last | Eternity` is a separate record with inactive PST/PRS/FTR slots and a BYD record.
- Keep regular/persistent songlist records separate from seasonal April Fools Error Tracks. The current APK proves direct permanent BYD relations for 2018–2021, while 2022–2026 special records are absent from current songlist; absence must not be treated as removal. See `data/arcaea-april-fools-registry.csv`.
- Pack filtering can rely on `song.set` plus packlist, but numeric jacket and `_256` meaning remain review work.

## 4. Phigros-specific consequences

- Addressables catalog key → bundle → Unity object provenance remains the necessary relation chain.
- Chart difficulty labels are available from Chart_* TextAssets, but the audited JSON did not expose Display Level or Chart Constant.
- IL2CPP metadata confirms a `Chapter`/`ChapterSongInfo`/`ChapterSongItem` structure and `LevelInfo`/`SongListItem` level-related members; no serialized Track→Chapter values or per-track numeric levels were recovered.
- Do not infer chapter, level or constant from the track title, folder index, cover order or visual image.

## 5. Current project loss / retention boundary

| information | Arcaea APK | current project/public state | audit conclusion |
| --- | --- | --- | --- |
| songId | confirmed | candidate externalIdentity and public songId allowlist exist | mostly retained where candidate path is processed |
| Display Level | confirmed from rating/ratingPlus | Phigros numeric source unresolved; Arcaea not emitted as dedicated structured field | Arcaea is a project projection gap; Phigros source gap remains unresolved |
| Chart Constant | not found | not emitted | not a project loss; source is unresolved |
| full difficulty records | confirmed | only filename-derived difficulty variants are adapted | most raw chart metadata is not retained |
| pack/localization/unlock | confirmed | partial pack/path metadata; no complete relation graph | partial loss |
| jacket variant evidence | confirmed but some semantics unresolved | main base/N mapping plus `_256` unresolved marker | partial loss and review required |
| character/story/background/world relations | confirmed in this audit | category targets exist but joins are not fully projected | audit data is richer than current public state |
| Phigros level/constant | level-related IL2CPP UI/model fields found; numeric values and constant not found | not emitted | source values remain unresolved; do not fill from external tables |

## 6. What is now decided versus still experimental

Decided from current evidence: Arcaea raw/derived level terminology; separate Chart Constant status; separate slot/playability/AFF counts; regular `songlist.id` identity candidate; seasonal April Fools versus permanent BYD distinction; pack `set` relation; raw/derived side handling; story entry→CG/path relation where fields exist; locale sticker grouping; Phigros Chart key existence versus playability separation.

Still experimental: universal runtime playability logic across future versions; conditional Last audio identity; global numeric jacket and `_256` semantics; literal side enum source; unreferenced story CGs; world suffix definitions; Phigros Display Level values, chapter instance relation, cross-version key/identity stability, rename handling and special chart lifecycle. No implementation is authorized by this report.

## 7. Evidence files

Arcaea deepening data is under `docs/apk-audit/data/`, especially `arcaea-difficulty-records.csv`, `arcaea-special-song-cases.csv`, `arcaea-last-family.csv`, `arcaea-april-fools-registry.csv`, `arcaea-april-fools-artworks.csv`, `arcaea-character-relations.csv`, `arcaea-story-resource-relations.csv`, `arcaea-story-vn-references.csv`, `arcaea-background-relations.csv`, `arcaea-world-relations.csv`, `arcaea-linkplay-relations.csv`, `arcaea-pack-cover-relations.csv` and the corresponding summaries. Phigros targeted evidence is in `phigros-track-metadata.csv`, `phigros-high-level-class-evidence.csv`, `phigros-identity-candidates.csv`, `phigros-il2cpp-metadata-summary.json`, `phigros-cross-version-summary.json` and the existing Addressables/chart files.

## 8. Targeted model boundary

```text
Arcaea
APK songlist regular record
├─ songId → song folder / default artwork / pack / charts
├─ difficulty records → Display Level + override fields
└─ seasonal April Fools special
   ├─ permanent BYD relation (2018–2021 in current APK)
   └─ seasonal/catalog-only relation (2022–2026 in current APK)

Phigros
Addressables Track folder/key
├─ Illustration / music / Chart_* resources
├─ IL2CPP Chapter model structure (instance FK unresolved)
├─ IL2CPP Level UI/model fields (numeric values unresolved)
└─ special/error/Legacy chart keys
```

The minimum future browse projection differs: Arcaea can use regular song identity, Pack and Display Level now; Phigros can use current title/artist, illustration and Difficulty Class, but not yet verified level or chapter facets. This is an audit conclusion, not a production schema proposal.

External cross-checks used in this pass, accessed 2026-08-19: [Arcaea Wiki April Fools category](https://arcaea.fandom.com/wiki/Category:April_Fools), [Arcaea Wiki HIVEMIND INTERLINKED](https://arcaea.fandom.com/wiki/HIVEMIND_INTERLINKED), [Il2CppDumper metadata layout](https://github.com/Perfare/Il2CppDumper/blob/master/Il2CppDumper/Il2Cpp/MetadataClass.cs), [Cpp2IL IL2CPP data structures](https://github.com/SamboyCoding/Cpp2IL/wiki/IL2CPP-Data-Structures), and [Unity Addressables ContentCatalogData](https://docs.unity.cn/Packages/com.unity.addressables%402.11/api/UnityEngine.AddressableAssets.ResourceLocators.ContentCatalogData.html). They explain player-facing or technical semantics only; APK/local audit data remains authoritative.

No business code, Gallery, Public Site, Catalog, extractor production logic, Phase 6/7 code or Git history was changed.

## 9. Final Catalog reconciliation pass

The final read-only reconciliation uses the current formal Catalog SHA-256
`a5733ec270d4871fb1de5102e6576a91785594fc721c90d0238ea9a6e2301dc4` for both
games. Arcaea remains closed at 603 jacket Resources with
`confirmed=596`, `high=1`, `medium=1`, `unmatched=5`. The two corrected rows,
`HIVEMIND INTERLINKED` and `Live Faster Die Younger`, are unmatched as current
APK artwork; their high-confidence base-song relation is retained separately.

Phigros 3.19.5 has 501 Catalog resources: 320 ordinary `jacket`, 33
`phigros-april-fools`, 107 avatars and 41 pack covers. The APK has 319 Track
records and 313 primary Illustration slots. All 313 primary slots have at
least one Catalog coverage row; 312 are single covered slots and one has two
legitimate cross-category Catalog matches (`After ZABANIYA (MUG Edit)」`, a
normal jacket plus an April Fools Resource with exact decoded pixel/object
equality). Seven ordinary jacket Resources are not present in this current
APK image set and remain historical/unmatched candidates. The 33 April Fools
Resources are kept semantically separate even where a source image is shared
with a current Track.

The Phigros evidence files are `data/phigros-catalog-resources.csv`,
`data/phigros-apk-current-track-artworks.csv`,
`data/phigros-catalog-reconciliation.csv`,
`data/phigros-apk-to-catalog-coverage.csv`,
`data/phigros-display-metadata-review.csv` and
`data/phigros-track-browse-projection.preview.json`. They preserve source
title/artist from the Addressables key separately from curated Catalog
displayTitle. Display Level and Chapter remain null/unresolved, and the
Track path remains a current-APK identity candidate until a second APK is
available.

## 10. Minimum game-specific browse contract (audit recommendation)

| field | Arcaea song-centric projection | Phigros track-centric projection |
| --- | --- | --- |
| grouping identity | `songlist.id` for regular records; special relations separate | `sourceIdentityCandidate` from full Track path/key only |
| public display title | localized songlist title plus aliases | Catalog `displayTitle`, with sourceTitle retained internally |
| artist | songlist artist/search fields | sourceArtist candidate; canonical artist remains nullable |
| artwork | default/difficulty/special relation with existing Resource ID | primary Illustration Resource ID; Blur/LowRes are derived evidence |
| difficulty class | PST/PRS/FTR/BYD/ETR | EZ/HD/IN/AT/Legacy structural keys |
| Display Level | available from `rating + ratingPlus` | nullable/unresolved |
| pack/chapter | Pack relation available from song.set/packlist | chapter/collection nullable/unresolved |
| special content | April Fools vs permanent BYD explicitly separated | April Fools, Random family, Introduction, Error and Legacy explicitly separated |
| identity promotion | regular songId strong; special artwork remains separate | wait for cross-version validation |

This table is an audit boundary, not a production schema change. It does not
authorize Catalog migration or Gallery implementation.
