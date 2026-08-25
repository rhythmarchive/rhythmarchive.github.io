# rhythmctl

rhythmctl 是统一的本地编排入口。它解析命令、读取 Profile/Adapter Registry、调用标准能力、记录 WorkflowState，并把所有分析产物限制在 repository temp/。

## Unknown candidate

npm run rhythmctl -- onboard probe --slug <candidate> --source <path> --version <snapshot>
npm run rhythmctl -- onboard plan --probe <probe.json> --select jacket,character-avatar --exclude audio --rationale <text>

onboard probe 不调用正式 Game.parse，因此未知 slug 可以先完成 source inventory、engine/runtime/marker 判断、可行性诊断和 DraftGameProfile。完成 reconnaissance 后再由 game-onboarding 决定是否注册正式 Game。

## Known game and content

npm run rhythmctl -- games
npm run rhythmctl -- probe --game <game> --source <path>
npm run rhythmctl -- ingest --game <game> --source <path> --version <version>
npm run rhythmctl -- extract --game <game> --report <report.json> --base-version <old> --target-version <new> --base-apk <old.apk> --target-apk <new.apk>
npm run rhythmctl -- normalize --input <manifest-or-report> --game <game> --version <version>
npm run rhythmctl -- content add --input <content-input.json> [--previous <manifest.json>]
npm run rhythmctl -- diff --current <manifest.json> --previous <manifest.json>
npm run rhythmctl -- review --delta <delta.json>
npm run rhythmctl -- approve --review <review.json> --reviewer <name>
npm run rhythmctl -- check-approval --review <review.json>
npm run rhythmctl -- storage diff --local <manifest.json> --published <manifest.json>
npm run rhythmctl -- release prepare --current <manifest.json> --previous <manifest.json> --review <review.json>
npm run rhythmctl -- verify [--catalog <catalog.json>] [--state <state.json>]

### Initial release versus update

extract and diff require --previous for an existing-game update. A first onboarding release must say --initial (or --onboarding) explicitly. A state created by content add is content-addition rather than game-update, so its diff may omit --previous when the content batch was built without a prior manifest. release prepare additionally requires --published for an existing game's storage diff; use --initial for a first release. The normal sequential state path is probe -> ingest -> extract -> normalize -> diff -> review -> approve -> release prepare -> verify.

`onboard plan` writes the selected/excluded asset policy to `temp/rhythmctl/profiles/<candidate>/selection-policy.json`, records it in `state.json`, and known-game extraction inherits that policy when the profile slug is reused. Unselected manifest entries are not silently published.

## Cross-session state

Default workflow root is temp/rhythmctl/<game-or-candidate>/<version>/. It contains state.json plus probe, profile, plan, extractor result, candidate Manifest, Delta, Review, storage diff, release plan, and verification artifacts as available.

Inspect and resume without guessing:

npm run rhythmctl -- status --state temp/rhythmctl/<game>/<version>/state.json
npm run rhythmctl -- resume --state temp/rhythmctl/<game>/<version>/state.json

status is read-only. resume prints the next owning step and blockers; rerun that step after fixing the blocker. State updates are atomic and preserve source snapshot, completed steps, artifacts, review status, and release status.
If a step recorded a blocker, resolve it outside the workflow and run `resume --state <state.json> --resolve`; this only restores the saved phase and never skips a step.

## Write boundary

probe, ingest, extract, normalize, content add, diff, review, release prepare, and verify write only under temp when they write files. release prepare is local dry-run and reports READY_LOCAL_ONLY with remoteWrite=DISABLED. No command in this consolidation uploads/deletes ROS objects, edits a source directory, publishes production, or pushes Git.
