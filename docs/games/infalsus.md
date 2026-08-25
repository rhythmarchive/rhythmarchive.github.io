# In Falsus

- Lifecycle: published; existing Catalog and shared site route.
- Source and engine: installation directory, Addressables, and manifest inputs; markers include if-app_data/streamingassets/aa/catalog.bin, songdata, and dynamicstringmapping.
- Adapter/extractor: adapterId infalsus-addressables; tools/infalsus inspect, extractor, and prepare-publish entrypoints through the external adapter wrapper.
- Identity and scope: available songs and reviewed jacket assets are the default publication scope; small artwork can be a validation/preview source when policy permits.
- Traps: Addressables paths and source filenames are provenance, not necessarily public identity. Keep unavailable or ambiguous songs as diagnostics.
- Update strategy: use the existing profile and previous Manifest, normalize to the shared boundary, and review changes before a local release plan.
- Last validated assumptions: published status reflects current repository Catalog/profile; no scope expansion is implied.
