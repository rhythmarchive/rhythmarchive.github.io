# Rizline

- Lifecycle: published; existing Catalog and shared site route.
- Source and engine: remote declarations, directories, AssetBundles, and manifests; profile markers include globalgamemanagers, assetbundle, RuntimeCacheResolver, and Default.asset.
- Adapter/extractor: adapterId rizline-remote; tools/rizline inspect/extract/manifest modules and tools/rhythmctl-external.ts wrapper.
- Identity and scope: preserve remote-canonical asset families, stable object identity, and explicit runtime composite classification. The profile selection policy controls public categories.
- Traps: remote source declarations are not permission to upload or delete; keep source-specific bundle knowledge out of shared pages and treat missing remote evidence as a blocker.
- Update strategy: reuse profile, adapter, and previous published Manifest; compare candidate hashes and identities before review.
- Last validated assumptions: current Catalog/profile and local tool contract only; no remote write is performed by this consolidation.
