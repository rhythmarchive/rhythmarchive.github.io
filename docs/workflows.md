# Workflows

## Unknown package

1. Read-only probe: npm run rhythmctl -- onboard probe --slug candidate --source path --version snapshot.
2. Inspect probe.json, draft-profile.json, analysis-report.json, and state.json under temp/rhythmctl/onboarding.
3. Record a bounded onboarding plan with selected and excluded asset types.
4. Continue to game-onboarding only after the scope decision is explicit.

The probe does not require a formal Game enum entry and never writes beside the source.

## New game onboarding

Reconnaissance result -> lifecycle and selection decision -> formal GameProfile -> Adapter Registry -> extract -> normalize -> validate -> candidate manifest -> delta -> review -> approval -> local release prepare -> Catalog/PublicSiteData -> shared route/search validation.

Discovery is not publication. A game may publish only jacket, jacket plus character, or another persisted subset. Unselected resources remain diagnostics or review material.

## Existing game update

New source -> existing profile and adapter -> source probe -> candidate manifest -> previous published manifest -> NEW/CHANGED/REMOVED/UNCHANGED delta -> human review -> approval -> local release prepare.

Full reconnaissance is a fallback only when markers disappear, extraction fails, mappings break, counts become implausible, or stable identity collapses. REMOVED never deletes Catalog or remote objects.

`extract` and `diff` require `--previous` for an existing-game update. Use `--initial` or `--onboarding` only for a first release. Existing-game `release prepare` also requires `--published`; its local preflight runs `npm run ci:check` and `git diff --check` before producing a dry-run plan.

## Content addition

Manual file, official resource, metadata correction, new category, new variant, or new rendition -> ContentAdditionInput with origin -> content add -> candidate manifest -> delta -> review -> approval -> release prepare. Origins are source-derived, manual, metadata-only, new-category, new-variant, and new-rendition.

## State and resume

Each run stores state at temp/rhythmctl/<game-or-candidate>/<version>/state.json. It records candidate/game, version, source path and snapshot, phase, completed steps, artifact paths, manifest/delta/review/release paths, statuses, blockers, errors, and timestamps.

Use status with an explicit state path:

    npm run rhythmctl -- status --state temp/rhythmctl/<game>/<version>/state.json

Use resume to print the next owning command and blockers:

    npm run rhythmctl -- resume --state temp/rhythmctl/<game>/<version>/state.json

Resume is deliberately non-destructive: rerun the owning step after resolving the blocker; existing artifacts and state are preserved.
For a blocked state, use `resume --state <state.json> --resolve` after the blocker is resolved; this resumes only the saved phase.

## Review and release

Delta -> review package -> check-approval/approve -> storage diff -> release prepare -> verify. A pending or mismatched review cannot become READY_LOCAL_ONLY. Local READY_LOCAL_ONLY explicitly has remoteWrite=DISABLED.

`release prepare` is local-only. It requires an approved or not-required Review, a manifest-based storage diff, passing tests/site/build/smoke/browse gates, and a clean `git diff --check`; no ROS or production write is part of this workflow.
