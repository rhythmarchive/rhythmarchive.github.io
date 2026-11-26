# Arcaea APK publication

The updater no longer creates GitHub Releases. Existing historical links remain live only until the public R2 cutover is verified. ROS stores the small `apk/arcaea/latest.json` manifest, never the APK payload.

- `check-only` discovers the official version without writing storage.
- `stage-private` verifies the official APK locally and stages its content-addressed object in private Standard R2. It checks the full stored SHA-256 and does not publish the URL or change the manifest.
- `publish` requires `ARCAEA_R2_ENABLED=true`. Before replacing the manifest it checks the gateway's HEAD and first/last single-byte Range responses against the local APK using If-Range. Size does not select a different storage provider.

The job uses read-only GitHub permissions, the existing ROS secrets, bucket-scoped `ARCAEA_R2_ACCESS_KEY_ID` and `ARCAEA_R2_SECRET_ACCESS_KEY`, plus `ARCAEA_R2_ENDPOINT`, `ARCAEA_R2_BUCKET` and `PUBLIC_ARCAEA_R2_BASE_URL`. Keep public publishing disabled until the Workers account plan, budgets and controlled download domain have been verified. Do not expose r2.dev. Bucket-local capacity checks do not constrain other account usage.
