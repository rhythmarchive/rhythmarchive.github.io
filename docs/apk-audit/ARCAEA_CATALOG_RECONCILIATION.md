# Arcaea Catalog Reconciliation

> This is a read-only audit. It does not modify Catalog, Resource/Variant/Rendition/Object IDs, production extractor logic, public projection or Gallery.

## 1. Inputs

- Catalog: `catalog\index.json`; SHA-256 `a5733ec270d4871fb1de5102e6576a91785594fc721c90d0238ea9a6e2301dc4`; size 22377443 bytes; generatedAt `2026-08-14T13:57:23.100Z`.
- APK: `D:\Files\曲绘\Arcaea\APK\arcaea_6.16.8c.apk`; SHA-256 `c2b58dcad54203645057a859524789f59cfd5ca13613b610d04ad087b58aac90`; size 1867085903 bytes; modification time `2026-08-18 16:35:39 +08:00`; entries 7320; package `moe.low.arc`; version `6.16.8c/1209752`.
- Legacy evidence root: `E:\曲绘`; read-only source hash index used for provenance/pixel candidates.

## 2. Closed input counts

| measure | count | definition |
| --- | --- | --- |
| Catalog Arcaea jacket Resources | 603 | one row per current Catalog Resource |
| Catalog Variants | 603 | linked to those Resources |
| Catalog original Renditions | 603 | one original rendition per Resource in this snapshot |
| Catalog upscaled Renditions | 603 | derived rendition; not a new artwork identity |
| APK normal song records | 543 | songlist records excluding deleted/incomplete record |
| APK physical jacket image rows | 1208 | image-index rows under assets/songs/ |
| APK current song-linked semantic slots | 602 | base/numeric/special grouped with _256 as renditions |
| APK default semantic slots | 543 | one per normal song directory |
| APK difficulty-specific candidate slots | 57 | numeric files; 57 corresponding jacketOverride records |
| APK special candidate slots | 2 | base_night and base_ja candidates |
| APK non-song/unresolved image slots | 2 | random/tutorial or unlinked image directories |

The 603 Catalog count is not inferred from an old report: it is recomputed from the current `catalog/index.json`. It consists of 603 existing Resource identities, each with one Variant and original/upscaled rendition pairs. It is not equal to the number of physical APK files; the APK has multiple resolution files and special/numeric candidates.

## 3. Matching methodology

Matching is layered: (1) direct Catalog/provenance identity when available, (2) exact original Object SHA-256 against APK image SHA-256, (3) structured `songlist.id`/asset-directory/IDX evidence, (4) bounded decoded-pixel and normalized RGB 64×64 MAE comparison, and (5) title/artist only as a candidate generator. Title-only candidates are never marked Confirmed. `_256` is grouped as a rendition of a semantic slot and is not treated as a new artwork identity.

Pixel high-confidence threshold: normalized RGB 64×64 mean absolute error ≤ 2.0; decoded-pixel equality is recorded separately. Perceptual similarity was not used as sole identity evidence.

## 4. Catalog → APK

| matchStatus | count |
| --- | --- |
| confirmed | 596 |
| high | 1 |
| medium | 1 |
| unmatched | 5 |

### Semantic classification

| semanticStatus | count |
| --- | --- |
| current-default-artwork | 529 |
| current-difficulty-artwork | 57 |
| current-special-artwork | 2 |
| april-fools-special-song-artwork | 5 |
| legacy-duplicate-candidate | 7 |
| unresolved | 3 |

Every Catalog jacket Resource occurs exactly once in `arcaea-jacket-reconciliation.csv`; duplicate candidates are retained as separate rows and are not merged.

## 5. APK → Catalog

Current song-linked semantic slots are the expected artwork side. Random/tutorial slots remain in the inventory but are not counted as normal song artwork coverage.

| coverageStatus | count |
| --- | --- |
| covered | 581 |
| missing-from-catalog | 14 |
| multiple-catalog-matches | 7 |

Current APK semantic slots with no accepted Catalog match: acidgod[idx 543], aishite[idx 541], altersist[idx 534], chronologia[idx 545], cosmogyral[idx 532], csqn[idx 535], flexidefine[idx 533], kamippoi[idx 538], lavie[idx 537], override[idx 539], sucromania[idx 536], synthesis[idx 542], telepathy[idx 540], undyingmacula[idx 491].

