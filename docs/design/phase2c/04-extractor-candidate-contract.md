# ExtractorResult and Candidate contract

`packages/domain/src/extractors.ts` defines the shared adapter contract.

## ExtractorResult

An `ExtractorResult` contains:

- `game`, `sourceType`, `baseVersion`, `targetVersion`;
- base and target APK provenance (`filename`, absolute local path, optional SHA-256/size);
- `sourceSnapshot` and extractor version;
- zero or more `ExtractorCandidate` records;
- explicit diagnostics and limitations;
- `status = ok | blocked | failed`.

`failed` results throw `ExtractorAdapterError`. A blocked result may be carried into a workspace when it has concrete source files; a missing or unreadable source file is never turned into a normal Candidate.

## Candidate fields

Each extracted candidate keeps:

- a stable Candidate ID;
- source type and source APK version;
- APK-relative path or Addressables/bundle evidence;
- original filename and SHA-256;
- suggested title, artist, filename, category, Variant and external identity;
- confidence and explainable evidence;
- review requirements;
- `CandidateProvenance` with base/target versions, metadata source, bundle/key/object name, dimensions and mapping evidence.

The V2 workspace stores automatic values in `suggestedMapping` and human changes in `review.overrides`. Provenance is not overwritten by metadata or filename overrides.

## Workspace boundary

`createWorkspaceFromExtractorResult()` calls the existing `createVersionWorkspace()` flow. It copies source bytes into `raw/` and `work/`, creates `metadata/candidate-manifest.json`, and retains raw integrity checks. No adapter function creates a Catalog Resource or a published rendition. `createReleaseManifestDraft()` remains reachable only from READY Candidates, and `PublishPlan` remains dry-run only.
