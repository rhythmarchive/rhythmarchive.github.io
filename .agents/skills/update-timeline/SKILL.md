---
name: update-timeline
description: Use when publishing a new public image-resource batch or changing Catalog history so Rhythm Archive's update timeline stays correct.
metadata:
  short-description: Maintain public update timeline records
---

# Update timeline

Use this skill after a reviewed resource batch is ready to become public, or when auditing an existing timeline record. Read docs/update-timeline.md before changing the source data.

The canonical source is catalog/updates/index.json. The website projects it through apps/site/src/lib/update-history.ts; generated public JSON and dist files are outputs and must not be edited directly.

For a new batch:

1. Complete the normal extraction/content, review, approval and local release workflow first. A draft, candidate, READY_LOCAL_ONLY result or incomplete external publication is not timeline-eligible.
2. Decide whether this is the game's first overall public collection. Put that batch in baselines and keep it out of records. Do not infer a baseline by hiding the first sorted record.
3. For a later public batch, append one stable records entry. Use the real public time, evidence-backed content version, all associated release IDs, and unique Catalog resourceId values.
4. If several release manifests are one logical batch, merge their IDs into the same record. Do not create duplicate cards.
5. Exclude metadata-only edits, thumbnail/storage churn, unchanged items and removals. Keep internal change values only for deterministic resource merging; the UI presents one total such as “更新 12 项”.
6. Regenerate and validate. Check baseline exclusion, current public visibility, homepage recent updates, /updates/ filters, the batch detail page, and responsive navigation.

Run npm run test:all, npm run site:check, npm run site:build, npm run site:smoke, and git diff --check. Stage only the exact timeline source and implementation files. Do not push, deploy, delete remote objects or edit generated output as part of this skill.
