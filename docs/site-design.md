# Site design

This document describes the shared interface and the design principles for contributors. Local development and checks are covered in [CONTRIBUTING](../CONTRIBUTING.md).

## Theme and visual language

The site shares light, dark, and system themes, a blue/cyan accent, luminous layered cards, and an image-first layout. Preserve the anime and rhythm-game character: jacket art, game marks, chapter maps and CG compositions remain the visual signature. Shared type and motion make movement between these distinct surfaces coherent; they do not turn every page into the same template.

## Product principles

This is an image resource download site. Images are primary content. Search, category discovery, preview, metadata, and download are more important than decoration. The interface should be simple, clear, restrained, consistent, readable, and discoverable.

Animation is part of the interface: it explains origin, destination and changed state. Appropriate expressive animation is welcome. Avoid unrelated decoration, competing entrances, SaaS dashboard language, marketing claims, and internal terms such as manifest, object key, or extractor in player-facing copy.

## Typography

Use local fonts without web-font requests: Avenir Next / Segoe UI for Latin, PingFang SC / Microsoft YaHei / Noto Sans CJK SC for Chinese. Display and reading roles share compatible metrics; never split a Chinese title into separately animated characters. Use weight 400 for reading, 500 for controls, 600 for resource titles and 700 for headings. Avoid arbitrary 720–850 weights that resolve inconsistently on installed fonts.

The shared scale is caption 12px, metadata 13px, control 14px, body 16px, lead 18px, section 24–32px, page 32–52px and home display 36–64px. Compact resource cards may use 13px titles on phones, while form inputs remain 16px to avoid mobile zoom. Reading line-height is 1.65, compact metadata 1.5, headings 1.2. Use normal Chinese tracking and balanced heading wrapping; long resource names must wrap without widening the viewport. Tabular numbers belong to counts and dates. Retain the home display, compact gallery heading, detail title and Story Atlas editorial hierarchy.

## Motion system

The header offers a labeled native selector, available on desktop and mobile. Save `rhythm-archive-motion` locally; apply it before first paint, preserve it across client navigation, synchronize tabs, and respond live to system changes. Storage failure leaves the current session functional. Motion never gates data or interaction.

| Setting | Effective behavior |
| --- | --- |
| 跟随系统 (system, default) | Standard normally; reduced when prefers-reduced-motion requests it |
| 精简 (reduced) | Short opacity/color feedback; no spatial entrances, card travel, shimmer or smooth scroll |
| 标准 (standard) | Content crossfades, compact anchored surfaces, short list feedback, desktop thumbnail-to-viewer continuity |
| 丰富 (rich) | Directional page travel, visible-card entrance sequence and retained-card sorting movement, fuller anchored surfaces and thumbnail-to-viewer continuity on touch as well |

Tokens define fast feedback (120–160ms), UI (180–240ms) and surfaces (260–360ms); exits use fast feedback. Deceleration uses cubic-bezier(.22,1,.36,1), with a separate quick exit curve. Rich is more choreography and amplitude, not a longer wait before an action. Bound stagger to the visible portion of the current batch. No permanent compositor layers, scroll listeners, full-gallery transforms or additional image requests for motion.

One owner per transition: ClientRouter owns page changes, the reconciler owns changed cards, the surface helper owns visibility, the viewer image owns its geometry, and CSS owns image readiness. Initial SSR/restore does not replay list entrance. Cached images do not repeatedly fade. A rapid reversal starts at the current frame; stale exit completion cannot hide a reopened surface. Changing motion level finishes active owned animations and settles visibility immediately. No per-card route snapshot names or original-image preload.

Loading reserves existing geometry and decorates only requested visible images. Reduced uses a static loading surface; standard/rich use bounded shimmer. Existing viewport loading, responsive high-resolution candidates, fallback and explicit download semantics remain unchanged. CSS transitions and Web Animations API extend the existing Astro ClientRouter; no animation framework is needed. Native view-transition absence falls back to a normal functional swap.

## Home information architecture

The home page is an entry point rather than a complete category catalog. Its order is:

    Header -> centered hero and search -> optional quick links -> Arcaea APK -> recent updates -> resource ranking -> collected games -> Footer

