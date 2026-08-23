# Rizline Phase 3 extractor

This package is a local-only extractor for the Rizline APK catalog and the
already-created Unity RuntimeCache payloads.

```powershell
python -m tools.rizline inspect `
  --apk apk/律动轨迹_2.7.0.apk `
  --cache-root temp/com.leiting.ldgj/files/UnityCache/Shared

python -m tools.rizline extract `
  --apk apk/律动轨迹_2.7.0.apk `
  --cache-root temp/com.leiting.ldgj/files/UnityCache/Shared `
  --output temp/rizline_extract_output `
  --key illustration.419kB.ariiol.0 `
  --prefer-hires
```

The APK's own `assets/aa/catalog.json` is the only version source.  A runtime
catalog can be passed to `inspect` for diagnostic display, but it never
replaces the APK catalog.  `RuntimeCacheResolver` only constructs the exact
`Shared/<bundle-name>/<bundle-hash>/__data` path; it does not scan or guess
unrelated cache files.

Current semantic status:

- `illustration`, `seriesPoster`, `seriesBanner`, `avatar.npc`: supported.
- `rizcard`: static Sprite supported; complete GameObject semantics remain partial.
- `layout`, `altIllustration`: catalog discovery and missing-payload reporting.
- `banner.EventPosterBanner`: catalog/cache/object inventory only; no forced PNG.

The package does not perform CDN requests, access game servers, modify game
data, or write to website/public resource directories.  JSON is the formal
manifest interface; CSV is an audit view.  Runtime output must be placed in an
ignored directory such as `temp/rizline_extract_output/`.
