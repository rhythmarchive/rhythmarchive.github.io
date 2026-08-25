# Project rules

## Safety

Source APKs, installation directories, AssetBundles, Addressables files, and user originals are read-only. All analysis, extraction, candidate data, reports, screenshots, state, and temporary conversions belong in repository temp. Never write caches or metadata into a source directory.

Unattended local work does not push, publish production, upload/delete ROS objects, change DNS or credentials, or use reset/clean. External actions are outside COMPLETE_LOCAL.

## Compatibility

The formal Catalog, public URLs, remote keys, and Object identity are compatibility boundaries. Preserve existing identity and URLs unless a demonstrated bug requires change. Use manifests and hashes rather than downloading every remote file for comparison.

## Selection and review

Found resources are not automatically public. Selection policy is persisted in the profile or content batch. NEW, CHANGED, REMOVED, rename, metadata, anomaly, low-confidence identity, and AI upscale require review. REMOVED is review-only.

AI upscaling is human review. _optimization.png is retained as a work file and is not the default public rendition; after confirmation a high-quality JPEG web derivative may be created without deleting the original work file.

## Site

The site is a player-facing image download gallery, not an administration dashboard. Shared routes, search, cards, detail, download semantics, and current visual language are the default. Game differences stay in profile, projection, configuration, or extension points.

## Validation

At minimum run npm run test:all, npm run site:check, npm run site:build, npm run site:smoke, npm run browse:check, git diff --check, and inspect complete git status. Pages CI runs tests, site checks, browse validation, and smoke before artifact upload and deploy.
