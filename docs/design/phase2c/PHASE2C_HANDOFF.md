# Phase 2C Handoff

## Result

**PHASE 2C COMPLETE — STOPPED BEFORE ADMIN / ROS / PUBLIC SITE IMPLEMENTATION**

Phase 2C adds V2 adapters for the legacy Arcaea and Phigros extraction reports, a shared ExtractorResult/Candidate provenance contract, game-specific ReviewPolicy, explicit confirm/override APIs, progress separation, tests and an isolated rehearsal runner.

## Required answers

1. **Completion:** complete for the adapter, policy and fixture-to-workspace scope.
2. **Arcaea reused logic:** selective APK/path diff, SHA-1 changed detection, songlist/packlist/character/story metadata, category mapping, filename construction and difficulty marker parsing.
3. **Arcaea coupling removed:** legacy publish, SSH/VPS overlay, remote build, old archive writes and direct Catalog publication are not called by the adapter.
4. **Phigros reused logic:** Addressables catalog/key decoding, bundle discovery, UnityPy Texture2D extraction, illustration/avatar classification, filename inference and bundle/key/object evidence.
5. **Contract:** `ExtractorResult` contains game/source type, base/target versions and APK provenance, candidates, diagnostics and limitations. Each Candidate keeps source path/hash, automatic suggestions, confidence/evidence, review requirements and `CandidateProvenance`.
6. **Arcaea normal Candidate:** yes. Exact, complete candidates require human confirmation, not a filename edit. Confirmation without modifications leaves `review.overrides` empty and creates no rename event.
7. **Arcaea real/fixture naming and review:** fixture tests prove the normal high-confidence path has `manualNamingRequired=false`; the current real run has no pair and therefore no real percentage. The machine-readable report records this instead of inventing a denominator.
8. **Phigros metadata corrections:** Addressables keys/object names can be partial or internal, so title/artist completeness and resource mapping are not always reliable. Missing fields are explicit metadata review requirements.
9. **Phigros completeness:** fixture tests cover missing artist and incomplete metadata; a real percentage is not claimed because only one local Phigros APK exists.
10. **ReviewPolicy:** `applyReviewPolicy()` branches by game and resource type and independently returns review, naming, metadata, identity and upscale requirements.
11. **Confirm vs override:** `confirmCandidateInWorkspace()` records human confirmation only. `overrideCandidateMetadataInWorkspace()` and `overrideCandidateFilenameInWorkspace()` record actual changes under `review.overrides` and in ReviewLog.
12. **AI upscale:** unchanged from Phase 2B; it remains after confirmation/review and is not coupled to filename review.
13. **Real APK rehearsal:** not completed because both user-provided directories currently have one APK. Reports use `REAL_APK_REHEARSAL_BLOCKED_MISSING_LOCAL_INPUT`; Phigros is explicitly marked as the stated one-APK special case.
14. **Missing input:** at least two distinct local APKs per game, one old/base and one new/target. No download was attempted.
15. **Validation:** `npm run typecheck` passes; `npm test` passes **31/31** tests after Phase 2C tests are included.
16. **Public Arcaea APK Distribution:** remains completely independent and untouched.
17. **Next Admin WebUI APIs:** consume `CandidateManifest`, `loadWorkspaceState`, `computeUpdateBatchProgress`, `confirmCandidateInWorkspace`, metadata/filename override APIs, identity resolution, workspace scan/reconciliation and dry-run ReleaseManifest/PublishPlan APIs. No UI was implemented in this phase.
18. **Unresolved:** real APK pair, Phigros changed-bundle diff, `_256` semantics, historical source-version certainty, complete Phigros display metadata and production ROS/Catalog policies.

## Verification and reports

- Adapter and review tests: `packages/domain/tests/phase2c.test.ts`.
- Real-input reports: `docs/design/phase2c/data/arcaea-rehearsal.json` and `docs/design/phase2c/data/phigros-rehearsal.json`.
- The rehearsal writes only to V2 `.runtime/rehearsal/` and does not modify the configured legacy project or Legacy Asset Root.
