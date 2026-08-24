# Rizline canonical acquisition and publish preparation

This package keeps the Phase 3 APK/RuntimeCache inspection commands and adds a
production path whose payload source is `REMOTE_CANONICAL`:

1. read APK version provenance;
2. build/cache the declared `patch_metadata` chain;
3. acquire and validate the official current Addressables catalog;
4. acquire only publish-scope semantic bundles;
5. decode catalog-targeted Unity objects;
6. stage canonical PNGs, WebP previews, semantic metadata, manifests, and
   review queues.

The RuntimeCache remains diagnostic-only. The production workflow does not
require `temp/com.leiting.ldgj` and never copies its bundles or images.

## Commands

All generated output must be an ignored directory. The Phase 3.7 staging root
for this repository is `temp/rizline_publish_prep`.

```powershell
python -m tools.rizline patch-list `
  --output temp/rizline_publish_prep

python -m tools.rizline metadata `
  --apk apk/律动轨迹_2.7.0.apk `
  --output temp/rizline_publish_prep

python -m tools.rizline acquire `
  --apk apk/律动轨迹_2.7.0.apk `
  --output temp/rizline_publish_prep `
  --key illustration.LifeisPIANO.Junk.0.HiRes

python -m tools.rizline prepare-publish `
  --apk apk/律动轨迹_2.7.0.apk `
  --output temp/rizline_publish_prep
```

Use `--refresh-patch-list` only when the current resource-version mapping must
be fetched again. Downloads are serial, conservatively retried, and resumed
from verified cache or partial files. A 404 is never used to probe alternate
URLs.

## Output contract

The full workflow creates:

Cached bundles and the remote catalog are reused only when their saved
SHA-256, selected resource version, URL, size, and structural checks still
match. Resource-version/platform segments and resolved cache targets are
validated before use. After a successful preparation run, generated PNG/WebP
files not referenced by the current acquisition manifest are removed from the
tool-managed staging directories.
- `cache/patch_list.json` and the verified remote catalog cache;
- `bundle_cache/<resource-version>/<server-filename>` plus metadata;
- `metadata/asset_list.json` and `metadata/rizline_semantic_catalog.json`;
- `manifests/acquisition_manifest.json` for technical provenance;
- `manifests/rizline_publish_manifest.json` for frontend-oriented candidates;
- `canonical/` PNG sources and separate `previews/` WebP files;
- `review/` CSV queues and optional contact sheets;
- `RIZLINE_PUBLISH_DATASET_PREPARATION_REPORT.md`.

GameObject-based Rizcards and banners are acquired for object/component
evidence but remain review-only; the workflow never renders them into
fabricated official static art. Layout normal and HiRes variants are both
retained and compared. Track Series records are paired only when both decoded
primary Unity object names provide an exact match.

## Tests

Offline unit tests never access the network:

```powershell
python -m unittest discover -s tools/rizline/tests -v
```

The Life is PIANO oracle is default-skipped. Its explicit opt-in verifies the
official remote catalog, 512x512 normal, 2048x2048 HiRes, and the declared v135
HiRes layer:

```powershell
python -m tools.rizline.tests.test_phase37 --integration -v
```

No command publishes, uploads, stages Git changes, or writes into website
public asset directories.
