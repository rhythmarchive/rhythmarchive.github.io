# Game-specific review policy

The policy is implemented in `packages/domain/src/review.ts` through `applyReviewPolicy()`.

## Separate meanings

- `reviewRequired`: a human must inspect and confirm the automatic proposal;
- `manualNamingRequired`: a filename correction is needed;
- `metadataReviewRequired`: title/artist or other metadata is incomplete;
- `identityReviewRequired`: the resource cannot be safely associated with an external identity;
- `upscaleRecommended`: an independent later AI/upscale step is useful;
- `upscaleRequired`: processing must complete before READY.

These flags are intentionally not collapsed into `needsReview`.

## Arcaea

An exact songId, complete title and readable filename normally produce:

```text
reviewRequired = true
manualNamingRequired = false
metadataReviewRequired = false
identityReviewRequired = false
upscaleRecommended = true for jackets
```

The normal action is confirmation. `confirmCandidateInWorkspace()` preserves the automatic filename and does not write `manual-rename` history. A genuine songId ambiguity is blocked until identity resolution.

## Phigros

Phigros metadata is trusted only when the extractor evidence is complete enough. Missing title or artist produces `metadataReviewRequired=true`, but does not automatically imply a rename. If a key/object mapping cannot be trusted, `identityReviewRequired=true` and the Candidate is blocked.

`overrideCandidateMetadataInWorkspace()` records a human correction under `review.overrides` while preserving the automatic mapping and provenance. `overrideCandidateFilenameInWorkspace()` is the only normal path that represents an actual filename change.

## Progress

`computeUpdateBatchProgress()` and `UpdateBatch` now expose naming-edit, metadata-review and confirmation progress separately. A normal Arcaea batch can therefore show many pending confirmations and zero naming edits without implying that every file must be renamed.
