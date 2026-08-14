# Phase 2B Handoff

## Result

Phase 2B implements a testable, pure-local workflow engine in:

- `packages/domain/src/workspace.ts`
- `packages/domain/src/publish.ts`
- revised `packages/domain/src/schema.ts`
- revised `packages/domain/src/validation.ts`
- revised `packages/domain/src/identity.ts`

The exported entry points include `createVersionWorkspace`/`createWorkspace`, `scanWorkspace`, `reconcileWorkspace`, `prepareUpscaleInputs`, `reconcileUpscaleOutputs`, `selectUpscaleAttempt`, `convertSelectedUpscale`, `finalizeWorkspaceCandidate`, `computeUpdateBatchProgress`, `createReleaseManifestDraft` and `createPublishPlanDryRun`. `tools/phase2b-workspace.ts` provides a JSON-manifest CLI wrapper for create/scan/reconcile/upscale/progress.

## Required handoff points

1. **Phase 2A contracts modified**: external reconciliation, stable Rendition/Object replacement, `downloadFilename`, raw manifest, ReviewLog boundary and independent schema version fields. Details: `07-phase2a-contract-revisions.md`.
2. **Workspace implementation**: creates `.runtime/updates/<game>/<targetVersion>/raw`, `work`, `upscale-input`, `upscale-output`, `processed` and `metadata`; copies source bytes and writes atomic JSON manifests. It does not modify source input and reopening an existing workspace does not overwrite it.
3. **Reconciliation algorithm**: path lookup first, then a one-to-one same-SHA-256 match. Filename and mtime are supporting evidence only. Non-unique matches block; no match is missing; unassigned files become manual Candidates.
4. **Windows Explorer rename/move**: old `work-original` path disappears, one unique same-hash file is found, Candidate/CandidateFile IDs remain unchanged, current path and alias are recorded, and `RENAMED`/`MOVED` is emitted.
5. **Content replacement**: same path plus a new hash emits `MODIFIED_CONTENT`, retains Candidate identity and appends `CandidateFile.revisions[]`; ready/review state is invalidated for a fresh review.
6. **Manual addition**: unassigned `work/` files become `sourceType = manual`, `detection = manual`, `NAMING_REVIEW` Candidates with a metadata-required note. Duplicate bytes do not cause semantic merge.
7. **Raw integrity**: `raw-manifest.json` is checked for `RAW_SOURCE_MODIFIED`, `RAW_SOURCE_MISSING` and `RAW_SOURCE_UNEXPECTED`; no auto repair is attempted.
8. **AI input/output pairing**: regular-file input copies and `upscale-map.json` preserve Candidate mapping, including historical inactive map entries after a work rename. Output matching checks sidecar, current/final names, aliases and source basename; ambiguity is blocked, and a disappeared selected/only output blocks the Candidate until manual resolution.
9. **PNG → JPG**: selected `_optimization.png` is converted via Sharp into `processed/*.jpg` with partial write, format/dimension/hash verification, PNG retention and explicit `renditionRole = upscaled` in the local conversion record.
10. **q95 recommendation**: q95 remains the safe provisional default: sRGB, 4:4:4, progressive, mozjpeg=false. `docs/design/upscale-experiment-2026-08-14-phase2b.json` records q92/q95/q97 over the Phase 2A sample plus five copied representative images. q95 is not universally best: the Acid God fixture favored q95 on MAE/max error, while some gradient/detail samples favored q97. q95 is retained as a balanced default, not a quality freeze.
11. **Rendition replacement**: `replaceRenditionObject()` changes Object ID only; Rendition ID and role remain stable.
12. **downloadFilename**: stored on Rendition/release entries, separate from Object ID; same Object/different Resource remains legal.
13. **ReleaseManifest/ReviewLog**: rejected, ignored, filename history, conversion failures and local notes stay in ReviewLog. Generated ReleaseManifest contains public changes and published rendition entries only; both draft and PublishPlan generation recheck raw integrity.
14. **PublishPlan example**: the dry-run reports objects to create, Catalog mutations, manifest mutation and retention-delayed GC candidates. It validates the draft against the simulated Catalog and active READY Candidate final files, and performs no upload/delete/Git/ROS action.
15. **Schema versions**: Catalog, Workspace, Release and PublishPlan use independent `*SchemaVersion` fields, currently `"1.0"` each, with legacy compatibility reads.
16. **Automated tests**: `npm run typecheck` passes; `npm test` passes 26 tests. The Phase 2B tests use real temporary filesystem operations for rename, move, duplicate ambiguity, missing, manual addition, in-place content replacement with metadata refresh, raw modification/missing/unexpected, final-file and raw publication guards, external optimization output, inactive/ambiguous sidecar mapping, ambiguous upscale, multiple attempts including missing selected output, PNG conversion, finalization, existing-rendition replacement/retention planning and dry-run publication.
17. **Next phase suggestion**: build the Admin UI only after reviewing this local contract and choosing explicit UX for blocked/missing/ambiguous states. Do not infer a publish API from this prototype.
18. **Unresolved**: final JPEG quality policy across the full archive; semantic interpretation of historical variants; production Catalog/ROS retention policy; real extractor adapters; Legacy migration; and any server-side byte verification.

## End boundary

No Astro public site, Admin WebUI, Rainyun ROS, GitHub Pages/Actions, cloud APK checker, public release, SQLite, formal Legacy Migration or extractor rewrite was added.

`PHASE 2B COMPLETE — STOPPED BEFORE ADMIN / ROS / PUBLIC SITE IMPLEMENTATION`
