# Phigros Identity Stability Report

本报告评估的是当前 APK 内可提取的 identity candidate，不是 production schema 决策。由于本地没有第二份 Phigros APK，所有跨版本列只能写“未验证”；旧 update report 不替代 APK pair。

## 1. Inputs

- Current APK: `D:\Files\曲绘\Phigros\APK\Phigros_3.19.5.apk`
- SHA-256: `B9654316E52BF2D410FA2ECB3F0DF41246AFDC3DC8133456DEAFF07ECBCF28BF`
- Current Track folders: 319
- Current Addressables catalog: 7,936 keys / 6,425 entries / 2,514 bundle internal IDs
- Local APK pair count: 1
- Cross-version status: **unavailable-locally**

## 2. Current uniqueness

| candidate | current count | unique values | duplicate groups | current conclusion |
| --- | ---: | ---: | ---: | --- |
| title | 319 | 312 | 2 | not sufficient; duplicate/special family exists |
| title + artist | 319 | 313 | 1 | better candidate, still rename-sensitive and not version-proven |
| folder index suffix | 319 | 8 | 1 | not an identity; 312 records have index `0` |
| full `Assets/Tracks/<title>.<artist>.<index>/` folder | 319 | 319 | 0 | strongest current Track resource key candidate |
| full `Illustration.jpg` Addressables key | 313 primary-image folders | current-key unique within catalog | no duplicate key | strongest image relation when main image exists |
| dependency bundle filename | many-to-many build artifact | not domain-unique | possible reuse/change | provenance locator, not song identity |
| Unity object path ID | unique only within source/bundle context | not global | context-dependent | object identity, not domain Track ID |
| Unity GUID | not recovered from APK | — | — | unavailable; do not equate with song ID |

Source: `data/phigros-track-records.csv`, `data/phigros-addressables-keys.csv`, `data/phigros-identity-candidates.csv`.

## 3. Candidate assessment

| candidate | uniqueness | cross-version stability | rename resistance | extractor availability | Phase 6 suitability |
| --- | --- | --- | --- | --- | --- |
| display title | Partial | Unverified | Low | High from key parsing | candidate label only |
| title + artist | Partial/High within current APK | Unverified | Low/Medium | High | candidate fallback only |
| suffix index | No | Unverified | Unknown | High | unsuitable; most values are `0` |
| full Track folder | High within current APK | Unverified | Low/Medium because title/artist are embedded | High | best current candidate, pending APK pair |
| full Addressables Track key | High within current APK | Unverified | Low/Medium; key contains folder tokens | High | best source identity for current resource diff, not proven domain ID |
| bundle path + object path ID/name | High for a concrete asset in one build | Build-dependent | High for that concrete object, but not song-level | High in current Phase 6 | content/provenance fallback |
| Unity GUID | Not recovered | Unverified | Usually asset-level, not domain-level | None in this APK | do not use without a proven game-domain join |

## 4. Track folder index finding

The last token in `Assets/Tracks/<title>.<artist>.<index>/` is not a global song ID in this APK:

- 312 of 319 records end in `.0`;
- one each ends in `.1`, `.2`, `.3`, `.4`, `.5`, `.6`;
- `Random.SobremSilentroom.0..6` is a special family where the suffix visibly behaves as a family variant/index;
- the suffix therefore cannot uniquely identify ordinary songs or provide a reliable incremental key.

Confidence: **High** for “not a unique global ID”; **Unresolved** for the original authoring reason of the suffix.

## 5. Recommended audit identity

For the current APK only, retain the complete logical Track folder/key:

```text
phigros:trackpath=Assets/Tracks/<title>.<artist>.<index>/
```

For an illustration, retain the exact Addressables logical key and its evidence chain:

```text
Assets/Tracks/<track-folder>/Illustration.jpg
    → dependency bundle
    → Texture2D/Sprite object name Illustration + pathId
```

This is a **current source identity candidate**, not a confirmed cross-version domain song identity. A future Phase 6 comparison should keep a compound key of logical track path + role + bundle/object provenance and compare a second APK before promoting any field to stable `externalIdentity`.

Do not use:

- title alone;
- folder index alone;
- bundle filename alone;
- Unity object path ID alone;
- Unity GUID as a presumed song ID.

## 6. Cross-version evidence

No old/new APK pair is locally available. `D:\Files\曲绘\Phigros\3_19_2` through `3_19_5` contain prior reports/exports, but referenced old APK paths do not exist. Thus the following are all **unverified**:

- title rename resistance;
- artist rename resistance;
- folder path preservation after a rename;
- key stability after bundle rebuild;
- chapter moves;
- illustration key preservation;
- chart metadata additions/removals.

The generated `data/phigros-cross-version-track-diff.csv` records report provenance separately and does not claim unchanged/changed counts.

## 7. Identity stability conclusion

| question | answer |
| --- | --- |
| stable domain Track ID proven? | No |
| best current source key? | full `Assets/Tracks/<title>.<artist>.<index>/` logical path, usually with role suffix |
| best current image key? | full Addressables `Illustration.jpg` key plus dependency/object evidence |
| folder index a stable ID? | No; 312/319 are `0` |
| cross-version validation complete? | No; only one APK locally |
| Phase 6 recommendation | keep current logical/provenance compound identity as candidate; require an actual adjacent APK pair before identity promotion or migration |

External technical references are listed in `PHIGROS_METADATA_DEEP_AUDIT.md` and were accessed 2026-08-19.

