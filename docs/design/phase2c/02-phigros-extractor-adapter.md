# Phigros extractor adapter

Phase 2C preserves the useful parts of `E:\rhythm-assets-gallery\scripts\extract-phigros-update.py` while making its limitations explicit.

## Reused extraction logic

- `assets/aa/catalog.json` decoding and Addressables key parsing;
- discovery of Unity bundle entries;
- selective extraction of new bundles;
- UnityPy `Texture2D` scanning;
- Illustration versus avatar classification by object name and dimensions;
- filename suggestions from track/avatar keys;
- bundle, key, object name and dimensions as source evidence.

`adaptPhigrosLegacyReport()` reads `phigros-update-report.json`, hashes each exported file, parses a complete `Assets/Tracks/<title>.<artist>.<difficulty>/Illustration.jpg` key when available, and emits `ExtractorResult` candidates.

## Explicit policy

The adapter never fabricates a formal title or artist from a bundle hash/object name. A partial title, missing artist, missing Addressables key, or uncertain resource-to-track mapping stays visible as evidence. Missing artist/title produces `metadataReviewRequired=true`; a jacket with no reliable key is blocked for identity resolution.

The known limitation remains: the legacy script compares only newly appearing catalog keys and bundle files. Content changes inside an existing bundle are not reliably detected. The adapter records this as a limitation and never converts “not detected” into “no update”.

Manual title, artist, category, resource relation and filename changes are optional overrides. Candidate ID, source hash, bundle/key/object evidence and dimensions remain unchanged.

The adapter cannot publish a Catalog Resource. It only supplies Candidates to the V2 Version Workspace.
