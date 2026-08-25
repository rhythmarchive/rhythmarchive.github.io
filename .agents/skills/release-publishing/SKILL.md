---
name: release-publishing
description: Use when preparing a local release, storage diff, publish plan, or future production publication after manifest and review work is complete.
---

# Release publishing

## Trigger and authorization

Use for release preparation and publication gates. Analysis and onboarding never publish. In this repository, this task may run only through local dry-run; ROS writes, ROS deletes, production deploys, and git push are disabled.

## Inputs and preflight

- Load candidate Manifest, previous published Manifest, Delta, Review package, workflow state, and Catalog compatibility rules.
- Require review approval or an explicit not-required result.
- Check stable Object identity, object key, remote URL, hash, size, and rendition roles.
- Run git status, tests, site check, build, smoke, and diff-check before any future remote executor.

## Ordered workflow

1. Build or load the Delta and ensure NEW, CHANGED, REMOVED, and UNCHANGED are explicit.
2. Generate storage diff from manifest/hash/size/object key; do not download each remote file for comparison.
3. Apply the review gate and produce a local release plan.
4. Run npm run ci:check or its constituent checks.
5. Run npm run rhythmctl -- release prepare ...; expect READY_LOCAL_ONLY and remoteWrite=DISABLED.
6. Verify the Catalog and public site locally. A separately authorized future production workflow may map SAME to no-op, NEW/CHANGED to upload, and REMOVED to review only.

## Gates and recovery

Missing approval, mismatched review delta, identity churn, REMOVED without review, failed quality gate, dirty unexpected files, or any missing credential/permission is a blocker. Do not work around a blocker with direct object storage or Catalog edits.

Resume from state, preserve the release plan, and fix the narrow failing artifact. Production is never implied by a local READY_LOCAL_ONLY result.

## Validation and completion

Completion for this repository means a verified local dry-run, stable URLs/keys, passing checks, and explicit proof of no external write. Future production completion additionally requires explicit user authorization and the same gates in a write-enabled environment.
