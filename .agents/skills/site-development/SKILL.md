---
name: site-development
description: Use when modifying shared gallery routes, search, cards, detail pages, catalog projections, downloads, or responsive site code.
---

# Site development

## Trigger and boundary

Use for actual website implementation. Read site-design first for visual changes. Do not build ArcaeaPage, RizlinePage, PhigrosPage, or another per-game page tree.

## Inputs and preflight

- Inspect current route/layout/component structure, generated PublicSiteData, Catalog projection, and the relevant tests.
- Preserve the current DEFAULT / CANONICAL THEME and existing light/dark/system behavior.
- Confirm game differences can be expressed as Game Config, PublicSiteData, projection metadata, or a narrow extension point.
- Do not put APK, AssetBundle, Addressables, or extractor logic into shared pages.

## Ordered workflow

1. Reproduce the existing page or test baseline.
2. Modify shared BaseLayout, navigation, SearchBox, Gallery, ResourceCard, Detail, search index, or projection only where the behavior belongs.
3. Keep whole-site and in-game search on one search core and preserve stable public URLs.
4. Add or update focused tests for multiple games and mobile-sensitive behavior.
5. Run site check, build, smoke, and validation-ci; inspect the built output when layout is affected.

## Gates and recovery

New per-game route duplication, public leakage of local provenance, changed object URLs without evidence, visible redesign, or a broken shared search is a blocker. Revert the narrow local change or move the difference into profile/projection code.

## Completion

Completion means shared routes serve multiple games, public data contains no local/source-only fields, existing visual baseline is preserved, and all site checks pass.
