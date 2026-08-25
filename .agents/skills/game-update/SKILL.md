---
name: game-update
description: Use when a published game receives a new APK, installation directory, resource package, or version manifest and should be compared incrementally.
---

# Game update

## Preflight

Load the published GameProfile, current Adapter Registry entry, source snapshot, and previous formal UnifiedAssetManifest. Never start with a full reverse-engineering pass by default.

## Ordered workflow

1. Probe the new source and compare markers, counts, and adapter feasibility with the previous run.
2. Run extract through the registry, then normalize and validate using the existing selection policy.
3. Build a Delta against the previous published manifest and retain explicit NEW, CHANGED, REMOVED, and UNCHANGED results.
4. Generate review, resolve identity and metadata anomalies, approve, and run local release prepare.

## Reconnaissance fallback

Return to game-reconnaissance only when markers disappear, extraction fails, key mappings break, counts become implausible, or identity stability collapses. Record that reason and blocker in state.

## Gates and completion

REMOVED is review-only and never deletes Catalog or remote objects. Completion means the candidate delta and review gate are valid and stable object identity is preserved; publication remains a separate authorized action.
