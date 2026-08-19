# Production Browse Projection

Browse Projection is a domain browse index. It does not replace or rewrite
`Resource`, `Variant`, `Rendition`, or `Object`, and it never owns image URLs or
binary metadata. Artwork entries resolve through existing Catalog Resource IDs.

## Files

Generated baseline/output files live in `catalog/browse/`:

- `arcaea.json`: Song-centric regular songs, April Fools specials, archive and unresolved extras.
- `phigros.json`: Track-centric current artwork entries, independent specials, archive extras, and source-only Tracks.
- `manifest.json`: schema/source/Catalog hashes, generated timestamp, and record counts.
- `diagnostics.json`: internal coverage diagnostics; it is not a replacement for Catalog data.

Human-maintained Arcaea seasonal semantics live separately in
`catalog/curation/arcaea-april-fools.json`. Generated files and curation are
different inputs and must not be merged into an audit CSV database.

The current schema version is `1`. Arcaea and Phigros have separate concrete
record types. The only shared contract is the small manifest/diagnostics and
Resource-reference validation layer.

## Generation

The production CLI receives an existing Catalog and extractor/reviewer source
metadata explicitly:

```text
npx tsx tools/browse-projection.ts \
  --catalog <candidate-catalog.json> \
  --arcaea-source <arcaea-source-metadata.json> \
  --phigros-source <phigros-source-metadata.json> \
  --curation catalog/curation/arcaea-april-fools.json \
  --output <candidate-browse-directory>
```

`--bootstrap-audit docs/apk-audit/data` is an explicit one-time migration path
for the audited baseline only. Routine validation is `npm run browse:check` and
does not read `docs/apk-audit/`. Future APK updates must provide source
metadata plus Resource relations from the extractor/reviewer; they do not
rerun pHash reconciliation as a runtime dependency.

The generator preserves a previous projection when a new source omits an old
Song/Track, subject to current Catalog coverage. Such records become archive
or unresolved entries rather than disappearing. An explicitly missing current
Arcaea artwork is represented by `resourceId: null` and a diagnostic; it is not
replaced with a fabricated UUID.

## Phase 6 boundary

Phase 6 can pass a candidate Browse Projection to
`writeCatalogAndReleaseAndBrowseAtomic`. The writer validates the candidate
Catalog, ReleaseManifest, all Browse schemas, Catalog SHA, and every Resource
reference before staging. Catalog, ReleaseManifest, and four Browse files are
then committed with backup/rollback handling. Object upload or Catalog/Browse
commit failure therefore leaves both formal Catalog and formal Browse data at
their previous versions.

No ROS publish is performed by the baseline command, and Gallery pages are not
changed by this foundation.
