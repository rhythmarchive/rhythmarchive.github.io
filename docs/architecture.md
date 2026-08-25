# Architecture

## Current boundary

External APK, AAB, installation directory, AssetBundle, Addressables catalog, remote declaration, or manual source is handled by a Game Profile and Adapter. The adapter emits a candidate or a UnifiedAssetManifest. The shared boundary is:

    source -> adapter -> candidate/manifest -> review -> delta/release
                                      -> Catalog/PublicSiteData/SearchIndex
                                      -> shared site

The site never knows how an APK is decoded, how UnityFS is read, where a game's bundle lives, or how a remote game resource is acquired.

## Domain boundaries

- packages/domain/src/platform.ts owns formal GameProfile, the published Game registry, read-only SourceProbe, extraction plans, and adapter capabilities.
- packages/domain/src/onboarding.ts owns unregistered candidate probing, DraftGameProfile, selection policy draft, and analysis artifacts.
- packages/domain/src/content.ts turns manual and metadata batches into the same candidate manifest boundary used by package extraction.
- packages/domain/src/release.ts owns UnifiedAssetManifest and ReleaseDelta.
- packages/domain/src/review-package.ts owns review/approval and exact delta matching.
- packages/domain/src/storage-diff.ts compares hashes, sizes, object identities, and remote keys without implying deletion.
- packages/domain/src/workflow-state.ts owns the on-disk state machine and atomic state updates.

## Adapter contract

The core CLI resolves a registry entry and invokes standard capabilities: probe, extract, normalize, and validate. Existing Python and TypeScript extractors remain unchanged behind tools/adapter-registry.ts or tools/rhythmctl-external.ts. Adding a game should add a profile and handler, not another rhythmctl game switch.

## Lifecycle separation

An unregistered candidate is identified by a safe slug and can be reconnaissance-complete without being a formal Game. A published Game requires a deliberate profile, selection policy, adapter, Catalog projection, and shared-site registration. Rotaeno is intentionally analysis-only/onboarding until a separate decision.

## Site boundary

apps/site consumes generated public data and shared routes/components. Game-specific metadata belongs in catalog projection or configuration. Public projection excludes local paths, credentials, extractor diagnostics, and internal storage details.
