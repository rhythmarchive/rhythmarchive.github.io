---
name: site-design
description: Use when changing the gallery site's visual language, information architecture, responsive behavior, copy, component consistency, or future theme extension rules.
---

# Site design

## Current baseline

The existing light/dark/system behavior and current visual language are the DEFAULT / CANONICAL THEME. This turn must not add a visible theme, theme selector, large recolor, new font system, dashboard styling, or a page-by-page redesign.

This is an image resource download site: image discovery, search, category, preview, metadata, and download outrank decoration. Keep the UI simple, readable, restrained, and shared across games.

## Trigger and exclusion

Use for design principles, visual consistency, responsive rules, or theme boundaries. Use site-development for actual code edits. Do not invent a separate page hierarchy for a new game.

## Contract

Future themes may provide a small ThemeDefinition through existing CSS variables/tokens and a registry boundary. They must reuse the same information architecture, search core, Gallery, Card semantics, routes, and functional state. No theme-specific page tree is allowed.

## Review workflow

1. Read docs/site-design.md and inspect the existing pages before changing styles.
2. Compare home, search, at least two game routes, detail, and a narrow/mobile viewport when a visual change is requested.
3. Prefer token extraction or a local consistency fix over broad visual changes.
4. Check copy for player-facing language; do not expose manifest, object key, or internal pipeline terms.
5. Hand code changes to site-development and validation-ci.

## Completion and stop conditions

Completion means the current baseline remains recognizable, shared semantics are preserved, and responsive/readability checks pass. Stop and record a design decision when a request would require a new visible theme or a different information architecture; it needs an explicit product decision.
