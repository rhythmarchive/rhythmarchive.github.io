"""Conservative static Texture2D extraction for Paradigm: Reboot.

The game keeps song artwork and other downloadable content behind encrypted
Addressables/hotasset endpoints.  This adapter therefore limits the initial
public candidate set to named image families embedded in the APK's Unity
player data: character avatars, shop pack banners, and background art.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import zipfile
from typing import Any, Iterable

import UnityPy


GAME_ID = "paradigm-reboot"
MANIFEST_SCHEMA = "paradigm.reboot.static-manifest.v1"
DATA_PREFIX = "assets/bin/Data/"
AVATAR = "character-avatar"
PACK_COVER = "pack-cover"
BACKGROUND = "background"

_AVATAR_RE = re.compile(r"(?:头像|avatar)", re.IGNORECASE)
_PACK_RE = re.compile(r"(?:曲包|横幅|商店|banner|pack|album)", re.IGNORECASE)
_BACKGROUND_RE = re.compile(r"(?:背景|background|场景|scene)", re.IGNORECASE)
_BACKGROUND_UI_RE = re.compile(
    r"(?:元素|蒙版|阴影|外框|底板|按钮|列表|选定|备选|价格|小三角|缩略图|展示中角色|发光|头像框|角色贴图|框$)",
    re.IGNORECASE,
)
_INVALID_FILENAME_RE = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')


def classify_texture(name: str, width: int, height: int) -> str | None:
    """Return a publishable family using name and dimension evidence only."""

    normalized = name.strip()
    if not normalized or width <= 0 or height <= 0:
        return None
    if width == 256 and height == 256 and _AVATAR_RE.search(normalized) and "头像框" not in normalized:
        return AVATAR
    if width == 1639 and height == 268 and _PACK_RE.search(normalized):
        return PACK_COVER
    if width >= 1024 and height >= 576 and _BACKGROUND_RE.search(normalized) and not _BACKGROUND_UI_RE.search(normalized):
        return BACKGROUND
    return None


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _apk_snapshot(apk: Path, version: str) -> tuple[str, str, str]:
    sha256 = _sha256_file(apk)
    modified = datetime.fromtimestamp(apk.stat().st_mtime, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return sha256, f"paradigm-apk:{version}:{sha256}", modified


def _require_temp_output(output: Path) -> Path:
    repo_root = Path.cwd().resolve()
    temp_root = (repo_root / "temp").resolve()
    resolved = output.expanduser().resolve()
    try:
        resolved.relative_to(temp_root)
    except ValueError as exc:
        raise ValueError(f"output must stay inside repository temp/: {resolved}") from exc
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def _extract_player_data(apk: Path, output: Path) -> Path:
    data_dir = output / "cache" / "main-data" / "assets" / "bin" / "Data"
    data_dir.mkdir(parents=True, exist_ok=True)
    extracted = 0
    with zipfile.ZipFile(apk) as archive:
        for info in archive.infolist():
            name = info.filename.replace("\\", "/")
            if not name.startswith(DATA_PREFIX) or name.endswith("/"):
                continue
            relative = name[len(DATA_PREFIX):]
            if not relative or "/" in relative or relative in {".", ".."}:
                continue
            destination = data_dir / relative
            with archive.open(info) as source, destination.open("wb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            extracted += 1
    data_path = data_dir / "data.unity3d"
    if extracted == 0 or not data_path.is_file():
        raise RuntimeError("APK does not contain assets/bin/Data/data.unity3d")
    return data_path


def _iter_texture_objects(environment: Any) -> Iterable[tuple[Any, Any, str, int, int, str]]:
    for obj in environment.objects:
        if obj.type.name != "Texture2D":
            continue
        try:
            data = obj.read()
            name = str(getattr(data, "m_Name", "") or "").strip()
            width = int(getattr(data, "m_Width", 0) or 0)
            height = int(getattr(data, "m_Height", 0) or 0)
            asset_file = str(getattr(obj.assets_file, "name", "") or "")
        except Exception:
            continue
        yield obj, data, name, width, height, asset_file


def _safe_filename(category: str, name: str, asset_file: str, path_id: int) -> str:
    category_label = {
        AVATAR: "avatar",
        PACK_COVER: "pack-cover",
        BACKGROUND: "background",
    }[category]
    clean_name = _INVALID_FILENAME_RE.sub("_", name).strip(" .") or "unnamed"
    clean_name = re.sub(r"\s+", " ", clean_name)[:120].rstrip(" .") or "unnamed"
    clean_asset = _INVALID_FILENAME_RE.sub("_", Path(asset_file).stem).strip(" .") or "assets"
    return f"Paradigm - {category_label} - {clean_name} - {clean_asset}-{path_id}.png"


def _repo_relative(path: Path) -> str:
    return path.resolve().relative_to(Path.cwd().resolve()).as_posix()


def _texture_record(
    *,
    obj: Any,
    data: Any,
    category: str,
    name: str,
    width: int,
    height: int,
    asset_file: str,
    output: Path,
) -> dict[str, Any]:
    image = data.image.convert("RGBA")
    if image.getbbox() is None:
        raise ValueError("decoded image is fully transparent")
    path_id = int(obj.path_id)
    source_identity = f"paradigm:texture:{asset_file}:{path_id}"
    logical_key = f"Paradigm/Unity/{asset_file}/{name}#{path_id}"
    filename = _safe_filename(category, name, asset_file, path_id)
    destination = output / "exports" / category / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=False, compress_level=6)
    encoded = destination.read_bytes()
    decoded = image.tobytes()
    return {
        "asset_family": category,
        "source_identity": source_identity,
        "semantic_id": source_identity,
        "logical_key": logical_key,
        "object_name": name,
        "asset_file": asset_file,
        "object_path_id": str(path_id),
        "title": name,
        "aliases": [name],
        "variant": "default",
        "resolved_variant": "default",
        "export_path": _repo_relative(destination),
        "download_filename": filename,
        "decoded_sha256": _sha256_bytes(encoded),
        "sha256": _sha256_bytes(encoded),
        "pixel_sha256": _sha256_bytes(decoded),
        "size_bytes": len(encoded),
        "width": int(image.width),
        "height": int(image.height),
        "mime": "image/png",
        "parse_status": "SUCCESS",
        "review_status": "EXTRACTED",
    }


def extract_apk(apk_path: str | Path, version: str, output_dir: str | Path) -> dict[str, Any]:
    apk = Path(apk_path).expanduser().resolve()
    if not apk.is_file():
        raise FileNotFoundError(f"APK is not a file: {apk}")
    output = _require_temp_output(Path(output_dir))
    apk_sha256, source_snapshot, generated_at = _apk_snapshot(apk, version)
    data_path = _extract_player_data(apk, output)
    environment = UnityPy.load(str(data_path))

    records: list[dict[str, Any]] = []
    classified = Counter()
    failures: list[dict[str, str]] = []
    skipped = Counter()
    for obj, data, name, width, height, asset_file in _iter_texture_objects(environment):
        category = classify_texture(name, width, height)
        if category is None:
            continue
        classified[category] += 1
        identity = f"{asset_file}:{obj.path_id}"
        try:
            records.append(_texture_record(obj=obj, data=data, category=category, name=name, width=width, height=height, asset_file=asset_file, output=output))
        except Exception as exc:
            failures.append({"identity": identity, "name": name, "category": category, "error": str(exc)})

    records.sort(key=lambda value: value["source_identity"])
    if not records:
        raise RuntimeError("no publishable static Texture2D candidates were decoded")
    manifest = {
        "schema_version": MANIFEST_SCHEMA,
        "game": GAME_ID,
        "version": version,
        "generated_at": generated_at,
        "source_snapshot": source_snapshot,
        "source_sha256": apk_sha256,
        "source": {
            "apk_filename": apk.name,
            "apk_sha256": apk_sha256,
            "unity_data": _repo_relative(data_path),
            "unitypy_version": getattr(UnityPy, "__version__", "unknown"),
        },
        "assets": records,
        "diagnostics": {
            "texture_count": sum(1 for obj in environment.objects if obj.type.name == "Texture2D"),
            "classified": dict(sorted(classified.items())),
            "extracted": len(records),
            "failed": len(failures),
            "failures": failures,
            "skipped": dict(sorted(skipped.items())),
        },
        "notes": [
            "Initial scope is limited to named static Unity image families: character avatars, shop pack banners, and backgrounds.",
            "The embedded Addressables catalog contains encrypted/dynamic hotasset paths without locally verifiable song jacket payloads; dynamic song artwork, audio, and charts remain excluded.",
            "All exported PNGs and Unity cache files are temporary review artifacts under repository temp/.",
        ],
    }
    manifest_path = output / "paradigm-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tools.paradigm")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract = subparsers.add_parser("extract", help="extract the approved static image families from an APK")
    extract.add_argument("--apk", required=True, help="read-only APK path")
    extract.add_argument("--version", required=True)
    extract.add_argument("--output", required=True, help="temporary output directory")
    args = parser.parse_args(argv)
    if args.command != "extract":
        parser.error("unknown command")
    try:
        manifest = extract_apk(args.apk, args.version, args.output)
    except Exception as exc:
        print(json.dumps({"status": "BLOCKED", "game": GAME_ID, "message": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    diagnostics = manifest["diagnostics"]
    print(json.dumps({
        "status": "OK" if diagnostics["failed"] == 0 else "BLOCKED",
        "game": GAME_ID,
        "version": manifest["version"],
        "source_snapshot": manifest["source_snapshot"],
        "classified": diagnostics["classified"],
        "extracted": diagnostics["extracted"],
        "failed": diagnostics["failed"],
        "manifest": str((Path(args.output) / "paradigm-manifest.json").resolve()),
    }, ensure_ascii=False, indent=2))
    return 0 if diagnostics["failed"] == 0 else 2
