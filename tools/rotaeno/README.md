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
```

The inspector does not contact a catalog or game service and does not extract
bulk assets. It currently resolves APK identity plus catalog-backed song,
pack, pilot, event, journey, and image/audio candidate rows. Song title,
artist, localized names, and pack membership still require the Unity
`SongDataSO`/`PackDataSO` reader planned for the next milestone.
