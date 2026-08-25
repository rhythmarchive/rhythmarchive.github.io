---
name: review-release-legacy-alias
description: Use only when a legacy reference names review-release; the canonical review and publishing workflows are human-review and release-publishing.
---

# Legacy alias

The old entry is retained for compatibility and does not define a second release system. Read .agents/skills/human-review/SKILL.md for review decisions and .agents/skills/release-publishing/SKILL.md for local release preparation.

The preserved rules are: review must match the exact Delta, approval requires a named reviewer, SAME is a no-op, NEW and CHANGED are future upload candidates, and REMOVED remains review-only.
