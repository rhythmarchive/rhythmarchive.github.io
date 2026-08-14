# Phase 2A Contract Revisions

Phase 2B makes these changes while retaining compatibility reads for the Phase 2A fixtures:

1. **External rename reconciliation**: persisted work paths, hashes and aliases are compared on every scan. Unique same-hash rename/move keeps Candidate identity; ambiguous and missing states block.
2. **Rendition replacement identity**: Object bytes may change, but `Rendition.id` remains the semantic slot ID. `replaceRenditionObject()` formalizes this.
3. **downloadFilename**: Rendition and published rendition entries use `downloadFilename`. `displayFilename` is read as a compatibility alias only and is not used as Object identity.
4. **raw integrity**: `raw-manifest.json` records initial path, size and SHA-256 and detects modified, missing and unexpected raw files without repair.
5. **ReleaseManifest/ReviewLog**: rejected, ignored, review history and upscale failures are local ReviewLog events. Newly generated ReleaseManifest data describes only public Catalog changes.
6. **independent versions**: Catalog, Workspace, Release and PublishPlan documents have independent `catalogSchemaVersion`, `workspaceSchemaVersion`, `releaseSchemaVersion` and `publishPlanSchemaVersion` fields. They currently all equal `"1.0"`; that equality is not a future synchronization contract. Legacy `schemaVersion` is accepted only for Phase 2A compatibility.

No migration framework was added. New schema changes must be explicit and revalidated.
