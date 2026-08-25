---
name: repository-maintenance
description: Use when auditing legacy phase files, one-off tools, generated artifacts, dead dependencies, duplicated docs, package scripts, or possible deletions.
---

# Repository maintenance

## Trigger and boundary

Use for cleanup and consolidation. Do not delete something because its name looks old. Unknown and historical-unique material stays until its knowledge is migrated and references are proven absent.

## Ordered audit

1. Record git status and inventory docs, tools, tests, fixtures, generated files, package scripts, workflows, profiles, Skills, and dynamic paths.
2. Classify every candidate ACTIVE, CANONICAL, TEST_SUPPORT, HISTORICAL_UNIQUE, SUPERSEDED, EXPERIMENTAL_OBSOLETE, GENERATED, or UNKNOWN.
3. Search imports, package scripts, workflows, tests, docs links, AGENTS, Skills, profile extractor entrypoints, scripts, and dynamic path strings.
4. Migrate any unique knowledge into canonical docs or code before considering removal.
5. Prefer a stable alias or rename when external workflow compatibility matters.
6. Delete only exact, tracked, fully superseded files with a recorded replacement and reference evidence.

## Safety gates

Never use reset, clean, broad recursive deletion, or a cross-directory move to hide user changes. Do not remove source packages, Catalog data, public URLs, remote keys, or historical evidence without explicit proof. Generated temp and reports belong under temp and must not enter Git.

## Validation and completion

Run typecheck, tests, site checks, diff-check, and a final search for removed names. The cleanup result must state retained unknowns, deletions, migrations, and why each deletion is recoverable from Git history or replaced by canonical content.
