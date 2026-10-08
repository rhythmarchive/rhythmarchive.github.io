# Public Rhythm Archive repository

Owns Pages/Astro, public Catalog/schema/domain/Browse, Stats Worker and Arcaea APK automation. Private extraction/ROS tooling belongs in Tooling; operator controls/evidence belong in Admin. Never copy them into Public.
Follow workspace-root AGENTS.md for risk, boundaries, Git and scratch. Preserve unrelated changes and stage exact paths.

## Executable defaults

- Ordinary content: prepare Catalog/Browse/Updates together, run npm run update:fast. This generates the Stats registry and validates schema/references, timeline invariants, Browse and registry. No Worker business tests or local full site build.
- Ordinary pages/styles/small bugfix: npm run check:fast; choose one affected test for behavior changes. No resource/ROS/Admin work.
- Reuse existing components, lib projections and generated public data before adding a page, script or parallel data path. Defer non-essential reads until needed and keep the change off the runtime path of unrelated pages; adding a runtime dependency, an eager global script or a blocking third-party request needs a concrete reason.
- First-screen load, mobile behavior, request count and ROS/Cloudflare consumption are part of the change. Use the existing shared, lazy and per-page/classification loading paths; the existing traffic and site behavior checks cover the boundary, so do not add new budgets or measurement frameworks.
- Worker code: npm run worker:check. Registry-only data: npm run stats:registry:check.
- Docs: git diff --check and status.
- Explicit shared contracts/generators/build/Actions/infrastructure/major data changes: npm run ci:check once. Never use final acceptance or publication consistency as an escalation reason.
- check:changed -- --ci --base <commit> is the remote change-aware gate: content checks when needed, Worker gate only for Worker code, one Pages build/traffic/smoke. FULL includes its own build, never builds twice.

Stats registry uses public resource IDs plus game identity/display names. Catalog generatedAt alone is not registry change. /health registryHash verifies a changed deployment. A display/Browse/Updates change does not deploy Worker. Worker core/config/shared UUID runtime changes do.
Generate formal outputs; never hand-edit registry or public/data. Public cards stay preview-only; originals/upscales are explicit detail/download paths.

Catalog is public source of truth. ReleaseManifest is optional private production input, not an Admin synchronization or ordinary publication blocker. Prepare publishedAt before first commit; never replace it with Pages success time afterward.
Routine Git: confirm child root/status -> standard fetch/pull --rebase -> one commit on main -> git push origin main. No gh/plugin/browser/PR for routine publish. If protection rejects push, report it; never bypass or silently create PR.

Repository skills are in .agents/skills. update-timeline is tracked; other development skills are local. Read only the skill needed by the task.
Arcaea APK updater is independent: tools/arcaea-apk-updater package and tools/arcaea-apk-update.ts remain public; its check-only mode is read-only. Credentials come from Workspace config/.dev.vars or CI Secrets, never public files.
