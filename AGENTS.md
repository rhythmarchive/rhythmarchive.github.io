# Public Rhythm Archive product repository

Keep only the independent GitHub Pages/Astro product, public Catalog/schema/domain/browse projections, public Stats Worker, Arcaea APK automated update workflow, and the tools/tests/configuration actually required by those flows. A file under `tools/` may be essential to CI or Actions; trace its callers before moving it.

- `npm run ci:check` is the full local quality gate. Pages and quality workflows call it. `apps/site/scripts/generate-public-data.ts` generates the public search, gallery, detail, ranking and batch data; `apps/site/scripts/generate-stats-resource-registry.ts` updates the Stats Worker registry from the public Catalog. Use the generator and full gate for registry changes.
- Keep `tools/validate-browse-projection.ts` for `browse:check`. Keep `tools/arcaea-apk-update.ts` and `tools/arcaea-apk-updater/` for `.github/workflows/arcaea-apk-update.yml`. Keep their imported `packages/domain/src` modules and Worker tests/configuration. Do not infer that every non-UI file is private.
- The local Arcaea updater reads optional ignored credentials from the sibling Workspace `config/public-updater.dev.vars`; GitHub Actions supplies Secrets through its environment. Never put those values in this repository.
- The site is player-facing and public-safe. No Admin/Operator Center implementation, internal game extractors, private ROS operations, Cloudflare inventory, source APKs, extraction output, credentials, secrets or local cache belongs here.
- Public Catalog and ReleaseManifest are canonical. Preserve object identity and publication evidence boundaries; a manifest `published` field alone does not prove ROS, Git or Pages deployment.
- Before changing Pages, Stats or APK automation, check the corresponding workflow and test the full caller chain. Preserve the existing remote, protected-main PR process and Pages deployment method.
- Never commit `.env`, `.dev.vars`, tokens, private paths or large runtime inputs. Check the exact Git repository, status, diff, generated data and Secret absence before committing. Deploy/push only through the existing authorized workflow.