All APK semantic slots, including non-song/unresolved directories: 604. Current song-linked slots: 602. Each slot occurs exactly once in `arcaea-apk-to-catalog-coverage.csv`.

## 6. Default, difficulty-specific and special artwork

- Default: `base.jpg`/`1080_base.jpg` and their `_256` forms are one default semantic slot per song. Resolution changes are retained as physical evidence, not split into Resources.
- Difficulty-specific: numeric jacket files are reported as candidates and are high confidence only where the same song has a corresponding `jacketOverride=true` record. The numeric-to-class mapping remains an evidence-backed candidate, not an unconditional filename law.
- Special: `base_night` is linked by the APK `jacketNight=base_night` fields for Melody of Love; `base_ja` is retained as a locale/special candidate supported by `jacket_localized` and the path, not silently converted into a difficulty artwork.

## 7. Last family case study

The APK has separate `songlist.id` records `last` (idx 282) and `lasteternity` (idx 283). `last` contains PST/PRS/FTR and a BYD difficulty-level title/audio/jacket override for `Last | Moment`; `lasteternity` contains inactive rating=0 PST/PRS/FTR slots and a BYD `rating=9`, `ratingPlus=true` record for `Last | Eternity` (Display Level 9+). The audit keeps these as separate song records and reports their conditional family relation; it does not merge their artwork or call the three zero records playable charts.

The reconciliation rows show the actual Catalog Resource IDs and matched APK paths for `last`/`lasteternity`. Any unlinked or duplicate row remains visible in the CSV rather than being title-merged.

| resourceId | songId | artworkRole | difficulty | matchStatus | semanticStatus | sourceFilenames |
| --- | --- | --- | --- | --- | --- | --- |
| 01a00091-6756-77ef-9575-a77bc7178f61 | lasteternity | default |  | confirmed | current-default-artwork | Last Eternity_onoken_4.0_epilogue_IDX 283_BPM 175_SIDE 2_epilogue_lasteternity.jpg;Last Eternity_onoken_4.0_epilogue_IDX 283_BPM 175_SIDE 2_epilogue_lasteternity.jpg_opt.jpg |
| 01a00091-6860-7a73-948a-da6197bfa2ea | last | difficulty-specific | BYD | confirmed | current-difficulty-artwork | Last_onoken_4.0_epilogue_IDX 282_BPM 175_SIDE 2_epilogue_last_3.jpg;Last_onoken_4.0_epilogue_IDX 282_BPM 175_SIDE 2_epilogue_last_3.jpg_opt.jpg |
| 01a00091-6963-7ca0-bdf0-45365376f41d | last | default |  | confirmed | current-default-artwork | Last_onoken_4.0_epilogue_IDX 282_BPM 175_SIDE 2_epilogue_last_base.jpg;Last_onoken_4.0_epilogue_IDX 282_BPM 175_SIDE 2_epilogue_last_base.jpg_opt.jpg |

The table is generated from the reconciliation rows; `last` BYD is a difficulty-specific `Last | Moment` candidate and `lasteternity` is a separate song record, not a title-only merge.

## 8. Other special song cases

The existing APK-derived special-case inventory contains 99 rows. It is not used as a replacement for the Catalog match; it explains why song-level title/audio/artist/BPM may not describe every artwork/chart record.

| caseType | count |
| --- | --- |
| difficulty-specific-artist | 6 |
| difficulty-specific-audio | 8 |
| difficulty-specific-bpm | 4 |
| difficulty-specific-jacket | 57 |
| difficulty-specific-jacket-night | 3 |
| difficulty-specific-title | 8 |
| difficulty-title-family | 1 |
| last-family | 8 |
| rating-zero-slot | 3 |
| unusual-difficulty-composition | 1 |

Representative APK evidence: `pragmatism` BYD has a title override (`PRAGMATISM -RESURRECTION-`), audio override and jacket override; `dropdead` BYD has title/artist/BPM/audio/jacket overrides; `melodyoflove` PST/PRS/FTR carry `jacket_night=base_night`; and `last`/`lasteternity` are covered by the separate Last-family records. These fields come from `assets/songs/songlist`, not from Catalog filenames.

