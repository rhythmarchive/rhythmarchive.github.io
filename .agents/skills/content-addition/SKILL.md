---
name: content-addition
description: Use when site content changes without a new game package version, including manual assets, event art, metadata corrections, new categories, variants, or renditions.
---

# Content addition

## Trigger and exclusion

Use this when the source is a curated file set, official web resource, metadata correction, or editorial batch rather than a new APK update. If the task is a new version of an already published game, use game-update and its previous manifest.

Every addition still enters the same Candidate, Manifest, Delta, Review, and Release boundaries. Do not create a second publishing system.

## Inputs and preflight

- Require game id, content version or batch id, origin, and an input JSON under temp.
- Classify origin as source-derived, manual, metadata-only, new-category, new-variant, or new-rendition.
- For files, record hash, size, portable source identity, and intended rendition; keep originals and processing work files.
- Load the previous unified manifest when identity or metadata continuity matters.

## Ordered workflow

1. Prepare a ContentAdditionInput describing entries, origin, selection rationale, and optional previous manifest.
2. Run npm run rhythmctl -- content add --input <input.json> --previous <manifest.json>.
3. Inspect the candidate manifest and verify unchanged entries were preserved, stable identity was reused, and metadata-only changes did not invent a new object.
4. Run diff, review, approval, storage diff, and release prepare using the normal workflow state.
5. Keep rejected or not-yet-selected material in the local candidate/review workspace rather than the public Catalog.

## Gates and recovery

Missing provenance, duplicate identity, ambiguous rename, unsupported resource type, or an unreviewed rendition is a blocker. REMOVED remains a human review item and never implies remote deletion.

The workflow kind is content-addition and state lives under temp/rhythmctl/<game>/<version>. Resume from state and retain the input and candidate manifest.

## Validation and completion

Check origin, source identity, manifest status, delta classification, review status, and object-key compatibility. Completion means the batch is represented by the unified release machinery; publication still requires explicit review and the separate release gate.
