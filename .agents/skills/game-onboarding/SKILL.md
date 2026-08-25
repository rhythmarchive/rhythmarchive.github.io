---
name: game-onboarding
description: Use when a reconnaissance-complete candidate should become a deliberately scoped, published game through the shared adapter and release workflow.
---

# Game onboarding

## Trigger and boundary

Use after game-reconnaissance has produced a DraftGameProfile. Do not treat discovery as publication, and do not expand Rotaeno or another analysis-only candidate automatically.

## Ordered workflow

1. Read the candidate state, probe, analysis report, and onboarding plan under temp.
2. Confirm lifecycle, display name, source identity, selection policy, included categories, excluded categories, and rationale.
3. Add a formal GameProfile and Adapter Registry entry only after the decision; keep the unknown candidate separate until then.
4. Reuse the adapter contract for probe, extract, normalize, validate, and candidate manifest.
5. Run diff, human-review, approval, local release prepare, Catalog/public projection update, and shared-site validation.

## Gates and recovery

A missing scope decision, adapter capability, identity mapping, metadata, or review approval blocks onboarding. The source remains read-only and every artifact stays under temp. Resume from state rather than restarting the probe.

## Completion

Onboarding is complete only when the selected assets are in the unified Catalog/public projection, shared routes and search serve them, tests pass, and the local release gate is satisfied. Unselected categories remain diagnostics or review material.
