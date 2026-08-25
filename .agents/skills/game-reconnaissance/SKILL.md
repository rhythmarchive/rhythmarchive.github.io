---
name: game-reconnaissance
description: Use when an APK, AAB, installation directory, AssetBundle, Addressables set, or other game package has never been registered and must be inspected before onboarding.
---

# Game reconnaissance

## Trigger and boundary

Use this for an unknown package or an unregistered game slug. Do not use it for a published game version update when the existing adapter and profile still work; route those requests to game-update.

Reconnaissance answers what the source contains. It does not publish assets, mutate a source directory, or require the candidate to be in the formal Game registry.

## Inputs and preflight

- Require a candidate slug and a source path or URL.
- Confirm the source is readable and treat it as permanently read-only.
- Check git status, the current profile registry, and the existing temp workspace.
- Never put reports, caches, converted images, or workflow state beside the source.

## Ordered workflow

1. Run npm run rhythmctl -- onboard probe --slug <candidate> --source <path> --version <snapshot>.
2. Let the probe classify source kind, engine, runtime, markers, inventory, possible asset types, and extractor feasibility without parsing the formal Game enum.
3. Inspect the generated probe, draft profile, and analysis report under temp/rhythmctl/onboarding.
4. If the candidate is viable, run npm run rhythmctl -- onboard plan --probe <probe.json> and record selected and excluded asset types plus rationale.
5. Hand the plan to game-onboarding. Keep unsupported or ambiguous findings in diagnostics and blockers.

## Formal tools and artifacts

The formal boundary is probeOnboardingSource, createOnboardingPlan, and writeOnboardingArtifacts in packages/domain/src/onboarding.ts, orchestrated by tools/rhythmctl.ts.

The durable local artifacts are probe.json, draft-profile.json, analysis-report.json, onboarding-plan.json when selected, and state.json. All paths must be under repository temp.

## Gates and recovery

The source must remain read-only and the candidate must not be added to the published Game registry as a side effect. A missing source, unreadable directory, or insufficient evidence is BLOCKED and is recorded in state; do not guess engine, identity, or asset type.

A completed reconnaissance state is resumable at phase reconnaissance-complete. Resolve the onboarding decision or blocker, then continue with game-onboarding; do not repeat reconnaissance merely because a Codex session was reopened.

## Validation and completion

Validate the candidate schema, state phase, source snapshot, readOnly=true, and artifact paths. Completion means the package structure and a bounded onboarding decision are documented; it does not mean a Catalog entry or release exists.
