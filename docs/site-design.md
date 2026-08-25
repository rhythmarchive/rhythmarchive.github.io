# Site design

## Canonical theme

The current repository implementation is the DEFAULT / CANONICAL THEME. Existing light, dark, and system behavior remains unchanged. This consolidation adds no visible theme, theme selector, new color direction, font system, card style, or page layout.

## Product principles

This is an image resource download site. Images are primary content. Search, category discovery, preview, metadata, and download are more important than decoration. The interface should be simple, clear, restrained, consistent, readable, and discoverable.

Avoid meaningless gradients, decorative icons, excessive animation, SaaS dashboard language, and internal terms such as manifest, object key, or extractor in player-facing copy.

## Shared information architecture

Home, search, game routes, category routes, gallery cards, detail pages, navigation, and downloads use shared semantics. Games may have a logo, name, accent, supported categories, and richer metadata, but not a separate page family.

Whole-site and in-game search use the same search core. Public data comes from Catalog projections and never exposes local source paths, credentials, or internal workflow state.

## Future theme boundary

Future themes may be introduced through a small ThemeDefinition, token/CSS-variable boundary, and registry. A theme may change visual expression only. It must reuse the same routes, information architecture, SearchIndex, Gallery, ResourceCard semantics, responsive behavior, and functional state. No theme-specific page tree or theme switcher is part of this turn.

## Change review

Before a visual change, compare home, search, at least two games, detail, and mobile/narrow layout against the current implementation. Prefer a token extraction or consistency fix. If a request would change the product direction or add a visible theme, stop at the design decision gate.
