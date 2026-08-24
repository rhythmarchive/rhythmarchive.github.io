"""APK Addressables catalog reader and Rizline semantic-key resolver.

This is intentionally limited to the serialized Addressables catalog format
used by the verified Rizline 2.7.0 APK.  It does not contact a remote catalog
and it never treats a runtime catalog as the version source.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import struct
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

from .model import BundleRequirement, GameVersion, LogicalAsset


SUPPORTED_FAMILIES = {
    "illustration": "SUPPORTED",
    "seriesPoster": "SUPPORTED",
    "seriesBanner": "SUPPORTED",
    "avatar.npc": "SUPPORTED",
    "rizcard": "PARTIAL",
    "layout": "DISCOVERED",
    "banner": "PARTIAL",
    "altIllustration": "DISCOVERED",
}

PUBLICATION_CANDIDATES = {
    "illustration": "HIGH",
    "seriesPoster": "HIGH",
    "seriesBanner": "HIGH",
    "avatar.npc": "MEDIUM",
    "rizcard": "MEDIUM",
    "layout": "MEDIUM",
    "banner": "MEDIUM",
    "altIllustration": "HIGH",
}


@dataclass(frozen=True)
class CatalogEntry:
    entry_index: int
    internal_id: str | None
    provider: str | None
    dependency_key_index: int
    dependency_hash: int
    data_index: int
    primary_key: str | None
    resource_type: Any
    keys: tuple[str, ...]
    extra: Any

    @property
    def resource_type_name(self) -> str:
        return resource_type_name(self.resource_type)


@dataclass(frozen=True)
class CatalogSnapshot:
    raw: dict[str, Any]
    key_names: tuple[str, ...]
    key_entries: tuple[tuple[int, ...], ...]
    entries: tuple[CatalogEntry, ...]
    source_path: str | None = None
    catalog_role: str = "version_source"

    @property
    def build_hash(self) -> str | None:
        value = self.raw.get("m_BuildResultHash")
        return str(value) if value is not None else None

    @property
    def locator_id(self) -> str | None:
        value = self.raw.get("m_LocatorId")
        return str(value) if value is not None else None

    def summary(self) -> dict[str, Any]:
        return {
            "source_path": self.source_path,
            "catalog_role": self.catalog_role,
            "locator_id": self.locator_id,
            "build_result_hash": self.build_hash,
            "logical_key_count": len(self.key_names),
            "internal_id_count": len(self.raw.get("m_InternalIds", [])),
            "provider_count": len(self.raw.get("m_ProviderIds", [])),
            "entry_count": len(self.entries),
        }


@dataclass(frozen=True)
class CatalogResolution:
    asset: LogicalAsset
    asset_entries: tuple[CatalogEntry, ...]
    bundle_candidates: tuple[BundleRequirement, ...] = ()
    primary_bundle_status: str = "UNRESOLVED"
    container_candidates: tuple[BundleRequirement, ...] = ()


def _read_i32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<i", data, offset)[0]


def _read_u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _read_catalog_object(data: bytes, offset: int) -> Any:
    kind = data[offset]
    position = offset + 1
    if kind in (0, 1):
        length = _read_i32(data, position)
        raw = data[position + 4 : position + 4 + length]
        return raw.decode("ascii" if kind == 0 else "utf-16-le", "replace")
    if kind == 2:
        return struct.unpack_from("<H", data, position)[0]
    if kind == 3:
        return _read_u32(data, position)
    if kind == 4:
        return _read_i32(data, position)
    if kind in (5, 6):
        length = data[position]
        return data[position + 1 : position + 1 + length].decode("ascii", "replace")
    if kind == 7:
        assembly_length = data[position]
        position += 1
        assembly = data[position : position + assembly_length].decode("ascii", "replace")
        position += assembly_length
        class_length = data[position]
        position += 1
        class_name = data[position : position + class_length].decode("ascii", "replace")
        position += class_length
        json_length = _read_i32(data, position)
        position += 4
        text = data[position : position + json_length].decode("utf-16-le", "replace")
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            value = text
        return {"__type__": f"{assembly}|{class_name}", "value": value}
    return {"__unknown_type__": kind}


def decode_catalog_bytes(raw: bytes, *, source_path: str | None = None, catalog_role: str = "version_source") -> CatalogSnapshot:
    catalog = json.loads(raw)
    key_data = base64.b64decode(catalog["m_KeyDataString"])
    bucket_data = base64.b64decode(catalog["m_BucketDataString"])
    entry_data = base64.b64decode(catalog["m_EntryDataString"])
    extra_data = base64.b64decode(catalog["m_ExtraDataString"])

    key_count = _read_i32(key_data, 0)
    bucket_count = _read_i32(bucket_data, 0)
    if key_count != bucket_count:
        raise ValueError(f"Addressables key/bucket count mismatch: {key_count} != {bucket_count}")

    key_names: list[str] = []
    key_entries: list[tuple[int, ...]] = []
    position = 4
    for _ in range(key_count):
        key_offset = _read_i32(bucket_data, position)
        position += 4
        entry_count = _read_i32(bucket_data, position)
        position += 4
        indexes = tuple(_read_i32(bucket_data, position + index * 4) for index in range(entry_count))
        position += entry_count * 4
        key_names.append(str(_read_catalog_object(key_data, key_offset)))
        key_entries.append(indexes)

    entry_count = _read_i32(entry_data, 0)
    entries: list[CatalogEntry] = []
    position = 4
    for entry_index in range(entry_count):
        values = struct.unpack_from("<7i", entry_data, position)
        position += 28
        internal_id_index, provider_index, dependency_key_index, dependency_hash, data_index, primary_key_index, resource_type_index = values
        extra = None if data_index < 0 else _read_catalog_object(extra_data, data_index)
        internal_ids = catalog.get("m_InternalIds", [])
        providers = catalog.get("m_ProviderIds", [])
        resource_types = catalog.get("m_resourceTypes", [])
        entries.append(
            CatalogEntry(
                entry_index=entry_index,
                internal_id=str(internal_ids[internal_id_index]) if 0 <= internal_id_index < len(internal_ids) else None,
                provider=str(providers[provider_index]) if 0 <= provider_index < len(providers) else None,
                dependency_key_index=dependency_key_index,
                dependency_hash=dependency_hash,
                data_index=data_index,
                primary_key=key_names[primary_key_index] if 0 <= primary_key_index < len(key_names) else None,
                resource_type=resource_types[resource_type_index] if 0 <= resource_type_index < len(resource_types) else None,
                keys=(),
                extra=extra,
            )
        )

    key_memberships: list[list[str]] = [[] for _ in entries]
    for key_index, locations in enumerate(key_entries):
        for entry_index in locations:
            if 0 <= entry_index < len(entries):
                key_memberships[entry_index].append(key_names[key_index])

    entries = [
        CatalogEntry(**{**entry.__dict__, "keys": tuple(key_memberships[entry.entry_index])})
        for entry in entries
    ]
    return CatalogSnapshot(
        raw=catalog,
        key_names=tuple(key_names),
        key_entries=tuple(key_entries),
        entries=tuple(entries),
        source_path=source_path,
        catalog_role=catalog_role,
    )


def resource_type_name(value: Any) -> str:
    if isinstance(value, dict):
        class_name = value.get("m_ClassName") or value.get("className")
        if class_name:
            return str(class_name)
    return str(value) if value is not None else ""


def _extra_value(entry: CatalogEntry) -> dict[str, Any] | None:
    if not isinstance(entry.extra, dict):
        return None
    value = entry.extra.get("value")
    return value if isinstance(value, dict) else None


def _optional_int(value: Any) -> int | None:
    if value in (None, "", False):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def bundle_requirement(entry: CatalogEntry, dependency_key: str | None) -> BundleRequirement:
    value = _extra_value(entry) or {}
    internal_id = entry.internal_id
    server_filename = None
    if internal_id:
        server_filename = Path(urlparse(internal_id).path).name or None
    if not server_filename and entry.primary_key and entry.primary_key.endswith(".bundle"):
        server_filename = entry.primary_key
    return BundleRequirement(
        dependency_key=dependency_key,
        bundle_name=str(value.get("m_BundleName")) if value.get("m_BundleName") else None,
        bundle_hash=str(value.get("m_Hash")) if value.get("m_Hash") else None,
        bundle_size=_optional_int(value.get("m_BundleSize")),
        crc=_optional_int(value.get("m_Crc")),
        internal_id=internal_id,
        provider=entry.provider,
        server_filename=server_filename,
    )


def parse_logical_key(logical_key: str) -> tuple[str, str, str, str | None]:
    """Return ``family, semantic_id, variant, language``.

    The semantic id intentionally keeps language-like suffixes in the id;
    stripping them would make version diff keys unstable.  Language is left
    null unless a future catalog-specific rule is verified.
    """

    variant = "normal"
    base = logical_key
    if base.endswith(".HiRes"):
        variant = "hires"
        base = base[: -len(".HiRes")]

    if base.startswith("illustration."):
        return "illustration", base[len("illustration.") :], variant, None
    if base.startswith("altIllustration."):
        return "altIllustration", base[len("altIllustration.") :], variant, None
    if base.startswith("seriesPoster."):
        return "seriesPoster", base[len("seriesPoster.") :], variant, None
    if base.startswith("seriesBanner."):
        return "seriesBanner", base[len("seriesBanner.") :], variant, None
    if base.startswith("avatar.npc."):
        return "avatar.npc", base[len("avatar.npc.") :], variant, None
    if base.startswith("rizcard."):
        return "rizcard", base[len("rizcard.") :], variant, None
    if base.startswith("layout."):
        return "layout", base[len("layout.") :], variant, None
    if base == "banner.EventPosterBanner":
        return "banner", "EventPosterBanner", variant, None

    family, _, semantic_id = base.partition(".")
    return family or "unknown", semantic_id or base, variant, None


def _entries_for_key(snapshot: CatalogSnapshot, logical_key: str) -> tuple[CatalogEntry, ...]:
    return tuple(entry for entry in snapshot.entries if logical_key in entry.keys)


def _dependency_entries(snapshot: CatalogSnapshot, entry: CatalogEntry) -> tuple[str | None, tuple[CatalogEntry, ...]]:
    dependency_key = None
    if 0 <= entry.dependency_key_index < len(snapshot.key_names):
        dependency_key = snapshot.key_names[entry.dependency_key_index]
    if not dependency_key:
        return None, ()
    matches = [
        candidate
        for candidate in snapshot.entries
        if dependency_key in candidate.keys
        and (
            "AssetBundleProvider" in (candidate.provider or "")
            or "AssetBundle" in (candidate.resource_type_name or "")
        )
    ]
    if not matches:
        matches = [
            candidate
            for candidate in snapshot.entries
            if candidate.primary_key == dependency_key
            and (
                "AssetBundleProvider" in (candidate.provider or "")
                or "AssetBundle" in (candidate.resource_type_name or "")
            )
        ]
    return dependency_key, tuple(matches)


def _select_primary_dependency(
    dependency_key: str | None,
    candidates: tuple[CatalogEntry, ...],
) -> tuple[CatalogEntry | None, str]:
    """Select only a catalog-proven primary bundle.

    A dependency key ending in ``.bundle`` directly names the primary bundle.
    Integer dependency keys instead describe a dependency set. For those we
    accept a single leaf entry whose only memberships are its own filename and
    the dependency-set key. Ambiguous sets are left unresolved so the remote
    workflow can verify Unity container membership instead of guessing.
    """

    if not dependency_key or not candidates:
        return None, "UNRESOLVED"
    exact = [candidate for candidate in candidates if candidate.primary_key == dependency_key]
    if len(exact) == 1:
        return exact[0], "CATALOG_EXACT"
    leaves = [
        candidate
        for candidate in candidates
        if set(candidate.keys).issubset({candidate.primary_key, dependency_key})
    ]
    if len(leaves) == 1:
        return leaves[0], "CATALOG_LEAF"
    return None, "AMBIGUOUS_DEPENDENCY_SET"


def bundle_candidates_for_entry(snapshot: CatalogSnapshot, entry: CatalogEntry) -> tuple[BundleRequirement, ...]:
    dependency_key, candidates = _dependency_entries(snapshot, entry)
    return tuple(bundle_requirement(candidate, dependency_key) for candidate in candidates)


def resolve_logical_key(snapshot: CatalogSnapshot, logical_key: str) -> CatalogResolution | None:
    entries = _entries_for_key(snapshot, logical_key)
    if not entries:
        return None

    family, semantic_id, variant, language = parse_logical_key(logical_key)
    declared_types = tuple(dict.fromkeys(entry.resource_type_name for entry in entries if entry.resource_type_name))
    dependency_key, dependency_entries = _dependency_entries(snapshot, entries[0])
    dependency_entry, primary_status = _select_primary_dependency(dependency_key, dependency_entries)
    requirement = bundle_requirement(dependency_entry, dependency_key) if dependency_entry else None
    bundle_candidates = tuple(bundle_requirement(candidate, dependency_key) for candidate in dependency_entries)
    if dependency_entry is not None:
        container_candidate_entries = (dependency_entry,)
    else:
        container_candidate_entries = tuple(
            candidate
            for candidate in dependency_entries
            if set(candidate.keys).issubset({candidate.primary_key, dependency_key})
        )
    container_candidates = tuple(bundle_requirement(candidate, dependency_key) for candidate in container_candidate_entries)
    asset = LogicalAsset(
        logical_key=logical_key,
        asset_family=family,
        semantic_id=semantic_id,
        variant=variant,
        language=language,
        catalog_declared_type="|".join(declared_types) or None,
        asset_entry_indexes=tuple(entry.entry_index for entry in entries),
        bundle=requirement,
        publication_candidate=PUBLICATION_CANDIDATES.get(family, "LOW"),
        family_status=SUPPORTED_FAMILIES.get(family, "UNSUPPORTED"),
        object_internal_ids=tuple(
            dict.fromkeys(entry.internal_id for entry in entries if entry.internal_id)
        ),
    )
    return CatalogResolution(
        asset=asset,
        asset_entries=entries,
        bundle_candidates=bundle_candidates,
        container_candidates=container_candidates,
        primary_bundle_status=primary_status,
    )


def iter_logical_keys(snapshot: CatalogSnapshot, families: Iterable[str] | None = None) -> list[str]:
    allowed = set(families) if families is not None else None
    keys: list[str] = []
    seen: set[str] = set()
    for key in snapshot.key_names:
        family, _semantic_id, _variant, _language = parse_logical_key(key)
        if allowed is not None and family not in allowed:
            continue
        if key in seen or not _entries_for_key(snapshot, key):
            continue
        seen.add(key)
        keys.append(key)
    return keys


def family_summary(snapshot: CatalogSnapshot) -> dict[str, dict[str, int]]:
    counts: Counter[tuple[str, str]] = Counter()
    # Dependency keys, integer hash keys, and generic local assets are also
    # present in Addressables' key table. Keep this summary to recognized
    # semantic families.
    for key in iter_logical_keys(snapshot, SUPPORTED_FAMILIES):
        family, _semantic_id, variant, _language = parse_logical_key(key)
        counts[(family, variant)] += 1
    result: dict[str, dict[str, int]] = {}
    for (family, variant), count in sorted(counts.items()):
        result.setdefault(family, {})[variant] = count
    return result


def _utf8_string(data: bytes, start: int, limit: int) -> str:
    if start + 2 > limit:
        return ""
    length = data[start] | ((data[start + 1] & 0x7F) << 8)
    position = start + 2
    if data[start + 1] & 0x80:
        length = ((data[start] << 8) | data[start + 1]) & 0x7FFF
        position = start + 2
    end = data.find(b"\x00", position, min(limit, position + length * 4 + 2))
    if end < 0:
        end = min(limit, position + length)
    return data[position:end].decode("utf-8", "replace")


def _utf16_string(data: bytes, start: int, limit: int) -> str:
    if start + 2 > limit:
        return ""
    first = int.from_bytes(data[start : start + 2], "little")
    if first & 0x8000:
        length = ((first & 0x7FFF) << 16) | int.from_bytes(data[start + 2 : start + 4], "little")
        position = start + 4
    else:
        length = first
        position = start + 2
    return data[position : position + length * 2].decode("utf-16-le", "replace")


def _parse_string_pool(data: bytes, offset: int) -> tuple[list[str], int]:
    if offset + 24 > len(data) or int.from_bytes(data[offset : offset + 2], "little") != 0x0001:
        return [], offset
    header_size = int.from_bytes(data[offset + 2 : offset + 4], "little")
    chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
    string_count = int.from_bytes(data[offset + 8 : offset + 12], "little")
    flags = int.from_bytes(data[offset + 16 : offset + 20], "little")
    strings_start = int.from_bytes(data[offset + 20 : offset + 24], "little")
    offsets_start = offset + header_size
    base = offset + strings_start
    utf8 = bool(flags & 0x100)
    strings = []
    for index in range(string_count):
        relative = int.from_bytes(data[offsets_start + index * 4 : offsets_start + index * 4 + 4], "little")
        position = base + relative
        strings.append(_utf8_string(data, position, offset + chunk_size) if utf8 else _utf16_string(data, position, offset + chunk_size))
    return strings, offset + chunk_size


def parse_android_manifest(data: bytes) -> dict[str, str]:
    """Read the small set of root attributes needed for VersionContext."""

    strings, position = _parse_string_pool(data, 8)
    if not strings:
        return {}
    for _ in range(10000):
        if position + 8 > len(data):
            break
        chunk_type = int.from_bytes(data[position : position + 2], "little")
        chunk_size = int.from_bytes(data[position + 4 : position + 8], "little")
        if chunk_size < 8 or position + chunk_size > len(data):
            break
        if chunk_type == 0x0102 and position + 36 <= len(data):
            name_index = int.from_bytes(data[position + 20 : position + 24], "little")
            attr_start = int.from_bytes(data[position + 24 : position + 26], "little")
            attr_size = int.from_bytes(data[position + 26 : position + 28], "little")
            attr_count = int.from_bytes(data[position + 28 : position + 30], "little")
            name = strings[name_index] if name_index < len(strings) else ""
            if name == "manifest":
                result: dict[str, str] = {}
                base = position + 16 + attr_start
                for index in range(attr_count):
                    item = base + index * attr_size
                    if item + 20 > position + chunk_size:
                        break
                    attr_name_index = int.from_bytes(data[item + 4 : item + 8], "little")
                    raw_value = int.from_bytes(data[item + 8 : item + 12], "little")
                    data_type = data[item + 15]
                    typed_value = int.from_bytes(data[item + 16 : item + 20], "little")
                    attr_name = strings[attr_name_index] if attr_name_index < len(strings) else f"#{attr_name_index}"
                    if data_type == 0x03:
                        value = strings[typed_value] if typed_value < len(strings) else ""
                    elif data_type == 0x10:
                        value = str(typed_value)
                    elif data_type == 0x12:
                        value = "true" if typed_value else "false"
                    elif 0 <= raw_value < len(strings):
                        value = strings[raw_value]
                    else:
                        value = hex(typed_value)
                    result[attr_name] = value
                return result
        position += chunk_size
    return {}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_apk_catalog(apk_path: Path, *, game: str = "Rizline") -> tuple[GameVersion, CatalogSnapshot]:
    apk_path = apk_path.resolve()
    with zipfile.ZipFile(apk_path) as archive:
        catalog_raw = archive.read("assets/aa/catalog.json")
        manifest_raw = archive.read("AndroidManifest.xml") if "AndroidManifest.xml" in archive.namelist() else b""
    manifest = parse_android_manifest(manifest_raw) if manifest_raw else {}
    snapshot = decode_catalog_bytes(catalog_raw, source_path=str(apk_path), catalog_role="version_source")
    version = GameVersion(
        game=game,
        package_name=manifest.get("package") or "com.leiting.ldgj",
        version_name=manifest.get("versionName") or None,
        version_code=manifest.get("versionCode") or None,
        apk_sha256=_sha256_file(apk_path),
        catalog_sha256=hashlib.sha256(catalog_raw).hexdigest(),
        catalog_build_hash=snapshot.build_hash,
    )
    return version, snapshot


def load_catalog_file(path: Path, *, catalog_role: str = "diagnostic/runtime") -> CatalogSnapshot:
    raw = path.read_bytes()
    return decode_catalog_bytes(raw, source_path=str(path.resolve()), catalog_role=catalog_role)
