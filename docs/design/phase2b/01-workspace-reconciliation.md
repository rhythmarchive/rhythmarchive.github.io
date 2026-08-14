# Phase 2B Workspace Reconciliation

## Scope

`packages/domain/src/workspace.ts` implements a local filesystem workflow engine. It creates and reopens:

```text
.runtime/updates/<game>/<targetVersion>/
├─ raw/                 # copied source bytes; immutable-by-contract
├─ work/                # files the user may rename, move, replace, delete, or add
├─ upscale-input/       # ordinary regular-file copies for external tools
├─ upscale-output/      # external *_optimization.png attempts
├─ processed/           # verified staging JPEGs
└─ metadata/
   ├─ batch.json
   ├─ candidate-manifest.json
   ├─ candidates.json
   ├─ raw-manifest.json
   ├─ review-log.json
   ├─ workspace-scan.json
   ├─ upscale-map.json
   └─ upscale-reconciliation.json
```

`raw/` is copied from the adapter input and is never repaired automatically. `work/` is intentionally a real, browsable directory. The extra `candidates.json` is the persistent local state that keeps the Candidate object separate from the small CandidateManifest envelope.

## Reconciliation rule

`scanWorkspace()` is read-only. `reconcileWorkspace()` applies the same scan to Candidate state, ReviewLog, progress and the scan snapshot.

1. If the previous `work-original.relativePath` exists and its SHA-256 is unchanged, emit `UNCHANGED`.
2. If the previous path exists but the SHA-256 changes, emit `MODIFIED_CONTENT`, retain Candidate/CandidateFile IDs, and append a `CandidateFileRevision`.
3. If the previous path is missing, group missing Candidates and discovered files by the previous SHA-256. Only a one-Candidate/one-file group may be rebound automatically. Same directory plus a new basename is `RENAMED`; a directory change is `MOVED`.
4. A non-unique same-hash group emits `AMBIGUOUS` with `BLOCKED_AMBIGUOUS_RENAME`; it never guesses.
5. No same-hash file emits `MISSING` with `MISSING_FROM_WORKSPACE`. The Candidate becomes `BLOCKED`, never silently `REJECTED`.
6. An unassigned `work/` file becomes a new `MANUAL_ADDITION` Candidate during reconciliation. A content duplicate is reported as `DUPLICATED` and still gets its own manual Candidate; the hash is not used for semantic merge.

mtime is stored as supporting evidence only. Filename, basename and relative path are not permanent identity.

## Raw integrity

`raw-manifest.json` records `relativePath`, `sizeBytes` and SHA-256 for every initial raw copy. `checkWorkspaceRawIntegrity()` and every scan detect:

- `RAW_SOURCE_MODIFIED`
- `RAW_SOURCE_MISSING`
- `RAW_SOURCE_UNEXPECTED`

Any issue blocks finalization and batch publication readiness. The engine does not copy over, delete, or otherwise repair `raw/`.
