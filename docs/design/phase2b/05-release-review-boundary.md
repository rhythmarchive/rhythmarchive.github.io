# ReleaseManifest and ReviewLog Boundary

Phase 2B separates public release facts from local workflow history.

`ReviewLog` contains local events such as:

- rejected or ignored Candidate;
- manual filename review;
- content replacement revision;
- raw-integrity problem;
- ambiguous/missing workspace file;
- upscale attempt failure or selection;
- conversion and final-review notes.

`ReleaseManifest` contains only website-visible version facts:

- Resource, Variant and Rendition added;
- a Rendition Object replaced;
- metadata changed;
- an alias/download name added;
- final published rendition references.

It has no `ignoredCandidates` field in newly generated data. Rejected and ignored records remain in `metadata/review-log.json` and cannot enter a formal release manifest. A missing filesystem file is not treated as rejection.

## Rendition identity

Rendition is the long-lived semantic slot. `replaceRenditionObject()` keeps `Rendition.id` and changes only `objectId`; this applies to both original and upscaled roles. A new rendition role creates a new Rendition ID. `downloadFilename` is stored on the Rendition/release entry and is independent of Object identity, so the same Object may be referenced by different Resources with different download names.