## 9. Historical, April Fools, duplicate and unresolved results

`historical-artwork` rows after the April Fools correction: 0. `april-fools-special-song-artwork` rows: 5; unresolved rows: 3; legacy-duplicate candidates: 7. The corrected Catalog match status is `confirmed=596`, `high=1`, `medium=1`, `unmatched=5`. Exact duplicate candidate groups: 5; pixel-equivalent candidate groups: 0; visual-duplicate candidates using a perceptual threshold: 0 (not run as a sole identity rule).

A current APK absence is not by itself proof that a Catalog Resource is wrong. In particular, a seasonal April Fools Error Track can be absent from the current `songlist` while its curated Catalog artwork remains valid historical/special content. Legacy source paths and hashes are retained in the flattened Catalog snapshot and reconciliation rows. No automatic migration or merge is recommended from this report.

## 10. Upscaled rendition check

Checked 603 Resource rendition relationships: 603 upscaled renditions point to their own Resource's original rendition; anomalies: 0. An upscaled object is therefore treated as a rendition of the matched artwork, never as a separate APK match.

## 11. Identity and production strategy recommendation

Recommended strategy: retain current Catalog Resource/Variant/Rendition identities and add a separate song-centric metadata/browse projection in a future, explicitly approved change. The audit preview uses `songlist.id` as grouping identity and only references existing Resource/Variant IDs.

This is safer than restructuring the current Catalog because it preserves existing URLs, Resource IDs, downloads, original/upscaled relationships and Phase 6 compatibility. A direct Catalog regrouping would have higher migration risk and could mis-handle historical art, numeric jacket semantics and Last conditional records. `arcaea:songId=<songlist.id>` is a strong song identity candidate; artwork identity remains separate and may require difficulty/role qualifiers for current difficulty-specific or special art.

## 12. What must not be automated from this audit

- Do not merge Resources solely because title, artist, binary hash or visual pixels match.
- Do not make `_256` a new Resource or infer Chart Constant from `rating`/`ratingPlus`.
- Do not use title equality to merge Last, difficulty title overrides or localized titles.
- Do not delete historical/removed artwork because it is absent from the current APK.
- Do not write any reconciliation result back into Catalog, extractor or public site without a separate migration decision.

## 13. Remaining unresolved

See `arcaea-unmatched-jackets.csv`, `arcaea-ambiguous-jackets.csv`, `arcaea-medium-candidates.csv`, `arcaea-reconciliation-anomalies.csv` and the `unresolved`/`legacy-duplicate-candidate` rows in the main reconciliation. The main unresolved boundaries are historical source provenance, exact runtime meaning of every numeric jacket suffix, `base_ja` special handling, and whether visually/binarily duplicated legacy rows were intentionally preserved.

## 14. Evidence files

- `data/arcaea-catalog-jackets.csv` — flattened current Catalog snapshot.
- `data/arcaea-apk-current-artworks.csv` — every physical APK song-image inventory row.
- `data/arcaea-jacket-reconciliation.csv` — one row per Catalog jacket Resource.
- `data/arcaea-apk-to-catalog-coverage.csv` — one row per APK semantic slot.
- `data/arcaea-song-browse-projection.preview.json` — audit-only preview using existing IDs.
- `data/arcaea-april-fools-registry.csv` — the nine-entry 2018–2026 external-semantic baseline joined to current APK evidence.
- `data/arcaea-april-fools-artworks.csv` — all 13 related Catalog rows, including legacy duplicate candidates.
- `data/arcaea-reconciliation-summary.json`, duplicate/unmatched/ambiguous/medium-candidate/anomaly CSVs — machine-readable counts and review queues.

No production Catalog, extractor, Gallery, Public Site, Phigros data or Git history was modified.

## 15. April Fools / Error Track semantic correction

The external semantic baseline used for this small correction is the Arcaea Wiki April Fools category, accessed 2026-08-19. It is a player-facing semantic cross-check only; the APK remains the source for `songlist.id`, difficulty overrides, paths and local files. `Ignotus Afterburn 2` is explicitly excluded as a teased/fake/cancelled joke entry.

