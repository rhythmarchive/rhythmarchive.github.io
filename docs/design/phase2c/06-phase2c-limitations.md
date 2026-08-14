# Phase 2C limitations and unresolved items

1. The provided APK directories currently contain one APK each, so no real old/new APK rehearsal was possible.
2. Phigros changed-bundle detection remains unresolved because the legacy extractor compares new bundle/key presence, not resource-level content changes inside an existing bundle.
3. Arcaea `_256` semantics remain unresolved and are not inferred automatically.
4. Historical Arcaea archive files do not all carry a provable source APK version; the adapter retains this as provenance uncertainty.
5. Phigros internal key names may not equal formal display titles or artists. Partial keys are evidence, not fabricated metadata.
6. A real Phigros run also depends on the local Python environment having UnityPy and texture2ddecoder.
7. This phase does not define production Catalog/ROS retention, deletion, rollback or public APK distribution.
8. This phase does not implement Admin WebUI, Astro public-site changes, SQLite, cloud APK automation, GitHub Actions or legacy migration.

These limitations are represented as diagnostics/limitations or blocked review states where they affect a Candidate. They are not silently treated as successful extraction.
