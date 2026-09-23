# Admin bootstrap boundary

This repository remains the player-facing website and public publication
boundary. It owns the formal public Catalog, public Browse/Timeline
projections, public validation, Stats Worker input, and Pages build.

The private/local Admin lives in the sibling repository:

```text
E:\\rhythm-archive-admin
```

The split is deliberate:

| Classification | Website repository | Admin repository |
| --- | --- | --- |
| `PUBLIC_CANONICAL` | Catalog, public projections, site, Stats registry, public checks | read-only Catalog summary input |
| `ADMIN_PRIVATE_SOURCE` | source references only; no extractor/runtime copy | adapters, workflow orchestration, review workspace, publishing executor, local Admin runtime |
| `RUNTIME_EPHEMERAL` | ignored `temp/`, `.runtime/`, caches, logs, generated intermediates | ignored Admin `temp/`/`.runtime/` and caches |
| `HISTORICAL_EVIDENCE` | Catalog release IDs and this audit reference | private release-manifest/curation history and evidence ledger |
| `SOURCE_INPUT` | never committed | APK, installation directory, data, bundles and Addressables remain read-only external inputs |
| `SECRET_OR_CONFIG` | no credentials or local path values | environment variables/local secure config only; never Catalog, public projection, or evidence payload |

The following existing local paths are Admin/private source and must not be
forced into this Git repository:

- `packages/admin/src/` and `packages/admin/tests/`: the loopback prototype,
  workspace view, candidate review, atomic write, raw-integrity, and
  secret-free error implementation.
- ignored lifecycle modules under `packages/domain/src/`: workspace,
  review, diff, release, publish, storage, workflow-state, adapter/platform,
  and legacy migration implementation.
- ignored adapter/import/publish sources under `tools/`, including
  `rhythmctl.ts`, `adapter-registry.ts`, the game-specific adapter folders,
  importers, ROS verification and upload executors.

The private repository preserves these sources with an original-to-destination
map. The active bootstrap does not fork Astro/PublicSiteData or import a
player-facing module. It reads the website's `catalog/index.json`, requires
Catalog schema `1.0`, and fails closed with `SITE_CONTRACT_UNSUPPORTED` when
the contract changes.

`GAME_CONFIG` remains display configuration for the player-facing site. The
Admin's single runtime registry covers Arcaea, Phigros, Rizline,
Paradigm: Reboot, In Falsus, Orzmic, and Rotaeno, with explicit capability
flags. It does not use the old two-game `GAME_REGISTRY` or broaden the legacy
`UpdateBatch` enum in the website repository.

`ReleaseManifest.status` is not external publication proof. Admin evidence
records source inspection, candidate/review/release-plan stages, ROS object
verification, Catalog/Git facts, and Pages build/deployment facts separately.
Historical gaps remain `UNKNOWN` or `LEGACY_UNVERIFIED`; no missing history is
invented.
