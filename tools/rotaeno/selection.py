"""Build the reviewed, non-event Rotaeno image selection.

The semantic catalog contains the complete song and pack image rows. Some
older collectable/startup rows resolve to numeric Addressables dependencies,
so those two families are completed from the APK bundle inventory. The
result is still only a selection file; extraction remains an explicit,
read-only adapter step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


SEMANTIC_TO_ASSET_TYPE = {
    "song_jacket": "jacket",
    "song_pack_banner": "pack-cover",
    "story_cg": "story-cg",
}


def _read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _bundle_path(value: str) -> str:
    normalized = value.replace("\\", "/").lstrip("/")
    if normalized.lower().startswith("assets/aa/android/"):
        return normalized
    return "assets/aa/Android/" + normalized


def _bundle_inventory(path: str | Path) -> list[str]:
    result: list[str] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            continue
        candidate = parts[1].replace("\\", "/")
        if candidate.lower().endswith(".bundle"):
            result.append(candidate)
    return sorted(set(result), key=str.casefold)


def _bundle_sizes(path: str | Path) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        candidate = parts[1].replace("\\", "/")
        if candidate.lower().endswith(".bundle"):
            result[candidate.casefold()] = int(parts[0])
    return result


def _safe_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or "\ufffd" in cleaned or any(ord(char) < 32 and char not in "\t\n" for char in cleaned):
        return None
    return cleaned


def _slug(value: str, fallback: str = "asset") -> str:
    result = re.sub(r"[\\/\0]+", "-", value.strip())
    result = re.sub(r"[^\w .()\-\u4e00-\u9fff]+", "-", result, flags=re.UNICODE)
    result = re.sub(r"\s+", " ", result).strip(" .-")
    return result[:120] or fallback


def _pretty(value: str, fallback: str = "Rotaeno asset") -> str:
    value = re.sub(r"_[0-9a-f]{32}\.bundle$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\.(?:asset|psd|png|prefab)$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"(?i)(?:character[_-])", "", value)
    value = re.sub(r"(?i)(?:default|portrait|csprite|sprite)$", "", value)
    value = value.replace("_", " ").replace("-", " ")
    value = re.sub(r"\s+", " ", value).strip()
    return value or fallback


def _logical_texture_name(logical_key: str) -> str | None:
    name = logical_key.replace("\\", "/").rsplit("/", 1)[-1]
    return name or None


def _bundle_texture_name(bundle: str) -> str | None:
    name = bundle.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"_[0-9a-f]{32}\.bundle$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"\.(?:asset|psd|png|prefab)$", "", name, flags=re.IGNORECASE)
    return name or None


def _canonical_bundle(bundle: str) -> str:
    return re.sub(r"_[0-9a-f]{32}\.bundle$", "", bundle, flags=re.IGNORECASE)


def _stable_suffix(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _selection_id(asset_type: str, source_identity: str) -> str:
    return f"{asset_type}-{_stable_suffix(source_identity)}"


def _base_entry(
    *,
    asset_type: str,
    source_identity: str,
    logical_key: str,
    bundle: str,
    title: str,
    version: str,
    metadata: dict[str, Any],
    download_filename: str,
    texture_name: str | None = None,
    asset_guid: str | None = None,
    artist: str | None = None,
    aliases: list[str] | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "selection_id": _selection_id(asset_type, source_identity),
        "asset_type": asset_type,
        "source_identity": source_identity,
        "logical_key": logical_key,
        "bundle": _bundle_path(bundle),
        "title": title,
        "download_filename": download_filename,
        "variant_key": "default",
        "metadata": {"gameVersion": version, **metadata},
    }
    if texture_name:
        entry["texture_name"] = texture_name
    if asset_guid:
        entry["asset_guid"] = asset_guid
    if artist:
        entry["artist"] = artist
    if aliases:
        entry["aliases"] = aliases
    return entry


def _path_relative(bundle: str, marker: str) -> str:
    lower = bundle.lower()
    index = lower.find(marker.lower())
    return bundle[index + len(marker):] if index >= 0 else bundle.rsplit("/", 1)[-1]


def _path_logical_key(bundle: str, family: str) -> str:
    relative = _path_relative(bundle, f"/_scriptableobjects/collectables/{family}/")
    return f"Rotaeno/Collectables/{family.title()}/{relative}"


def build_selection(
    *,
    manifest_path: str | Path,
    bundle_inventory_path: str | Path,
    song_inventory_path: str | Path,
    pack_inventory_path: str | Path,
    version: str = "2.26.1",
    channel: str = "mainland_cn",
) -> dict[str, Any]:
    semantic = _read_json(manifest_path)
    resources = semantic.get("resources", []) if isinstance(semantic, dict) else []
    songs = {str(item.get("id")): item for item in _read_json(song_inventory_path) if isinstance(item, dict) and item.get("id")}
    packs = {str(item.get("id")): item for item in _read_json(pack_inventory_path) if isinstance(item, dict) and item.get("id")}
    inventory = _bundle_inventory(bundle_inventory_path)
    bundle_sizes = _bundle_sizes(bundle_inventory_path)
    entries: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()

    for row in resources:
        semantic_type = str(row.get("semantic_type") or "")
        asset_type = SEMANTIC_TO_ASSET_TYPE.get(semantic_type)
        if not asset_type or not isinstance(row.get("source_bundle"), str):
            continue
        source_bundle = str(row["source_bundle"])
        stable_id = _safe_text(row.get("stable_id")) or _slug(str(row.get("logical_key") or "unknown"))
        asset_guid = _safe_text(row.get("asset_guid"))
        if semantic_type == "song_jacket":
            song = songs.get(stable_id, {})
            title = _safe_text(song.get("name_original")) or stable_id
            artist = _safe_text(song.get("artist"))
            metadata = {
                "semanticType": semantic_type,
                "songId": stable_id,
                "illustrator": _safe_text(song.get("illustrator")),
                "releaseVersion": _safe_text(song.get("release_version")),
                "sourceLogicalKey": row.get("logical_key"),
            }
            source_identity = f"song-jacket:{stable_id}:{asset_guid or _stable_suffix(str(row.get('logical_key') or ''))}"
            filename = f"Rotaeno - {title} [{stable_id}].png"
            aliases = [stable_id]
        elif semantic_type == "song_pack_banner":
            pack_id = stable_id
            pack = packs.get(pack_id, {})
            title = _safe_text(pack.get("name_term")) or pack_id
            metadata = {
                "semanticType": semantic_type,
                "packName": title,
                "packId": pack_id,
                "sourceLogicalKey": row.get("logical_key"),
            }
            source_identity = f"pack-cover:{pack_id}:{asset_guid or _stable_suffix(str(row.get('logical_key') or ''))}"
            filename = f"Rotaeno - Pack - {pack_id} - {asset_guid or _stable_suffix(source_identity)}.png"
            aliases = [pack_id]
            artist = None
        else:
            logical = str(row.get("logical_key") or "story-cg")
            title = _pretty(logical.rsplit("/", 1)[-1], "Rotaeno story CG")
            metadata = {
                "semanticType": semantic_type,
                "sourceLogicalKey": logical,
            }
            source_identity = f"story-cg:{asset_guid or _stable_suffix(logical)}"
            filename = f"Rotaeno - Story CG - {_slug(title)}.png"
            aliases = []
            artist = None
        entries.append(
            _base_entry(
                asset_type=asset_type,
                source_identity=source_identity,
                logical_key=str(row.get("logical_key") or source_identity),
                bundle=source_bundle,
                title=title,
                version=version,
                metadata=metadata,
                download_filename=filename,
                texture_name=_logical_texture_name(str(row.get("logical_key") or "")),
                asset_guid=asset_guid,
                artist=artist,
                aliases=aliases,
            )
        )
        counts[asset_type] += 1

    character_candidates = [
        bundle for bundle in inventory
        if "/_scriptableobjects/collectables/character/" in bundle.lower()
        and "eventportrait" not in bundle.lower()
        and "/events/" not in bundle.lower()
    ]
    character_bundles = [
        bundle for bundle in character_candidates
        if bundle_sizes.get(bundle.casefold(), 0) > 4096
    ]
    skipped_character_bundles = len(character_candidates) - len(character_bundles)
    for bundle in character_bundles:
        canonical = _canonical_bundle(bundle)
        relative = _path_relative(canonical, "/_scriptableobjects/collectables/character/")
        title = _pretty(relative.rsplit("/", 1)[-1], "Rotaeno driver")
        source_identity = f"character:{relative}"
        logical_key = _path_logical_key(canonical, "character")
        entries.append(
            _base_entry(
                asset_type="character-portrait",
                source_identity=source_identity,
                logical_key=logical_key,
                bundle=bundle,
                title=title,
                version=version,
                metadata={
                    "semanticType": "pilot_full_art",
                    "characterName": title,
                    "sourceBundle": bundle,
                },
                download_filename=f"Rotaeno - Driver - {_slug(title)}.png",
                texture_name=_bundle_texture_name(bundle),
                aliases=[title],
            )
        )
        counts["character-portrait"] += 1

    startup_bundles = [
        bundle for bundle in inventory
        if "/_scriptableobjects/collectables/startup/" in bundle.lower()
        and "/events/" not in bundle.lower()
        and "summer" not in bundle.lower()
        and "event" not in bundle.lower()
        and "startupenvironment" not in bundle.lower()
    ]
    for bundle in startup_bundles:
        canonical = _canonical_bundle(bundle)
        relative = _path_relative(canonical, "/_scriptableobjects/collectables/startup/")
        title = _pretty(relative.rsplit("/", 1)[-1], "Rotaeno startup visual")
        source_identity = f"startup:{relative}"
        logical_key = _path_logical_key(canonical, "startup")
        entries.append(
            _base_entry(
                asset_type="startup",
                source_identity=source_identity,
                logical_key=logical_key,
                bundle=bundle,
                title=title,
                version=version,
                metadata={
                    "semanticType": "startup_art",
                    "sourceBundle": bundle,
                },
                download_filename=f"Rotaeno - Startup - {_slug(title)}.png",
                texture_name=_bundle_texture_name(bundle),
                aliases=[title],
            )
        )
        counts["startup"] += 1

    selected_paths = {str(entry["bundle"]).casefold() for entry in entries}
    event_bundles = [bundle for bundle in inventory if "/_scriptableobjects/events/" in bundle.lower()]
    if any("/events/" in path or "eventportrait" in path for path in selected_paths):
        raise ValueError("event artwork leaked into the public Rotaeno selection")
    if len({entry["selection_id"] for entry in entries}) != len(entries):
        raise ValueError("Rotaeno selection contains duplicate selection IDs")

    return {
        "kind": "rotaeno-image-selection",
        "schema_version": "1",
        "game": "rotaeno",
        "selection_id": "rotaeno-mainland-cn-2.26.1-public-images",
        "source_version": version,
        "channel": channel,
        "scope": {
            "included": ["song jackets", "song pack covers", "character/driver art", "story CG", "startup/main visuals"],
            "excluded": ["event artwork", "journey map art", "badges", "audio", "charts"],
        },
        "entries": sorted(entries, key=lambda entry: (str(entry["asset_type"]), str(entry["source_identity"]))),
        "diagnostics": {
            "counts": dict(sorted(counts.items())),
            "total": len(entries),
            "excluded_event_bundles": len(event_bundles),
            "excluded_non_image_character_bundles": skipped_character_bundles,
            "selected_bundle_count": len(selected_paths),
        },
        "notes": [
            "Song and pack rows come from the APK Addressables semantic manifest.",
            "Character and startup rows come from the APK business bundle inventory when older dependency indexes are numeric.",
            "Event artwork is intentionally excluded from the public selection.",
            "APK and source bundle files remain read-only; this file is generated under temp/.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m tools.rotaeno.selection")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--bundle-inventory", required=True)
    parser.add_argument("--song-inventory", required=True)
    parser.add_argument("--pack-inventory", required=True)
    parser.add_argument("--version", default="2.26.1")
    parser.add_argument("--channel", default="mainland_cn")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = build_selection(
        manifest_path=args.manifest,
        bundle_inventory_path=args.bundle_inventory,
        song_inventory_path=args.song_inventory,
        pack_inventory_path=args.pack_inventory,
        version=args.version,
        channel=args.channel,
    )
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "game": result["game"],
        "version": result["source_version"],
        "selection_id": result["selection_id"],
        "counts": result["diagnostics"]["counts"],
        "total": result["diagnostics"]["total"],
        "excluded_event_bundles": result["diagnostics"]["excluded_event_bundles"],
        "output": str(output.resolve()),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
