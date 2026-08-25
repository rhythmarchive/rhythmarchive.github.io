# Rotaeno APK inspection

This milestone is a local, read-only inspector for Unity Addressables APKs.
It deliberately records semantic paths and catalog AssetGUIDs as identity and
keeps bundle names, object indexes, and hashes as provenance.

```powershell
python -m tools.rotaeno inspect `
  --apk apk\旋转音律_2.26.1.apk `
  --out temp\rotaeno_analysis\generated_manifest

python -m tools.rotaeno diff `
  --old temp\rotaeno_analysis\old\semantic_manifest.json `
  --new temp\rotaeno_analysis\generated_manifest\semantic_manifest.json `
  --out temp\rotaeno_analysis\update_set.json
python -m tools.rotaeno.selection --manifest temp\rotaeno_analysis\generated_manifest\semantic_manifest.json --bundle-inventory temp\rotaeno_analysis\inventory\business_bundle_paths.txt --song-inventory temp\rotaeno_analysis\inventory\song_inventory.json --pack-inventory temp\rotaeno_analysis\inventory\pack_inventory.json --out temp\rotaeno_analysis\full_public_selection.json
python -m tools.rotaeno extract-images --apk apk\旋转音律_2.26.1.apk --selection temp\rotaeno_analysis\full_public_selection.json --out temp\rotaeno_analysis\full_public_extract
```
For a formal image batch, use an explicit selection file and keep its output
under temp/. The adapter preserves the source identity, AssetGUID, logical
key, bundle hash, decoded PNG hash, and dimensions in the external manifest
before the shared workflow normalizes it.

The inspector and extractor do not contact a catalog or game service. The
inspector resolves APK identity plus catalog-backed song, pack, pilot, event,
journey, and image/audio candidate rows. The formal public selection includes
jackets, pack covers, decodable character art, story CG, and startup visuals;
event artwork, journey art, badges, audio, charts, and unresolved candidates
remain local diagnostics.
