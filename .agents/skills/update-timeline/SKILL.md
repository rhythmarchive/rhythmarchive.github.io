---
name: update-timeline
description: Prepare public update records together with Catalog/Browse before the first commit.
---
# Update timeline
Read docs/update-timeline.md and root AGENTS.md. Source is catalog/updates/index.json; generated output is never edited.
Prepare baseline/update classification, stable batch/release IDs, unique resourceId items and a timezone-bearing publishedAt together with Catalog/Browse BEFORE the first commit. publishedAt is content update time; Pages success time is verification only, never source input.
Verify only this batch's new ROS objects. Ordinary additions do not require a separate review/approval/release/evidence framework or Admin copies. Ambiguous identity, removals or requested human review still need a focused decision.
Run npm run update:fast once after the batch; changed implementation gets its relevant targeted test. Never escalate for final acceptance, safety or publication consistency.
One commit on main, one standard git push origin main, automatic required deployment, brief confirmation, finish safe task scratch. Second push requires an actual deployment/content failure or explicit user request.
