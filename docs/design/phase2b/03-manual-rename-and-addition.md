# Manual Rename, Move and Addition

Windows Explorer is treated as a first-class editor of `work/`. The user may use F2, move a file into a subdirectory, delete it, or copy in an omitted image.

The safe identity path is:

```text
old work path
  ├─ same path + same hash       -> UNCHANGED
  ├─ path gone + one same hash   -> RENAMED or MOVED, same Candidate ID
  ├─ path gone + many same hash  -> AMBIGUOUS / BLOCKED
  └─ path gone + no same hash    -> MISSING / BLOCKED
```

When a rename/move is accepted, the previous basename remains in `knownBasenames` and the current name is recorded in the Candidate naming state. This is why an external tool can still return `foo_optimization.png` after the user has changed `foo.png` to `Testify.png`: the old and new aliases remain available.

An unassigned file is not garbage. Reconciliation creates a manual Candidate with `sourceEvidence.sourceType = "manual"`, `detection = "manual"`, a `work-original` CandidateFile and a review note requiring metadata and semantic classification. A duplicate byte hash is shown as `DUPLICATED`, but no semantic Candidate is merged.

`renameCandidateInWorkspace()` is the explicit local API for recording a human-reviewed/finalized filename. It does not derive Resource, Variant, Rendition or Object identity from that filename.
