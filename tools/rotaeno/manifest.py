"""Semantic resource rows and a small manifest diff for Rotaeno."""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from typing import Any, Iterable

from .catalog import CatalogEntry, CatalogSnapshot


GUID_RE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)


def _path_key(entry: CatalogEntry) -> str | None:
    if entry.primary_key and (entry.primary_key.startswith("Assets/") or entry.primary_key.startswith("Rotaeno/")):
        return entry.primary_key.replace("\\", "/")
    for key in entry.keys:
        if key.startswith("Assets/") or key.startswith("Rotaeno/"):
            return key.replace("\\", "/")
    return None


def _stable_id(logical_key: str) -> str | None:
    parts = logical_key.replace("\\", "/").split("/")
    lowered = [part.lower() for part in parts]
    for marker in ("songs", "song", "packs"):
        if marker in lowered:
            index = lowered.index(marker)
            if index + 1 < len(parts):
                return parts[index + 1]
    if "character" in lowered:
        index = lowered.index("character")
        remaining = [part for part in parts[index + 1 :] if part and part.lower() not in {"_paid"}]
        if remaining:
            return "/".join(remaining[:2])
    if "events" in lowered:
        index = lowered.index("events")
        if index + 1 < len(parts):
            return parts[index + 1]
    return None


def classify_resource(logical_key: str, resource_types: Iterable[str]) -> tuple[str, str]:
    """Return ``semantic_type`` and confidence from catalog evidence only."""

    lower = logical_key.lower()
    types = {value.lower() for value in resource_types}
    is_image = any(value.endswith(("texture2d", "sprite", "spriteatlas")) for value in types)
    if "/songs/" in lower or "/song/" in lower:
        if "songinfohd" in lower or "songinfo-hd" in lower:
            return "song_jacket_thumbnail", "high"
        if "cover hd" in lower or "cover-hd" in lower or "coverhd" in lower:
            return "song_jacket", "high"
        if "song full" in lower or "song-full" in lower or "songfull" in lower:
            return "audio_full", "high"
        if "song preview" in lower or "song-preview" in lower or "songpreview" in lower:
            return "audio_preview", "high"
        if "chart" in lower or "beatmap" in lower:
            return "chart", "medium"
        if is_image:
            return "song_asset_unknown", "low"
    if "/packs/" in lower:
        if "banner" in lower or "back" in lower:
            return "song_pack_banner", "high"
        if "char" in lower or is_image:
            return "song_pack_artwork", "medium"
    if "/collectables/character/" in lower:
        if "portrait" in lower or "csprite" in lower:
            return "pilot_full_art", "high"
        return "pilot_asset", "medium"
    if "/collectables/background/" in lower:
        return "story_cg", "medium"
    if "/collectables/badge/" in lower or "/badge/" in lower:
        return "badge", "medium"
    if "/events/" in lower:
        if "background" in lower:
            return "event_background", "high"
        if "icon" in lower or "banner" in lower:
            return "event_banner", "high"
        return "event_artwork", "medium"
    if "/collectables/startup/" in lower or "/startup/" in lower:
        return "startup_art", "medium"
    if "avatar" in lower:
        return "avatar", "medium"
    if "/journey/" in lower:
        return "journey_artwork", "low"
    return "unknown", "unknown"


def _asset_guid(entry: CatalogEntry) -> str | None:
    for key in entry.keys:
        if GUID_RE.fullmatch(key):
            return key.lower()
    return None


def catalog_resources(snapshot: CatalogSnapshot, *, include_unknown: bool = False) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for entry in snapshot.entries:
        logical_key = _path_key(entry)
        if not logical_key or logical_key.lower().endswith(".bundle"):
            continue
        row = grouped.setdefault(
            logical_key,
            {
                "logical_key": logical_key,
                "catalog_keys": set(),
                "resource_types": set(),
                "entry_indexes": [],
                "source_bundle": None,
                "source_internal_id": entry.internal_id,
                "asset_guid": _asset_guid(entry),
            },
        )
        row["catalog_keys"].update(entry.keys)
        row["resource_types"].add(entry.resource_type_name)
        row["entry_indexes"].append(entry.entry_index)
        if row["source_bundle"] is None:
            row["source_bundle"] = snapshot.dependency_key(entry)
        if row["asset_guid"] is None:
            row["asset_guid"] = _asset_guid(entry)

    resources: list[dict[str, Any]] = []
    for row in grouped.values():
        semantic_type, confidence = classify_resource(row["logical_key"], row["resource_types"])
        if semantic_type == "unknown" and not include_unknown:
            continue
        resource = {
            "stable_id": _stable_id(row["logical_key"]),
            "semantic_type": semantic_type,
            "logical_key": row["logical_key"],
            "asset_guid": row["asset_guid"],
            "catalog_keys": sorted(row["catalog_keys"]),
            "resource_types": sorted(row["resource_types"]),
            "source_bundle": row["source_bundle"],
            "source_internal_id": row["source_internal_id"],
            "entry_indexes": sorted(row["entry_indexes"]),
            "confidence": confidence,
            "width": None,
            "height": None,
            "pixel_sha256": None,
            "export_file_sha256": None,
        }
        resources.append(resource)
    return sorted(resources, key=lambda value: (value["semantic_type"], value["stable_id"] or "", value["logical_key"]))


