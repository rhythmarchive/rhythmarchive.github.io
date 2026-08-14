# PublishPlan Dry-Run

`createReleaseManifestDraft()` accepts an existing simulated Catalog, the UpdateBatch and all Candidate state. It requires every non-rejected Candidate to be `READY` and a workspace root so raw integrity can be rechecked at the publication boundary; it never writes the Catalog or formal release history.

`createPublishPlanDryRun()` performs the same raw-integrity recheck and final-file verification, validates the draft against the simulated Catalog (including planned `added-*` IDs), and requires one matching published rendition per active READY Candidate, then produces:

- `objectsToCreate`: deduplicated by SHA-256, with immutable object key, MIME and size;
- `catalogMutations`: create/update/replace operations, including stable Rendition replacement;
- `releaseManifestMutation`: the draft manifest ID and target version;
- `objectsEligibleForGC`: previous replacement Objects only when their projected Catalog reference count is zero after a retention window.

The plan is always `dryRun: true` and `humanApprovalRequired: true`. It performs no ROS call, upload, deletion, Git operation, Catalog write or public deployment. Final file bytes are rehashed against the workspace state before `objectBytesVerified` is set; raw integrity is always rechecked before either draft or plan generation.

Example summary shape:

```text
total upload objects: 1
total upload bytes: 9216
new resources: 1
modified resources: 0
replaced renditions: 0
```

`summarizePublishPlan()` is the domain function intended for a future Admin view; no UI is implemented in this phase.