| year | Error Track | APK base record | current APK expression | permanent BYD | Catalog / audit result |
| ---: | --- | --- | --- | --- | --- |
| 2018 | Ignotus Afterburn | `ignotus` idx41 | BYD title/audio/jacket override; `assets/songs/dl_ignotus/1080_3.jpg`, `3.aff` reference | Yes | confirmed current difficulty artwork; two related Catalog Resources including one legacy duplicate |
| 2019 | Red and Blue and Green | `redandblue` idx58 | BYD title/audio/jacket override; `assets/songs/dl_redandblue/1080_3.jpg`, `3.aff` reference | Yes | confirmed current difficulty artwork; two related Catalog Resources including one legacy duplicate |
| 2020 | Singularity VVVIP | `singularity` idx70 | BYD title/audio/jacket override; `assets/songs/dl_singularity/1080_3.jpg`, `3.aff` reference | Yes | confirmed current difficulty artwork; two related Catalog Resources including one legacy duplicate |
| 2021 | overdead. | `dropdead` idx91 | BYD title/audio/artist/BPM/jacket override; `bpm=500`; `assets/songs/dl_dropdead/1080_3.jpg` | Yes | confirmed current difficulty artwork; two related Catalog Resources including one legacy duplicate |
| 2022 | Mistempered Malignance | `maliciousmischance` idx174 | base song only; no separate Error Track record/override in audited APK | No | Catalog-only seasonal special; reclassified from `historical-artwork` |
| 2023 | 0xe0e1ccull | `ifi` idx159 | base song only; no separate Error Track record/override in audited APK | No | Catalog-only seasonal special; reclassified from `historical-artwork` |
| 2024 | HIVEMIND INTERLINKED | `hivemind` idx222 | base song only; no separate special record/override; external relation is mashup | No | Catalog special, **unmatched current APK artwork**; base relation high; prior base-image candidate MAE≈35.249 (>2.0) retained only as evidence |
| 2025 | Live Faster Die Younger | `livefastdieyoung` idx242 | base song only; no separate special record/override in audited APK | No | Catalog special, **unmatched current APK artwork**; base relation high; prior base-image candidate MAE≈126.590 (>2.0) retained only as evidence |
| 2026 | UNUSED LEVELS | `unknownlevels` idx340 | base song only; no separate Error Track record/override in audited APK | No | Catalog-only seasonal special; reclassified from `historical-artwork` |

The first four are why their current Catalog images do not become unmatched: the APK has a direct permanent BYD relation, a local numeric jacket, and an exact original-object SHA-256 match. The latter five are not invalid/removed regular songs; in this audited APK their special records are seasonal-only or historical-only, while their base songs are separate ordinary `songlist` records. For all five, `currentArtworkMatchStatus=unmatched` is deliberately separate from `baseSongRelationStatus=high`; a title/relation or base-image candidate cannot become a current special-artwork match. `not in current songlist` must therefore not be used as a sole “removed song” rule.

The machine-readable relation fields are `baseSongId`, `relationType`, `permanentDifficultyClass`, `hasPermanentBYDRepresentation`, `semanticStatus` and `apkEvidence` in `data/arcaea-april-fools-registry.csv`. The audit-only preview keeps current regular `songs` separate and exposes `aprilFoolsSpecialArtworks` separately; no UUID or Catalog identity was created.

External references:

- Arcaea Wiki, [April Fools category](https://arcaea.fandom.com/wiki/Category:April_Fools), accessed 2026-08-19 — baseline list, seasonal Error Track semantics and exclusion of the fake Ignotus Afterburn 2 entry.
- Arcaea Wiki, [Ignotus Afterburn](https://arcaea.fandom.com/wiki/Ignotus_Afterburn_%28April_Fools%29), accessed 2026-08-19 — specific 2018 special/base relation and teased sequel context.
- Arcaea Wiki, [HIVEMIND INTERLINKED](https://arcaea.fandom.com/wiki/HIVEMIND_INTERLINKED), accessed 2026-08-19 — mashup relation; not collapsed to a single-source remix in the registry.
