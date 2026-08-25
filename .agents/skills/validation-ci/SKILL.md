---
name: validation-ci
description: Use when adding or changing tests, typechecks, site checks, builds, smoke checks, browser validation, or GitHub Actions quality gates.
---

# Validation and CI

## Trigger and scope

Use for validation command design, CI workflows, or a change that needs full local verification. Do not add tests that require real APKs, private directories, ROS write permission, or a developer's Windows path to Pages CI.

## Local gate

The stable local sequence is:

1. npm run typecheck
2. npm test
3. npm run site:check
4. npm run site:build
5. npm run site:smoke
6. npm run browse:check
7. git diff --check and full git status

Use npm run test:all for the first two steps and npm run ci:check for the complete quality gate, including browse projection validation.

## Workflow rules

Pages CI installs once, runs the quality gate before artifact upload, and deploys only after the build job succeeds. Keep external writes and source-package analysis out of CI.

For new workflow behavior, add fixture-based tests for unregistered reconnaissance, state transitions/resume, adapter registry, content additions, review approval, and shared multi-game site routes.

## Failure and completion

On failure, capture the exact command and first actionable error, fix locally, and rerun the affected gate plus the final full sequence. Network, credentials, or external service failures are recorded as BLOCKED_EXTERNAL_ACTION; they do not justify weakening a local gate.

Completion requires reproducible command output and an explicit report of passed, failed, skipped, and externally blocked checks.
