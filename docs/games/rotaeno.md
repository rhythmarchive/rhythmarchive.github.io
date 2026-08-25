# Rotaeno

- Lifecycle: analysis-only/onboarding candidate; not in the formal Game enum and not registered on the shared website.
- Source and engine: tools/rotaeno provides local APK inspection and an APK-local Unity Addressables catalog reader. The tools treat the APK as read-only and write their own output only to the caller's output directory.
- Adapter/extractor: tools/rotaeno/cli.py can inspect an APK-local catalog and diff semantic manifests; it is analysis tooling, not a published GameProfile adapter.
- Identity and scope: current analysis can classify song jackets and related catalog resources. No formal public selection policy or stable Catalog identity is declared.
- Traps: do not infer formal onboarding, website registration, or publication from the existence of these tools. Preserve unknown resources as diagnostics.
- Update strategy: run game-reconnaissance/onboard probe first, then make an explicit onboarding decision and adapter contract before adding Rotaeno to the formal registry.
- Last validated assumptions: repository tools and Python fixtures exist; no Rotaeno production Catalog or site route is claimed.
