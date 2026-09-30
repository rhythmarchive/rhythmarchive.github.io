# Public Rhythm Archive product repository

Keep only the independent GitHub Pages/Astro product, public Catalog/schema/domain/browse projections, public Stats Worker, Arcaea APK automated update workflow, and the tools/tests/configuration actually required by those flows. A file under `tools/` may be essential to CI or Actions; trace its callers before moving it.

- `npm run ci:check` is the full local quality gate. Pages and quality workflows call it. `apps/site/scripts/generate-public-data.ts` generates the public search, gallery, detail, ranking and batch data; `apps/site/scripts/generate-stats-resource-registry.ts` updates the Stats Worker registry from the public Catalog. Use the generator and full gate for registry changes.
- Keep `tools/validate-browse-projection.ts` for `browse:check`. Keep `tools/arcaea-apk-update.ts` and `tools/arcaea-apk-updater/` for `.github/workflows/arcaea-apk-update.yml`. Keep their imported `packages/domain/src` modules and Worker tests/configuration. Do not infer that every non-UI file is private.
- The local Arcaea updater reads optional ignored credentials from the sibling Workspace `config/public-updater.dev.vars`; GitHub Actions supplies Secrets through its environment. Never put those values in this repository.
- The site is player-facing and public-safe. No Admin/Operator Center implementation, internal game extractors, private ROS operations, Cloudflare inventory, source APKs, extraction output, credentials, secrets or local cache belongs here.
- Public Catalog and ReleaseManifest are canonical. Preserve object identity and publication evidence boundaries; a manifest `published` field alone does not prove ROS, Git or Pages deployment.
- Before changing Pages, Stats or APK automation, check the corresponding workflow and test the full caller chain. Preserve the existing Pages deployment method.
- Never commit `.env`, `.dev.vars`, tokens, private paths or large runtime inputs. Check the exact Git repository, status, diff, generated data and Secret absence before committing. Stage exact paths and preserve unrelated work.

## Git workflow

Routine low-risk work uses `main` directly by default. Before editing, verify the repository root and `git status --short --branch`. If `main` is behind `origin/main` and synchronization is safe, run `git pull --rebase origin main` before editing. If the checkout is on another branch, keep that branch intact and switch only when the worktree is clean and no local work would be lost.

After risk-matched checks, review the exact staged diff, make one scoped commit, and push with `git push origin main` when GitHub rules allow it. Do not create a branch, PR or merge commit only for formality. Pages builds and deploys through `.github/workflows/pages.yml` after eligible pushes to `main`; do not perform a separate manual deployment for an ordinary site change.

Use an independent branch and PR when appropriate for large refactors across core modules; major GitHub Actions, deployment or release changes; important Worker/backend, permission or security changes; potentially irreversible or large data changes; uncertain experiments; or an explicit user request. File count alone is not a reason to use a PR.

Never bypass a ruleset or branch protection. If a rule requires a PR and blocks a direct push, stop and tell the user which rule and Settings page to change; do not silently create a PR as a workaround. Check the active remote rule each time because GitHub settings can change.

## Verification

Follow the workspace-root AGENTS.md Verification Policy; this file supplies Public-specific command examples.

- Level 1: npm run typecheck, npm run worker:typecheck, npm run stats:registry:check, and npm run browse:check.
- Level 2: run only the affected gallery test, for example node --import tsx --test apps/site/tests/browse-gallery.test.ts; for one Stats Worker case use node --import tsx --test workers/stats/tests/index.test.ts.
- Level 3: use the affected site, Worker, or APK-updater checks. Run site build/smoke only when generated site output or browser/runtime behavior is affected.
- Level 4: npm run ci:check is the Public full gate. Use it for shared Catalog/domain/schema contracts, generator implementation, CI/build/deployment/release changes, broad or high-risk publication batches, final acceptance, or when targeted evidence cannot cover the risk. Routine resource or Catalog content/metadata updates use their required generators and targeted consistency/contract checks; a push by itself does not trigger the full gate. Stats registry contract or generator changes still use the formal generator and full gate.
- Documentation, AGENTS and ignore-only changes are Level 0 unless the workspace-root final-acceptance requirement explicitly asks for full gates.