def _resource_id(resource: dict[str, Any]) -> tuple[str, str]:
    semantic_type = str(resource.get("semantic_type") or "unknown")
    stable_id = resource.get("stable_id") or resource.get("logical_key") or ""
    return semantic_type, str(stable_id)


def _fingerprint(resource: dict[str, Any]) -> str:
    fields = {
        key: resource.get(key)
        for key in (
            "stable_id",
            "semantic_type",
            "logical_key",
            "width",
            "height",
            "pixel_sha256",
            "title",
            "artist",
            "pack_id",
        )
    }
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def choose_highest_quality(candidates: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Choose a canonical image using dimensions before export-file hash."""

    values = list(candidates)
    if not values:
        return None
    return max(
        values,
        key=lambda value: (
            int(value.get("width") or 0) * int(value.get("height") or 0),
            int(value.get("width") or 0),
            str(value.get("pixel_sha256") or ""),
        ),
    )


def build_manifest(identity: dict[str, Any], snapshot: CatalogSnapshot, *, include_unknown: bool = False) -> dict[str, Any]:
    resources = catalog_resources(snapshot, include_unknown=include_unknown)
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for resource in resources:
        by_type[resource["semantic_type"]].append(resource)

    def ids(semantic_types: set[str]) -> list[dict[str, Any]]:
        return [
            {"id": resource["stable_id"], "resources": [resource["logical_key"]]}
            for resource in resources
            if resource["semantic_type"] in semantic_types and resource["stable_id"]
        ]

    return {
        "game": "rotaeno",
        "version": identity.get("version_name"),
        "channel": identity.get("channel"),
        "apk": {
            "package_name": identity.get("package_name"),
            "version_code": identity.get("version_code"),
            "sha256": identity.get("sha256"),
        },
        "catalog": snapshot.summary(),
        "songs": ids({"song_jacket", "song_jacket_thumbnail", "audio_full", "audio_preview"}),
        "packs": ids({"song_pack_banner", "song_pack_artwork"}),
        "pilots": ids({"pilot_full_art", "pilot_asset"}),
        "resources": resources,
        "resource_counts": {key: len(value) for key, value in sorted(by_type.items())},
        "notes": [
            "Catalog-only inspection does not invent title/artist/pack metadata.",
            "source_bundle is provenance; logical_key/asset_guid are the preferred stable references.",
        ],
    }


def diff_manifests(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    old_resources = {_resource_id(resource): resource for resource in old.get("resources", [])}
    new_resources = {_resource_id(resource): resource for resource in new.get("resources", [])}
    changes: list[dict[str, Any]] = []
    for key in sorted(set(old_resources) | set(new_resources)):
        old_resource = old_resources.get(key)
        new_resource = new_resources.get(key)
        if old_resource is None:
            status = "ADDED"
        elif new_resource is None:
            status = "REMOVED"
        elif "unknown" in key or old_resource.get("confidence") == "unknown" or new_resource.get("confidence") == "unknown":
            status = "UNKNOWN"
        elif _fingerprint(old_resource) != _fingerprint(new_resource):
            status = "MODIFIED"
        else:
            status = "UNCHANGED"
        changes.append({"status": status, "semantic_type": key[0], "stable_id": key[1], "old": old_resource, "new": new_resource})
    counts = {status: sum(change["status"] == status for change in changes) for status in ("ADDED", "MODIFIED", "UNCHANGED", "REMOVED", "UNKNOWN")}
    return {"game": "rotaeno", "old_version": old.get("version"), "new_version": new.get("version"), "counts": counts, "changes": changes}
