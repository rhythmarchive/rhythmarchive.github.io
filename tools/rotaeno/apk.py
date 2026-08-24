"""Read-only APK identity and resource-container inspection."""

from __future__ import annotations

import hashlib
import json
import re
import struct
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any


def _read7(data: bytes, position: int) -> tuple[int, int]:
    value = data[position]
    position += 1
    if value & 0x80:
        value = ((value & 0x7F) << 7) | (data[position] & 0x7F)
        position += 1
    return value, position


def _pool(data: bytes, offset: int) -> tuple[list[int], int, int]:
    count, _styles, flags, strings_start, _style_start = struct.unpack_from("<5I", data, offset + 8)
    offsets = [struct.unpack_from("<I", data, offset + 28 + index * 4)[0] for index in range(count)]
    return offsets, offset + strings_start, flags


def _string(data: bytes, offsets: list[int], start: int, flags: int, index: int) -> str | None:
    if index < 0 or index >= len(offsets):
        return None
    position = start + offsets[index]
    if flags & 0x100:
        _chars, position = _read7(data, position)
        length, position = _read7(data, position)
        return data[position : position + length].decode("utf-8", "replace")
    length = struct.unpack_from("<H", data, position)[0]
    position += 2
    if length & 0x8000:
        length = ((length & 0x7FFF) << 16) | struct.unpack_from("<H", data, position)[0]
        position += 2
    return data[position : position + length * 2].decode("utf-16-le", "replace")


def parse_binary_manifest(data: bytes) -> dict[str, Any]:
    """Read package/version/sdk fields from Android binary XML."""

    offsets: list[int] = []
    string_start = 0
    flags = 0
    position = 8
    while position + 8 <= len(data):
        chunk_type, header_size, chunk_size = struct.unpack_from("<HHI", data, position)
        if chunk_size < header_size or position + chunk_size > len(data):
            break
        if chunk_type == 0x0001:
            offsets, string_start, flags = _pool(data, position)
            break
        position += chunk_size
    if not offsets:
        return {"parse_status": "no_string_pool"}

    result: dict[str, Any] = {"parse_status": "ok"}
    position = 8
    while position + 8 <= len(data):
        chunk_type, header_size, chunk_size = struct.unpack_from("<HHI", data, position)
        if chunk_size < header_size or position + chunk_size > len(data):
            break
        if chunk_type == 0x0102 and header_size >= 0x10:
            name_index = struct.unpack_from("<I", data, position + 20)[0]
            element = _string(data, offsets, string_start, flags, name_index)
            attribute_start, attribute_size, attribute_count = struct.unpack_from("<HHH", data, position + 24)
            attributes: dict[str, Any] = {}
            # attributeStart is relative to the end of the common node header.
            attributes_offset = position + header_size + attribute_start
            for index in range(attribute_count):
                attr = attributes_offset + index * attribute_size
                if attr + 20 > position + chunk_size:
                    break
                attr_name_index, raw_value_index = struct.unpack_from("<II", data, attr + 4)
                value_type = data[attr + 15]
                value_data = struct.unpack_from("<I", data, attr + 16)[0]
                attr_name = _string(data, offsets, string_start, flags, attr_name_index)
                if not attr_name:
                    continue
                raw_value = _string(data, offsets, string_start, flags, raw_value_index)
                if raw_value is not None:
                    value: Any = raw_value
                elif value_type == 0x10:
                    value = value_data
                elif value_type == 0x12:
                    value = bool(value_data)
                elif value_type == 0x03:
                    value = _string(data, offsets, string_start, flags, value_data)
                else:
                    value = value_data
                attributes[attr_name] = value
            if element == "manifest":
                result.update(package_name=attributes.get("package"), version_name=attributes.get("versionName"), version_code=attributes.get("versionCode"))
            elif element == "uses-sdk":
                result.update(min_sdk=attributes.get("minSdkVersion"), target_sdk=attributes.get("targetSdkVersion"))
        position += chunk_size
    return result


