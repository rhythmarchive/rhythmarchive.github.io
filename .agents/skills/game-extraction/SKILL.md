---
name: game-extraction-legacy-alias
description: Use only when a legacy reference names game-extraction; the canonical deterministic workflow is asset-pipeline.
---

# Legacy alias

This historical entry is retained so old repository references remain understandable. For new work, read .agents/skills/asset-pipeline/SKILL.md.

Do not use this alias for unknown packages; use game-reconnaissance. Do not use it for release approval; use human-review and release-publishing.

The canonical pipeline keeps mature extractors behind the Adapter Registry, writes only to temp, preserves provenance and stable identity, and validates a UnifiedAssetManifest before review.
