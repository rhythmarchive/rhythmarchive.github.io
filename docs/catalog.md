# Catalog and public data

## Contract

Catalog is the formal published boundary. A UnifiedAssetManifest is a candidate/release input; it becomes public only after selection, normalization, review, approval, and Catalog/public projection validation.

Published Game values remain strongly typed. Unregistered candidate slugs live in onboarding state and DraftGameProfile, not in the formal Game registry.

## Identity

Asset identity, Resource identity, Object identity, rendition role, source identity, object key, and public URL are separate concerns. Reuse stable identity from previous manifests and do not regenerate UUIDs or move remote keys for cleanup alone.

## Scope

Selection policy determines which discovered resource types become Candidates. Diagnostics can retain excluded or unsupported resources without exposing them to the site. Metadata-only corrections should preserve the semantic identity and object where possible.

## Public projection

PublicSiteData and SearchIndex are projections of Catalog. They may expose player-facing names, aliases, categories, variants, previews, downloads, and approved metadata. They must not expose absolute paths, credentials, extractor commands, temporary artifact paths, or internal storage diagnostics.

## Compatibility checks

Before release, validate schema, unique stable detail routes, referenced Objects/Renditions, public URL construction, download filenames, and multi-game projection behavior. The site consumes the projection rather than game-specific extractor output.
