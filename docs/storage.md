# Storage and release boundary

## Diff semantics

Storage diff is derived from manifest identity, SHA-256, size, rendition role, object key, and public URL. It does not require downloading every remote object.

- SAME: no-op.
- NEW: future upload candidate.
- CHANGED: future upload candidate while preserving semantic identity when possible.
- REMOVED: human review only; never automatic remote deletion.

## Local release

release prepare validates the Delta and exact Review package, computes a storage diff and writes a local release plan. It must pass review, tests, site check, build, smoke, and Git preflight. The current CLI reports READY_LOCAL_ONLY and remoteWrite=DISABLED.

## Future production executor

A separate explicitly authorized write-enabled workflow may upload NEW and CHANGED, verify hashes and metadata, and write Catalog atomically after successful verification. It must keep SAME as a no-op and REMOVED as a review item. It must not infer deletion from missing files or rewrite stable object keys.

## Failure recovery

If upload or verification fails, the previous formal Catalog remains authoritative and the local workspace remains available for retry. No source directory is modified, and no cleanup is inferred from a failed run.
