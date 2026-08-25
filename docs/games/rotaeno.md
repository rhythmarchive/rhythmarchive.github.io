# Rotaeno

- Lifecycle: formally onboarded as a published image adapter; the first local batch targets mainland CN APK 2.26.1.
- Source and engine: tools/rotaeno reads the Unity Addressables catalog and selected bundles from the APK without modifying the source. Extracted PNGs, manifests, review state, thumbnails, and publish plans stay under temp/.
- Adapter/extractor: rotaeno-apk is registered in GameProfile and tools/adapter-registry.ts; python -m tools.rotaeno extract-images accepts an explicit selection file and emits a unified candidate manifest.
- Public scope for the local 2.26.1 batch: 428 Addressables jacket rows, 97 pack-cover rows, 51 successfully decoded character/driver artworks, 10 story CGs, and 10 startup/main visuals.
- Event artwork is intentionally excluded, including event backgrounds, event buttons/icons, event-only character portraits, and summer event startup assets.
- Other excluded scope: journey map art, badges, audio, charts, and 18 small ScriptableObject-only character bundles with no readable Texture2D. These remain diagnostics in temp/.
- Identity: public Resource identity uses the Rotaeno source identity plus APK AssetGUID provenance; bundle names and logical keys remain provenance, not public URL identity.
- Publication boundary: the importer performs an approved local Catalog/ReleaseManifest write only. ROS/object-storage upload, production publication, remote deletion, and APK mutation are not part of this integration.
- Update strategy: repeat probe/ingest/extract/normalize/diff/review/approve, compare against the prior Rotaeno manifest, and keep REMOVED rows in review/storage diff until explicitly handled.
