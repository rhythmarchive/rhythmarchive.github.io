"""Read-only image extraction for a curated Rotaeno APK selection.

The Addressables catalog gives us stable logical keys and bundle provenance,
but it does not turn a Unity Texture2D into a public file. This module keeps
that conversion explicit: callers provide a selection file, every selected
bundle is read from the APK, and the result is written to the caller's output
directory.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_name(value: str, fallback: str = "rotaeno-asset") -> str:
    normalized = re.sub(r"[\\/\0]+", "-", value.strip())
    normalized = re.sub(r"[^\w .()\u4e00-\u9fff-]+", "-", normalized, flags=re.UNICODE)
    normalized = re.sub(r"\s+", " ", normalized).strip(" .-")
    return normalized[:160] or fallback


def _portable_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return resolved.name


def _bundle_path(value: str) -> str:
    normalized = value.replace("\\", "/").lstrip("/")
    if normalized.lower().startswith("assets/aa/android/"):
        return normalized
    return "assets/aa/Android/" + normalized


def _record_selection(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, dict) or not isinstance(value.get("entries"), list):
        raise ValueError("selection must be an object with an entries array")
    entries: list[dict[str, Any]] = []
    for index, item in enumerate(value["entries"]):
        if not isinstance(item, dict):
            raise ValueError(f"selection entry {index} must be an object")
        required = ("selection_id", "asset_type", "source_identity", "logical_key", "bundle")
        missing = [key for key in required if not isinstance(item.get(key), str) or not item[key].strip()]
        if missing:
            raise ValueError(f"selection entry {index} is missing: {', '.join(missing)}")
        entries.append(item)
    if not entries:
        raise ValueError("selection contains no entries")
    return entries


def _texture_candidates(bundle: bytes) -> list[tuple[str, Any, Any]]:
    try:
        import UnityPy  # type: ignore[import-not-found]
    except ImportError as error:  # pragma: no cover - depends on the local extraction runtime
        raise RuntimeError("UnityPy is required for Rotaeno image extraction") from error

    environment = UnityPy.load(io.BytesIO(bundle))
    candidates: list[tuple[str, Any, Any]] = []
    for obj in environment.objects:
        if getattr(obj.type, "name", str(obj.type)) != "Texture2D":
            continue
        try:
            texture = obj.read()
            image = getattr(texture, "image", None)
            if image is None:
                continue
            name = str(getattr(texture, "m_Name", "") or "")
            candidates.append((name, texture, image))
        except Exception:
            continue
    return candidates


def _choose_texture(candidates: list[tuple[str, Any, Any]], selection: dict[str, Any]) -> tuple[str, Any]:
    if not candidates:
        raise ValueError("bundle contains no readable Texture2D")
    wanted = str(selection.get("texture_name") or "").strip().casefold()
    if wanted:
        exact = [candidate for candidate in candidates if candidate[0].casefold() == wanted]
        if exact:
            return exact[0][0], exact[0][2]
        partial = [candidate for candidate in candidates if wanted in candidate[0].casefold()]
        if partial:
            return partial[0][0], partial[0][2]
    selected = max(candidates, key=lambda candidate: (candidate[2].width * candidate[2].height, candidate[2].width, candidate[0]))
    return selected[0], selected[2]


def _metadata(selection: dict[str, Any]) -> dict[str, Any]:
    value = selection.get("metadata", {})
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items() if item is None or isinstance(item, (str, int, float, bool, list, dict))}


def extract_images(apk_path: str | Path, selection_path: str | Path, output_dir: str | Path) -> dict[str, Any]:
    """Extract selected Texture2D assets from an APK into PNG files."""

    apk = Path(apk_path)
    selection_file = Path(selection_path)
    output = Path(output_dir)
    selection = json.loads(selection_file.read_text(encoding="utf-8"))
    entries = _record_selection(selection)
    output.mkdir(parents=True, exist_ok=True)
    canonical = output / "canonical"
    canonical.mkdir(parents=True, exist_ok=True)

    apk_digest = hashlib.sha256()
    with apk.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            apk_digest.update(block)
    apk_sha256 = apk_digest.hexdigest()

    assets: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    used_names: set[str] = set()
    with zipfile.ZipFile(apk) as archive:
        bundle_names = {info.filename.casefold(): info.filename for info in archive.infolist()}
        for selection_entry in entries:
            selection_id = str(selection_entry["selection_id"])
            requested_bundle = _bundle_path(str(selection_entry["bundle"]))
            archive_name = bundle_names.get(requested_bundle.casefold())
            if not archive_name:
                failures.append({"selection_id": selection_id, "reason": f"bundle not found: {requested_bundle}"})
                continue
            try:
                bundle_bytes = archive.read(archive_name)
                texture_name, image = _choose_texture(_texture_candidates(bundle_bytes), selection_entry)
                rgba = image.convert("RGBA")
                title = str(selection_entry.get("title") or selection_entry.get("source_identity") or selection_id)
                requested_name = str(selection_entry.get("download_filename") or f"{title}.png")
                stem = _safe_name(Path(requested_name).stem, _safe_name(selection_id))
                filename = f"{stem}.png"
                suffix = 2
                while filename.casefold() in used_names or (canonical / filename).exists():
                    filename = f"{stem}-{suffix}.png"
                    suffix += 1
                used_names.add(filename.casefold())
                export_file = canonical / filename
                with export_file.open("wb") as stream:
                    rgba.save(stream, format="PNG")
                exported = export_file.read_bytes()
                record: dict[str, Any] = {
                    "selection_id": selection_id,
                    "asset_type": str(selection_entry["asset_type"]),
                    "asset_family": str(selection_entry["asset_type"]),
                    "source_identity": str(selection_entry["source_identity"]),
                    "logical_key": str(selection_entry["logical_key"]),
                    "asset_guid": selection_entry.get("asset_guid"),
                    "source_bundle": requested_bundle,
                    "bundle_sha256": _sha256(bundle_bytes),
                    "texture_name": texture_name,
                    "export_path": _portable_path(export_file),
                    "download_filename": filename,
                    "sha256": _sha256(exported),
                    "decoded_sha256": _sha256(exported),
                    "pixel_sha256": _sha256(rgba.tobytes()),
                    "size_bytes": len(exported),
                    "width": int(rgba.width),
                    "height": int(rgba.height),
                    "mime": "image/png",
                    "title": selection_entry.get("title"),
                    "artist": selection_entry.get("artist"),
                    "aliases": selection_entry.get("aliases", []),
                    "variant": selection_entry.get("variant_key", "default"),
                    "resolved_variant": selection_entry.get("variant_key", "default"),
                    "metadata": _metadata(selection_entry),
                    "parse_status": "SUCCESS",
                    "review_status": "EXTRACTED",
                }
                assets.append({key: value for key, value in record.items() if value is not None})
            except Exception as error:
                failures.append({"selection_id": selection_id, "reason": str(error)})

    version = str(selection.get("source_version") or "unknown")
    channel = str(selection.get("channel") or "unknown")
    manifest = {
        "kind": "rotaeno-image-manifest",
        "schema_version": "1",
        "game": "rotaeno",
        "version": version,
        "channel": channel,
        "source_snapshot": f"rotaeno:{channel}:{version}:{apk_sha256}",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "apk": {"filename": apk.name, "path": str(apk.resolve()), "sha256": apk_sha256, "size_bytes": apk.stat().st_size},
        "selection": {"path": str(selection_file.resolve()), "selection_id": selection.get("selection_id"), "requested": len(entries)},
        "assets": sorted(assets, key=lambda item: str(item["source_identity"])),
        "diagnostics": {"requested": len(entries), "extracted": len(assets), "failed": len(failures), "failures": failures},
        "notes": [
            "Only explicitly selected catalog rows were extracted.",
            "The APK and its bundles were read without modification.",
            "Source bundle and logical key are provenance; source identity is the stable publication key.",
        ],
    }
    _write_json(output / "rotaeno-image-manifest.json", manifest)
    return manifest


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
