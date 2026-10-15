# Site design

This document is the design contract for the public site: what must stay, which shared mechanisms to reuse, and what may evolve. Layout tokens and control specs are in [ui-foundation.md](ui-foundation.md); local development and checks are in [CONTRIBUTING](../CONTRIBUTING.md).

## Product principles

This is an image resource download site. Images are primary content; search, category discovery, preview, metadata and download outrank decoration. The interface is clear, restrained where it carries information and expressive where it carries identity: the home stage, game marks, jacket art, chapter maps and CG compositions are the visual signature.

Animation explains origin, destination and changed state. Expressive motion is welcome when it never delays an action, never requests extra images and always has a matching exit.

## Visual identity

- Palette: blue `--accent` / `--accent-strong`, cyan `--cyan`, and a sparing warm pink `--accent-warm` (hero glow, rhythm mark). Light archive background, deep navy dark theme; both from tokens on `:root`.
- Brand mark: the three-bar rhythm mark on `.section-kicker::before` (blue · cyan · pink, slanted end). Reuse it for new section kickers instead of new ornaments.
- Home stage: a dark tilted note highway built from the local game icons (`public/game-icons/*.webp`, PNG fallback) falling toward a judgement line. It is `aria-hidden`, paused offscreen and on hover, static under reduced motion, hidden at ≤900px.
- Cards: elevation on hover is a `::before` shadow layer whose opacity changes; a soft cursor spotlight (`--mx/--my`) appears on resource and game cards for fine pointers.

## Typography

Display text uses the bundled Outfit latin variable font (`src/assets/fonts`, OFL, preloaded, metric-matched `Outfit Fallback`) through `--display-font`. Reading text and all Chinese use local system fonts (`--font-reading`, `--font-cjk`); there are no CJK web-font requests. Weights: 400 reading, 500 controls, 600 resource titles, 700 headings. Tabular numbers for counts and dates; never split a Chinese title into animated characters; Chinese headings keep normal tracking.

Scale: caption 12px, meta 13px, control 14px, body 16px, lead 18px, sections 24–32px, page 32–52px, home display 36–69px. Form inputs stay 16px on phones.

## Copy

Write like a person who runs the site: short, concrete, polite without ceremony. State the result and the next possible action (“刷新失败，下面仍是上次的热榜，可以重试。”). Avoid marketing claims, “一站式/海量/极致”-style phrases, SaaS dashboard words and internal terms (manifest, object key, extractor, ROS). Status text that only confirms a visible change is announced to screen readers, not shown.

## Selection

Operational chrome (labels, toolbars, chips, segmented controls, tabs, badges, trays, kickers, stats) is `user-select: none` via the list in `experience.css`. Titles, artists, metadata values, update notes and body text stay selectable. Add new operational containers to that list rather than scattering rules.

## Motion system

The settings panel in the header (theme + motion segmented radios) saves `rhythm-archive-theme` and `rhythm-archive-motion`; both apply before first paint, persist across client navigation, sync tabs and follow system changes. Storage failure leaves the session functional.

| Setting | Effective behavior |
| --- | --- |
| 跟随系统 (system, default) | Standard normally; reduced when prefers-reduced-motion requests it |
| 精简 (reduced) | Short opacity/color feedback only; no travel, stagger, shimmer, smooth scroll, hero animation or tap rings |
| 标准 (standard) | Crossfades, anchored surfaces, list enter/exit, desktop thumbnail-to-viewer continuity, tap ring |
| 丰富 (rich) | Larger travel and stagger, directional page travel, retained-card sorting movement, tap sparks on non-touch |

Tokens (`global.css`, overridden per level): `--motion-fast/ui/surface`, `--motion-ease` (decelerate), `--motion-spring`, `--motion-exit-ease`, `--motion-rise/travel/lift/stagger`. Rich means more amplitude and choreography, not longer waits.

### Shared mechanisms (reuse, do not duplicate)