The hero keeps the Rhythm Archive brand, uses the single title “音游图片下载站”, shows a short resource description, and derives game/resource totals from PublicSiteData. It does not list every game name and does not repeat per-game category tiles. Categories remain on game pages and existing category routes.

The search box is the primary home action and uses the shared SearchBox and search core. Quick links, when present, are count-gated entries from the existing public game/category projection and are labeled as shortcuts; the site does not imply search popularity.

The Arcaea APK card is a prominent secondary entry. It reads the existing public `/apk/arcaea/latest.json` manifest through the existing parser and URL validation boundary. GitHub and official downloads remain direct links. A manifest failure falls back to the Arcaea official entry.

## Shared game index and navigation

`PublicGameIndex` may expose `contentVersion` and `lastUpdatedAt` as public projection fields. `lastUpdatedAt` means the maximum `lifecycle.updatedAt` among that game’s final public, published resources. `contentVersion` comes only from a unique `provenance.gameVersion` associated with that latest public update; missing or ambiguous source versions are omitted. It must never be interpreted as the official latest game version.

The home game section and `/games/` use the same compact responsive game card. Cards link to each game primary category (the game root remains a compatibility redirect) and show the game image, name, optional collected content version, public resource count, and public content update date. The default order is `lastUpdatedAt DESC`, with deterministic name/slug ties. A positive “最近更新” label is allowed for a recent public content update; no stale, outdated, or official-version status is inferred. The home may cap the list at a small future-safe limit and always provides a “查看全部游戏” entry.

`/games/` is the complete public game library. It reuses the home card semantics and provides recent-update and name sorting without a heavyweight client framework. The header exposes one extensible “游戏库” popover with the public game list and a link to `/games/`; it must not flatten one permanent top-level link per game. At narrow/mobile widths, the primary navigation moves into a menu while search and theme controls remain directly available.

## Responsive and interaction rules

Desktop game cards use three columns at wide widths and two at medium widths; mobile uses one column. Home order follows the information architecture above; search remains the primary action. Touch targets, `:focus-visible`, keyboard behavior, light/dark/system tokens, and the motion preference remain part of the shared implementation contract. Spatial hover feedback is confined to fine pointers and scales with the chosen motion level.

English display headings use normal kerning and restrained tracking so names such as Rhythm Archive, Arcaea, Phigros, Rizline, In Falsus, and Rotaeno remain readable. Chinese headings must not be loosened by a global positive letter-spacing rule.

## Shared information architecture

Home, search, game routes, category routes, gallery cards, detail pages, navigation, and downloads use shared semantics. Games may have a logo, name, accent, supported categories, and richer metadata, but not a separate page family.

Whole-site and in-game search use the same search core. Public data comes from Catalog projections and never exposes local source paths, credentials, or internal workflow state.

## Local favorites and history

`/library/` shares one page for favorites and browsing history. Resource details record visits and provide a favorite toggle; no account or server storage is involved. Records remain in the current browser only. Favorites are capped at 500 without automatic eviction; history is deduplicated, capped at 200, and expires after 90 days. Clearing history preserves favorites.

Local records store resource identity, category, title, and time rather than image or download URLs. The page reads existing category card indices only for its visible slice, keeps only saved resources, and uses the shared viewport image loader, card renderer, list navigation, and batch tray. Download manifests are read only when downloading selected resources. Unavailable resources retain a removal action; failed category reads offer retry. Storage errors are visible and never claim a successful save. Collection scripts are confined to this page and resource details.

## Theme consistency

Visual changes share the existing routes, search and gallery semantics, responsive behavior, and functional state. Theme tokens and shared components keep these behaviors consistent across pages.

## Change review

Compare home, the game library, search, at least two games, detail, and mobile/narrow layout. Exercise all four preferences, system changes, reload/navigation persistence, rapid surface reversal, filtering/sorting, viewer/history continuity, cached and slow images, keyboard and no-JS fallback. Verify both themes and mobile overflow. Product direction for this revision explicitly authorizes a coordinated type and motion upgrade while preserving page identity and existing architecture.
