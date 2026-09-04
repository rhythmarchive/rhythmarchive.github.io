# Paradigm: Reboot adapter

`python -m tools.paradigm extract` is the initial, conservative APK adapter
for `范式：起源` / Paradigm: Reboot.

The 4.10 Android package contains named static `Texture2D` assets in the Unity
player data. The adapter publishes only three explicitly selected families:

- `character-avatar`: named 256×256 avatar textures;
- `pack-cover`: named 1639×268 shop pack banners;
- `background`: named large textures with background/scene semantics, after
  excluding UI frames, masks, buttons, and other fragments.

Song jackets and the remaining hotasset content stay excluded because the APK
references encrypted/dynamic Addressables payloads that are not locally
verifiable in this workflow. The APK is read-only; extracted Unity cache files,
PNGs, and manifests are written only below `temp/`.
