# Paradigm: Reboot / 范式：起源

- Lifecycle: published through the shared jacket Resource route; one public song Resource is created for each client catalog song_id.
- Source and scope: the 4.10/D146 client catalog determines song existence, difficulty presence, cover/audio/preview/chart resources, and client BPM/timing facts. The two catalog band-variant covers remain attached to innernorm (chaotic) and lynn (override) and do not create songs.
- Public metadata: the cited [Paradigm: Reboot Wiki* all-song table](https://wikiwiki.jp/paradigm_/%E5%85%A8%E6%9B%B2%E3%82%BD%E3%83%BC%E3%83%88%E8%A1%A8) supplies formal title, composer, illustrator, genre, pack, length, chart level/constant, notes, and noter. A public song-id mapping snapshot is stored in catalog/curation/paradigm-reboot-song-metadata.json.
- Resource attachments: the verified full-song OGG, preview OGG, and original ParsaPara chart files remain Catalog facts attached to the owning song, but the public site exposes image downloads only. Chart presence and difficulty remain catalog facts; Wiki metadata never creates a missing chart.
- BPM provenance: client chart InitBeat values take precedence; the Wiki BPM is retained as a cross-check field. Client chart offsets and event-line counts remain provenance metadata.
- Jacket derivatives: each of the 421 client cover Variants has a reviewed Real-ESRGAN x4 JPEG rendition; the original PNG remains the companion download. The game-library icon is the client main-data `PRD OL Logo` texture at `apps/site/public/game-icons/paradigm-reboot.png`.
- Publication boundary: the local Catalog/ReleaseManifest is prepared without ROS/object-storage writes or production deployment. The extracted APK/data and private processing tool remain outside Git.
- Update strategy: reuse paradigm-reboot / paradigm_apk, compare the next inventory by song_id and resource hash, review NEW/CHANGED/REMOVED items, and preserve stable Resource/Variant/Object identities.