| Need | Use |
| --- | --- |
| Show/hide a popover, sheet, tray, row | `setSurfaceVisible(node, visible, mode)` in `scripts/motion.ts`; the surface declares its entry transform with CSS `--surface-enter`. Exit makes it inert immediately and hidden at the end; a reversal continues from the current frame |
| Chips, thumbs, small keyed lists | `reconcileList(container, nextNodes, key)` (keyed enter, exit ghost, FLIP for kept items); `chipKey` for filter chips |
| Re-sorted / filtered card grid | `captureCards` + `animateCards` (bounded to visible cards) |
| Status or panel text that changed | `revealContent(node)` |
| Settling everything on level change | `finishMotion` |
| Page lifecycle | `onPageLoad`, `pageSignal`, `onPageCleanup` in `page-lifecycle.ts` |
| Pointer feedback | `scripts/pointer-effects.ts`: one pooled tap layer (add selectors to `TAP_TARGETS`), spotlight, `/` search shortcut, back-to-top, hero pause observer |

One owner per transition: ClientRouter owns page changes, the reconciler owns changed cards and chips, the surface helper owns visibility, the viewer image owns its geometry, CSS owns image readiness. Initial SSR/restore never replays list entrances; cached images do not fade again.

### Must keep

- Every element that animates in has an exit (or an explicit instant hide under reduced). Removing an exit is a regression.
- Rapid toggles and interrupted transitions start from the current visual frame; stale completions never hide a reopened surface.
- Motion never gates data, focus or interaction.
- No backdrop blur on scrolling or fixed chrome (header, batch tray, card badges); no animated `box-shadow`, `filter` or layout properties; no permanent `will-change` except on running loops; no scroll-driven animation work beyond one rAF-throttled check.
- No image request is added for an effect. Effects reuse already loaded images or local static assets.

## Range filters

Difficulty, chart constant and BPM filters keep the two numeric fields and the dual slider as the source of truth (URL params, chips, clear). A build-time histogram (`lib/range-histogram.ts`, `RangeHistogram.astro`) sits on the same axis above the slider: tap a bar to select that bucket, drag across bars for a span, tap the only selected bucket again to reset. The histogram writes to the sliders and dispatches their normal events; it never filters on its own. Bars are `aria-hidden`; the keyboard path is the fields and sliders.

## Home information architecture

    Header -> hero (title, lead, totals, search, 热门分类 shortcuts | note stage) -> 收录游戏 -> 最近更新 -> 热榜 -> Arcaea APK -> Footer

The hero keeps “音游图片下载站”, a one-line description, totals from PublicSiteData and the shared SearchBox. Quick links are count-gated category entries, labeled as categories, never as search popularity. Recent updates are a three-column grid (two at ≤1080px, swipe carousel on phones). The APK card reads the existing public manifest through the existing parser; failure falls back to the official entry.

## Shared game index and navigation

`PublicGameIndex` may expose `contentVersion` and `lastUpdatedAt` (max public `lifecycle.updatedAt`; `contentVersion` only from a unique `provenance.gameVersion` of that update, never the official latest version). Home and `/games/` share the game card and link to each game's primary category; default order is `lastUpdatedAt DESC`. The header has one “游戏库” popover; at narrow widths primary nav moves into a menu while search and settings stay visible.

## Local favorites and history

`/library/` holds favorites (cap 500, no eviction) and history (dedup, cap 200, 90 days), browser-only. Records store identity, category, title and time, not URLs. The page reads category card indices for its visible slice and reuses the viewport image loader, card renderer, list navigation and batch tray.

## What may evolve

Section compositions, the hero stage, card ornament, copy wording, breakpoints, color balance and motion amplitudes may change with a browser check. Routes, URL/filter state, search core, card semantics, download/original/upscale paths, lazy image loading, traffic boundaries and the mechanisms above are shared contracts.

## Change review

For a UI change, check in a real browser: home, game library, search, two games (one with range filters), detail, updates and a phone width; light and dark; reduced and rich; rapid open/close of one surface; filter/sort; viewer/back restore; no horizontal overflow; no console errors. Content-only updates (catalog, artwork, Browse, Updates) do not need this visual pass.
