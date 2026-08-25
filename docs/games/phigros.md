# Phigros

- Lifecycle: published; existing Catalog and shared site route.
- Source and engine: APK/manifest inputs; repository audits identify Unity 2022.3.62f2 and Addressables catalog/key evidence.
- Adapter/extractor: adapterId phigros-apk; packages/domain/src/extractors.ts and tools/phase6-phigros-diff.py remain the current entrypoints.
- Identity and scope: current track artwork, selected pack/special/avatar resources, and reviewed Phigros special categories. Prefer full logical Track/Addressables key plus provenance; bundle filename alone is not domain identity.
- Traps: same bundle/path may contain changed bytes; compare actual image content where needed. Chapter/level metadata and cross-version identity are not assumed from a single APK or an old report.
- Update strategy: use previous Manifest and a real old/new APK pair when claiming NEW/CHANGED/REMOVED stability; missing pair or ambiguous metadata blocks promotion.
- Last validated assumptions: one local APK is not cross-version proof; historical reports remain evidence, not a replacement APK.