def _inventory(infos: list[zipfile.ZipInfo]) -> dict[str, Any]:
    counts = Counter(Path(info.filename).suffix.lower() or "<none>" for info in infos)
    sizes: Counter[str] = Counter()
    tops: dict[str, dict[str, int]] = {}
    for info in infos:
        extension = Path(info.filename).suffix.lower() or "<none>"
        sizes[extension] += info.file_size
        top = info.filename.split("/", 1)[0]
        row = tops.setdefault(top, {"files": 0, "compressed_size": 0, "uncompressed_size": 0})
        row["files"] += 1
        row["compressed_size"] += info.compress_size
        row["uncompressed_size"] += info.file_size
    return {
        "file_count": len(infos),
        "compressed_total": sum(info.compress_size for info in infos),
        "uncompressed_total": sum(info.file_size for info in infos),
        "top_levels": dict(sorted(tops.items())),
        "extensions": {key: {"files": counts[key], "uncompressed_size": sizes[key]} for key in sorted(counts)},
    }


def inspect_apk(apk_path: str | Path) -> dict[str, Any]:
    path = Path(apk_path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = {info.filename for info in infos}
        manifest_bytes = archive.read("AndroidManifest.xml") if "AndroidManifest.xml" in names else b""
        manifest = parse_binary_manifest(manifest_bytes) if manifest_bytes else {}
        try:
            xd_config = json.loads(archive.read("assets/XDConfig.json"))
        except (KeyError, json.JSONDecodeError):
            xd_config = {}
        try:
            settings = json.loads(archive.read("assets/aa/settings.json"))
        except (KeyError, json.JSONDecodeError):
            settings = {}
        unity_version = None
        if "assets/bin/Data/data.unity3d" in names:
            match = re.search(rb"20\d\d\.\d+\.\d+[a-z]\d+[a-z0-9]*", archive.read("assets/bin/Data/data.unity3d")[:256])
            unity_version = match.group(0).decode("ascii", "replace") if match else None
        catalog_path = "assets/aa/catalog.json"
        catalog_sha = None
        catalog_size = None
        if catalog_path in names:
            catalog_bytes = archive.read(catalog_path)
            catalog_sha = hashlib.sha256(catalog_bytes).hexdigest()
            catalog_size = len(catalog_bytes)
        region = xd_config.get("region_type")
        channel = {"CN": "mainland_cn", "GLOBAL": "global"}.get(str(region).upper(), "unknown") if region else "unknown"
        abis = sorted({name.split("/")[1] for name in names if name.startswith("lib/") and name.count("/") >= 2})
        return {
            "apk": str(path.resolve()),
            "size": path.stat().st_size,
            "sha256": digest.hexdigest(),
            "package_name": manifest.get("package_name"),
            "version_name": manifest.get("version_name") or xd_config.get("tapsdk", {}).get("db_config", {}).get("game_version"),
            "version_code": manifest.get("version_code"),
            "min_sdk": manifest.get("min_sdk"),
            "target_sdk": manifest.get("target_sdk"),
            "channel": channel,
            "channel_evidence": {"region_type": region, "custom_scheme_present": b"rotaenocn" in manifest_bytes, "xd_config_present": bool(xd_config)},
            "unity_version": unity_version,
            "scripting_backend": "IL2CPP" if any(name.endswith("/libil2cpp.so") for name in names) else "unknown",
            "abi": abis,
            "signature_entries": sorted(name for name in names if name.startswith("META-INF/") and Path(name).suffix.lower() in {".rsa", ".dsa", ".ec"}),
            "addressables": {
                "settings_present": bool(settings),
                "version": settings.get("m_AddressablesVersion"),
                "catalog_path": settings.get("m_CatalogLocations", [{}])[0].get("m_InternalId", catalog_path) if settings.get("m_CatalogLocations") else catalog_path,
                "catalog_present": catalog_path in names,
                "catalog_sha256": catalog_sha,
                "catalog_size": catalog_size,
                "remote_catalog_update_enabled": settings.get("m_DisableCatalogUpdateOnStart") is False if settings else None,
            },
            "bundle_count": sum(name.startswith("assets/aa/Android/") and name.endswith(".bundle") for name in names),
            "inventory": _inventory(infos),
            "important_entries": {
                "global_metadata": "assets/bin/Data/il2cpp_data/Metadata/global-metadata.dat" in names,
                "resources_resource": "assets/bin/Data/resources.resource" in names,
                "catalog": catalog_path in names,
                "addressables_settings": "assets/aa/settings.json" in names,
            },
        }
