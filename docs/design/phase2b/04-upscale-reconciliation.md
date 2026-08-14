# Upscale Reconciliation and JPEG Conversion

## Input preparation

`prepareUpscaleInputs()` copies eligible `work-original` files as ordinary files to `upscale-input/`. It writes `metadata/upscale-map.json` entries containing:

```json
{
  "inputFilename": "Testify.jpg",
  "candidateId": "<uuidv7>",
  "sourceHash": "<sha256>",
  "sourceRelativePath": "work/Testify.jpg"
}
```

The copy is stable and safe for Windows GUI tools. Hard links and symlinks are not the default.

## Output matching

`reconcileUpscaleOutputs()` only considers supported optimization names such as `*_optimization.png`, `*_opt.png` and the historical `.jpg_opt.jpg` form. Matching priority is:

1. explicit sidecar output/Candidate mapping;
2. current reviewed/final basename;
3. every known alias, including the old basename;
4. source basename;
5. unresolved/manual review when there is no unique result.

One output matching several Candidates becomes `BLOCKED` with `AMBIGUOUS`; one Candidate with multiple outputs retains all attempts and has no `selectedOutputFileId` until `selectUpscaleAttempt()` is called. If a previously recorded output disappears, its attempt is retained with `availability=missing`, removed from active matches, and a required/selected disappearance blocks the Candidate until a human resolves it. mtime, file size and first-result order never select an attempt.

## PNG to JPEG

`convertSelectedUpscale()` calls the non-destructive Sharp pipeline in `upscale.ts`:

- sRGB
- quality 95
- 4:4:4 chroma
- progressive JPEG
- `mozjpeg = false`
- `alphaPolicy = block` by default

The parameters are a **provisional default**, not a frozen quality standard. Actual alpha is checked; a transparent PNG blocks unless an explicit flatten policy is supplied. The output is written to `processed/` through a partial file, validated for JPEG format and dimensions, hashed, and then atomically installed. The input PNG stays in `upscale-output/`, and the Candidate records input/output hashes, sizes, reduction and parameters. The semantic role is explicitly `upscaled`; `_opt` is never the role identity.
