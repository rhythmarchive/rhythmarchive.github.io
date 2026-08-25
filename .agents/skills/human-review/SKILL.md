---
name: human-review
description: Use when candidates, metadata, renames, removals, anomalies, low-confidence identities, or AI-upscaled artwork need an explicit human decision before release.
---

# Human review

## Trigger and boundary

Use for NEW, CHANGED, REMOVED, rename, metadata, missing fields, anomaly, low-confidence identity, upscale, and final approval decisions. Do not treat an extractor result or an upscale output as approved merely because it exists.

## Inputs and preflight

- Load the candidate Manifest, Delta, previous published Manifest, and any local workspace evidence.
- Keep original files and _optimization.png work files; never overwrite source material.
- Confirm the proposed rendition role, format, dimensions, hash, and filename.
- Ensure the review package is generated from the exact delta being considered.

## Ordered workflow

1. Run review to produce a readable package with NEW, CHANGED, REMOVED, unchanged counts, anomalies, and proposed identity changes.
2. Inspect visual quality and metadata; resolve or explicitly reject ambiguous matches.
3. Treat AI upscale as a manual choice. After confirmation, a high-quality JPEG web derivative may be generated while retaining the original processing file.
4. Run check-approval, then approve with a named reviewer and approved change keys.
5. Hand the approved package to release-publishing; unresolved items remain local.

## Gates and recovery

Pending review, an invalid delta match, unresolved ambiguity, unsupported conversion, or missing reviewer blocks release-ready state. REMOVED only produces a review/storage item; it never authorizes deletion.

State records review path, status, blockers, and timestamps. Correct the workspace or review package, then rerun the owning step; do not edit published Catalog directly to bypass review.

## Validation and completion

Verify approved status, reviewer, approved change keys, exact delta match, rendition semantics, and preservation of source files. Completion means an auditable approval exists or a rejection is recorded, not that remote storage was changed.
