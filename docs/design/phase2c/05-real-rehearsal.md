# Real APK rehearsal

The rehearsal entry point is:

```text
npm run phase2c:rehearsal
```

The rehearsal reads local directories from `ARCAEA_APK_DIR`, `PHIGROS_APK_DIR` and `LEGACY_PROJECT_ROOT`, or from the matching command-line arguments. There are no machine-specific path defaults in the tool.

```text
ARCAEA_APK_DIR
PHIGROS_APK_DIR
```

Optional arguments are `--arcaea-apk-dir`, `--phigros-apk-dir`, `--legacy-project`, `--rehearsal-root` and `--report-root`.

When a pair exists, the tool invokes the configured legacy Arcaea extractor or Phigros extractor with output under V2 `.runtime/rehearsal/`, adapts the report, creates a V2 Version Workspace, and records candidate/review statistics. It may confirm a small number of high-confidence Arcaea proposals in that isolated workspace. It does not modify the configured legacy project or Legacy Asset Root, ROS, Catalog, Git or the public site.

## Current run

The current machine has:

- Arcaea: `arcaea_6.16.0c.apk` only;
- Phigros: `Phigros_3.19.5.apk` only.

Both real rehearsals are therefore blocked with `REAL_APK_REHEARSAL_BLOCKED_MISSING_LOCAL_INPUT`. The Phigros report explicitly records the one-APK special case. No real old/new diff or extraction statistic is claimed.

Machine-readable reports:

- `docs/design/phase2c/data/arcaea-rehearsal.json`
- `docs/design/phase2c/data/phigros-rehearsal.json`

Required future input: at least two distinct local versions in each game directory, with one selected as base/old and one as target/new. The rehearsal tool does not download a missing version.
