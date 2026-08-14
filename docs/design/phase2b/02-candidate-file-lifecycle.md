# CandidateFile Lifecycle

`Candidate` is the stable semantic work unit. Its `CandidateFile` records the current path and bytes for a role, while `CandidateFile.revisions[]` records the small amount of history needed to explain local edits.

The initial workspace creates `raw-original` and `work-original` files. The latter starts at revision 1. A same-path byte replacement preserves the Candidate and CandidateFile IDs and appends revision 2 (or later) with path, filename, size, hash, mtime, observation time and reason `content-replacement`.

Rename and move reconciliation also retain the CandidateFile ID and append a revision with reason `rename` or `move`. The current filename is added to `knownBasenames`; an externally changed finalized name is surfaced as a reviewed filename so the next final review can confirm it.

Generated roles are:

| Role | Created by | Identity rule |
|---|---|---|
| `raw-original` | workspace creation | hash is checked against raw manifest |
| `work-original` | workspace creation/manual addition | Candidate identity stays stable across path/content changes |
| `upscale-input` | `prepareUpscaleInputs()` | ordinary copy, mapped by Candidate ID and source hash |
| `upscale-output` | `reconcileUpscaleOutputs()` | one logical attempt per Candidate reference; never auto-selected when multiple exist; disappearance marks `availability=missing` and keeps the audit record |
| `processed-upscaled` | `convertSelectedUpscale()` | verified JPEG staging output, source PNG retained |
| `supplemental` | reserved for future non-primary files | never inferred as semantic publication |

`REJECTED` is only written by explicit `rejectCandidate()`. Missing, ambiguous and raw-integrity states remain `BLOCKED` or local error state.
