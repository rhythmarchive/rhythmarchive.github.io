# Site design

## Canonical theme

The current repository implementation is the DEFAULT / CANONICAL THEME. Existing light, dark, and system behavior, the blue accent, restrained cards, current font stack, and image-first resource styling remain unchanged. This turn refines the home information architecture and shared navigation; it does not introduce a visible theme, a new color direction, or a separate page family.

## Product principles

This is an image resource download site. Images are primary content. Search, category discovery, preview, metadata, and download are more important than decoration. The interface should be simple, clear, restrained, consistent, readable, and discoverable.

Avoid meaningless gradients, decorative icons, excessive animation, SaaS dashboard language, marketing claims, and internal terms such as manifest, object key, or extractor in player-facing copy.

## Home information architecture

The home page is an entry point rather than a complete category catalog. Its order is:

    Header -> centered hero and search -> optional quick links -> Arcaea APK -> recent games -> Footer

The hero keeps the Rhythm Archive brand, uses the single title “音游图片下载站”, shows a short resource description, and derives game/resource totals from PublicSiteData. It does not list every game name and does not repeat per-game category tiles. Categories remain on game pages and existing category routes.

The search box is the primary home action and uses the shared SearchBox and search core. Quick links, when present, are count-gated entries from the existing public game/category projection and are labeled as shortcuts; the site does not imply search popularity.

The Arcaea APK card is a prominent secondary entry. It reads the existing public `/apk/arcaea/latest.json` manifest through the existing parser and URL validation boundary. GitHub and official downloads remain direct links. The digest and previous version are secondary disclosures, and a manifest failure falls back to the Arcaea official entry.

## Shared game index and navigation

`PublicGameIndex` may expose `contentVersion` and `lastUpdatedAt` as public projection fields. `lastUpdatedAt` means the maximum `lifecycle.updatedAt` among that game’s final public, published resources. `contentVersion` comes only from a unique `provenance.gameVersion` associated with that latest public update; missing or ambiguous source versions are omitted. It must never be interpreted as the official latest game version.

The home game section and `/games/` use the same compact responsive game card. Cards link to the game route as a whole and show the game image, name, optional source content version, public resource count, and public content update date. The default order is `lastUpdatedAt DESC`, with deterministic name/slug ties. A positive “最近更新” label is allowed for a recent public content update; no stale, outdated, or official-version status is inferred. The home may cap the list at a small future-safe limit and always provides a “查看全部游戏” entry.

`/games/` is the complete public game library. It reuses the home card semantics and provides recent-update and name sorting without a heavyweight client framework. The header exposes one extensible “游戏库” popover with the public game list and a link to `/games/`; it must not flatten one permanent top-level link per game. The same library entry remains available at narrow/mobile widths, alongside feedback, search, and theme controls.

## Responsive and interaction rules

Desktop game cards use three columns at wide widths and two at medium widths; mobile uses one column. Home order remains hero, search, APK, and game cards. Touch targets, `:focus-visible`, keyboard behavior, light/dark/system tokens, and `prefers-reduced-motion` remain part of the shared implementation contract. Hover feedback is limited to a small border, shadow, or position change.

English display headings use normal kerning and restrained tracking so names such as Rhythm Archive, Arcaea, Phigros, Rizline, In Falsus, and Rotaeno remain readable. Chinese headings must not be loosened by a global positive letter-spacing rule.

## Shared information architecture

Home, search, game routes, category routes, gallery cards, detail pages, navigation, and downloads use shared semantics. Games may have a logo, name, accent, supported categories, and richer metadata, but not a separate page family.

Whole-site and in-game search use the same search core. Public data comes from Catalog projections and never exposes local source paths, credentials, or internal workflow state.

## Future theme boundary

Future themes may be introduced through a small ThemeDefinition, token/CSS-variable boundary, and registry. A theme may change visual expression only. It must reuse the same routes, information architecture, SearchIndex, Gallery, ResourceCard and shared game-card semantics, responsive behavior, and functional state. No theme-specific page tree or theme switcher is part of this turn.

## Change review

Before a visual change, compare home, the game library, search, at least two games, detail, and mobile/narrow layout against the current implementation. Prefer a token extraction or consistency fix over broad visual changes. If a request would add a visible theme or a different product direction, stop at the design decision gate.
