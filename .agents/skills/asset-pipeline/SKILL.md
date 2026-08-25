---
name: asset-pipeline
description: Use for deterministic probe, extract, normalize, validate, and manifest work after a game adapter or onboarding profile is known.
---

# Asset pipeline

## Trigger and exclusion

Use this for a known adapter and a bounded source. Do not use it to discover an unknown game's package structure; route that to game-reconnaissance first.

## Inputs and preflight

- Load the Game Profile, adapter contract, selection policy, previous manifest when updating, and workflow state.
- Confirm the source is read-only and all outputs point into temp.
- Check adapter capabilities and entrypoints before invoking an extractor.
- Preserve source snapshot, stable identity, provenance, diagnostics, and rejected candidates.

## Ordered workflow

1. Probe and persist the source snapshot and extraction plan.
2. Ingest the source declaration into a version workspace.
3. Call the registry-resolved adapter extract handler; do not add a game switch to rhythmctl.
4. Normalize extractor output into UnifiedAssetManifest.
5. Validate schema, identity, rendition, selection policy, and public projection boundaries.
6. Write the candidate manifest, then hand off to diff and human-review.

The formal orchestration is tools/adapter-registry.ts and tools/rhythmctl.ts. Mature Python/TypeScript extractors remain behind adapters.

## Contract and gates

An adapter exposes profile, capabilities, probe, extract, normalize, and validate responsibilities either directly or through a wrapper. Its output boundary is temp and its game-specific knowledge must not leak into shared site components.

Unsupported markers, extraction failure, large count anomalies, identity collapse, or missing metadata are blockers. Do not silently publish a partial extraction.

## Validation and completion

Run typecheck and focused domain tests, inspect manifest counts and diagnostics, and verify state artifacts are atomic and resumable. Completion means a validated candidate manifest exists; it does not mean review or release approval.
