# Release evidence audit

Audit date: 2026-09-21
Catalog: `catalog/index.json`
Catalog release references: 32
Local ignored JSON manifests: 26

This table compares every Catalog `releaseManifestId` with the local ignored
history and the evidence that can be recovered without inventing a manifest.
“Local manifest only” means the JSON is parseable and has a historical
`status`, but it is not treated as proof of ROS, Git push, or Pages deploy.

## Stats registry gate repair

The first npm run stats:registry:check failed because the tracked generated
file did not byte-match the formal generator output on this Windows checkout.
Running npm run stats:registry produced the canonical output: 3,938 public
Resource IDs and 7 public game slugs. The normalized generated content had no
Catalog ID/resource/game semantic changes; no draft, tombstoned, hidden or
internal resource entered the registry. .gitattributes now pins this one
generated file to LF so a fresh Windows checkout cannot recreate the stale
line-ending failure. The final npm run ci:check is green.

| releaseManifestId | Catalog ref | Local file | game / version or batch | Git / temp evidence | confidence | handling |
| --- | --- | --- | --- | --- | --- | --- |
| `01a00097-2f0e-7225-a597-ab8b7e757859` | yes | yes | Arcaea `legacy → 6.16.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `01a00097-2f2e-7af5-83b5-a96c87c5237c` | yes | yes | Phigros `legacy → legacy` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `01a02934-803f-73aa-805e-24294eff90ee` | yes | yes | Arcaea `legacy → 6.16.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `501cd948-fe46-7a76-99ea-74b6a4e6f4f8` | yes | yes | Rizline `phase3.8 → 2.7.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `41cb120c-dc21-71ea-a558-1e707d395f09` | yes | no | game/version unresolved | old Catalog and candidate Catalog snapshots only; no manifest path/history | `UNKNOWN` | keep gap; do not fabricate |
| `60b3f222-61d8-77c1-a7e2-bf2d4e4e103f` | yes | yes | In Falsus `previous-catalog → In Falsus Demo` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `8864d684-0e1c-7b9d-b025-c4fb78842fd4` | yes | yes | Rotaeno `none → 2.26.1-full-images-v2` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `f26da1af-32e7-7af1-bf58-ba125df00a13` | yes | yes | Rotaeno `2.26.1-full-images-v2 → display-metadata-v1` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `dee4b36a-ea26-78c9-b511-038c264c1203` | yes | yes | Rotaeno `display-metadata-v1 → chart-metadata-v1` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `0e166057-6fe1-77b6-b0f4-aeeff2ef1716` | yes | yes | Rotaeno `chart-metadata-v1 → wiki-chart-metadata-v1` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `b1cbdd85-0635-7dc2-bfcb-133d9a4787d6` | yes | yes | Rotaeno `chart-metadata-v1 → wiki-song-metadata-v2` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `25abc367-c66b-7c26-8fab-79afc667c306` | yes | yes | Arcaea `6.16.8c → 7.0.0c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `1c175b9a-6461-7da1-b7c5-116eef642026` | yes | yes | Arcaea `6.16.8c → 7.0.0c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `062d9417-0f3a-7385-8f8c-e4efa118af44` | yes | yes | Arcaea `7.0.0c → 7.0.0c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `6840d0d3-318c-7fd8-874b-f3fa37fa5b66` | yes | yes | Arcaea `7.0.0c → 7.0.0c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `e5ae66e4-cbc2-702e-a76d-8d4d84727a72` | yes | yes | Rizline `phase3.8 → 2.7.1` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `f707b1c7-e0c9-73d8-bf1b-c154b85d08a7` | yes | yes | Arcaea `7.0.0c → 7.0.255c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `7eaf91a2-e7a8-78e8-8ca7-4dc59d79753b` | yes | yes | Arcaea `7.0.255c → 7.0.255c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `b41d15b2-a578-7f79-b208-42f5dd10dade` | yes | yes | Arcaea `7.0.255c → 7.0.255c` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `99cdf9b5-8b75-78ef-8a65-397fa412f193` | yes | yes | Paradigm: Reboot `onboarding → 4.10` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `7b1aabce-7755-714f-bbec-1103018e0231` | yes | yes | Paradigm: Reboot `4.10 → 4.10` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `5477873c-f4f8-737d-884c-21bcfded2d4d` | yes | yes | Paradigm: Reboot `4.10 → 4.10` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `c9e86b50-2127-7517-a466-70cb3842d0da` | yes | yes | Phigros `3.19.5 → 3.20.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `d9faf30c-222c-7f8a-9f1b-7d5706ecd039` | yes | no | Rizline `2.7.1 → v141 snapshot` | added in Git `3602e700`; deleted by boundary cleanup `0161fe6` | `RECOVERABLE` | recover only into private Admin history if needed |
| `39c231b8-9e10-7fb1-b2c8-44144b2c0b32` | yes | yes | In Falsus `previous-catalog → 1.0.3` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `ac893e45-07c0-7d36-8b28-11ce09abca7d` | yes | yes | Orzmic `none → 3.17.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `137bea80-fefe-7044-b0ff-34016d3589d3` | yes | no | Arcaea `7.0.255c → 7.0.260c` | Git `d4919fc5`; temp import plan is `READY_LOCAL_ONLY` | `RECOVERABLE` | recover privately; do not restore to public repo |
| `630ab030-8929-781f-800b-3c6d2deb0de1` | yes | no | Arcaea `7.0.255c → 7.0.260c` | Git `d4919fc5`; deleted by `0161fe6` | `RECOVERABLE` | recover privately if needed |
| `90233421-9dc3-7673-bebb-b859fc919015` | yes | no | Paradigm: Reboot `4.10 → 4.11` | Git `d4919fc5`; deleted by `0161fe6` | `RECOVERABLE` | recover privately if needed |
| `d6ff348b-2157-77b4-9376-506b0e6a3d37` | yes | no | Paradigm: Reboot `4.10 → 4.11` | Git `d4919fc5`; deleted by `0161fe6` | `RECOVERABLE` | recover privately if needed |
| `18c465a8-e90d-7f4e-bd8c-542c47e09287` | yes | yes | Rotaeno `2.26.1 → 2.27.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |
| `f14c77ba-213f-740a-99fc-1c4833fa9f29` | yes | yes | Rotaeno `2.27.0 → 2.27.0` | local manifest | `LEGACY_UNVERIFIED` | retain privately |

## Missing-ID conclusion

There are exactly six Catalog references without a local JSON file. Five have
an unambiguous historical file in Git and are therefore `RECOVERABLE`; they
are not restored to the website repository because release manifests are
private Admin evidence. `41cb120c-dc21-71ea-a558-1e707d395f09` appears in old
Catalog/candidate snapshots, but no game/version-specific manifest or external
publication evidence was found. It remains `UNKNOWN` and must not block a
read-only Admin shell.

Future Admin operations must create an operation/evidence record at each
stage. A future `published` label is never sufficient to infer ROS, GitHub,
or Pages completion.
