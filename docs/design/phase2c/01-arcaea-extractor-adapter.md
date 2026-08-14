# Arcaea extractor adapter

Phase 2C keeps the verified extraction core from the legacy project in `E:\rhythm-assets-gallery\scripts\extract-arcaea-update.ts` and adapts its report into V2 Candidates. The legacy project remains read-only.

## Reused extraction logic

- `--new` / `--old` APK or extracted-directory inputs;
- selective extraction of supported image paths rather than a full APK unpack;
- APK-internal relative-path comparison and SHA-1 change detection;
- songlist, packlist, character and story metadata copies;
- song/difficulty marker parsing (`1080_base_0..4` → PST/PRS/FTR/BYD/ETR);
- readable filename construction and category mapping;
- `_256` exclusion in the legacy target selector.

The V2 adapter is implemented in `packages/domain/src/extractors.ts` as `adaptArcaeaLegacyReport()`. It reads the legacy `arcaea-update-report.json` and its `_metadata` files, hashes the extracted output file, and emits an `ExtractorResult`. `extractorResultToAdapterInput()` then maps that result to the existing V2 workspace adapter.

## V2 behavior

Each Candidate preserves the APK-relative path, output/original filename, source hash, source APK version, songId/packId/characterId evidence, difficulty marker, metadata source, and unresolved markers. Automatic title and artist proposals remain under `suggestedMapping`; human corrections are stored under `review.overrides`.

Normal song-jacket candidates with an exact songId and complete metadata are `reviewRequired=true`, `manualNamingRequired=false`. A human can confirm the automatic proposal without creating a rename event. Identity ambiguity creates a `BLOCKED` Candidate until `resolveCandidateIdentity()` is called.

`_256` remains unresolved. The adapter does not reinterpret it as a normal rendition or merge it into another difficulty Variant.

The adapter only emits Candidates and a CandidateManifest envelope. It does not create Catalog Resources, upload files, modify the legacy archive, or publish anything.
