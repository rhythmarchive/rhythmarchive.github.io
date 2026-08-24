"""Reader for the serialized Unity Addressables content catalog.

The catalog is treated as an APK-local index.  A dependency/bundle name is
kept as provenance; it is never used as the semantic identity of an asset.
"""

from __future__ import annotations

import base64
import json
import struct
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CatalogEntry:
    entry_index: int
    internal_id: str | None
    provider: str | None
    dependency_key_index: int
    primary_key: str | None
    resource_type: Any
    keys: tuple[str, ...]
    extra: Any

    @property
    def resource_type_name(self) -> str:
        if isinstance(self.resource_type, dict):
            return str(self.resource_type.get("m_ClassName") or self.resource_type.get("className") or "")
        return str(self.resource_type or "")


@dataclass(frozen=True)
class CatalogSnapshot:
    raw: dict[str, Any]
    key_names: tuple[str, ...]
    key_entries: tuple[tuple[int, ...], ...]
    entries: tuple[CatalogEntry, ...]

    @property
    def build_hash(self) -> str | None:
        value = self.raw.get("m_BuildResultHash")
        return str(value) if value else None

    def entries_for_key(self, key: str) -> tuple[CatalogEntry, ...]:
        return tuple(entry for entry in self.entries if key in entry.keys)

    def dependency_key(self, entry: CatalogEntry) -> str | None:
        index = entry.dependency_key_index
        if 0 <= index < len(self.key_names):
            return self.key_names[index]
        return None

    def summary(self) -> dict[str, Any]:
        return {
            "locator_id": self.raw.get("m_LocatorId"),
            "build_result_hash": self.build_hash,
            "logical_key_count": len(self.key_names),
            "entry_count": len(self.entries),
            "internal_id_count": len(self.raw.get("m_InternalIds", [])),
            "provider_count": len(self.raw.get("m_ProviderIds", [])),
            "resource_type_count": len(self.raw.get("m_resourceTypes", [])),
        }


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
        encoding = "ascii" if kind == 0 else "utf-16-le"
        return raw.decode(encoding, "replace")
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


def decode_catalog_bytes(raw: bytes) -> CatalogSnapshot:
    """Decode a Unity Addressables catalog JSON payload."""

    catalog = json.loads(raw)
    key_data = base64.b64decode(catalog["m_KeyDataString"])
    bucket_data = base64.b64decode(catalog["m_BucketDataString"])
    entry_data = base64.b64decode(catalog["m_EntryDataString"])
    extra_data = base64.b64decode(catalog.get("m_ExtraDataString", ""))

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
        value = _read_catalog_object(key_data, key_offset)
        key_names.append(str(value))
        key_entries.append(indexes)

    entry_count = _read_i32(entry_data, 0)
    internal_ids = catalog.get("m_InternalIds", [])
    providers = catalog.get("m_ProviderIds", [])
    resource_types = catalog.get("m_resourceTypes", [])
    entries: list[CatalogEntry] = []
    position = 4
    for entry_index in range(entry_count):
        values = struct.unpack_from("<7i", entry_data, position)
        position += 28
        (
            internal_id_index,
            provider_index,
            dependency_key_index,
            _dependency_hash,
            data_index,
            primary_key_index,
            resource_type_index,
        ) = values
        extra = None
        if data_index >= 0 and data_index < len(extra_data):
            extra = _read_catalog_object(extra_data, data_index)
        entries.append(
            CatalogEntry(
                entry_index=entry_index,
                internal_id=(
                    str(internal_ids[internal_id_index])
                    if 0 <= internal_id_index < len(internal_ids)
                    else None
                ),
                provider=(str(providers[provider_index]) if 0 <= provider_index < len(providers) else None),
                dependency_key_index=dependency_key_index,
                primary_key=(
                    key_names[primary_key_index]
                    if 0 <= primary_key_index < len(key_names)
                    else None
                ),
                resource_type=(
                    resource_types[resource_type_index]
                    if 0 <= resource_type_index < len(resource_types)
                    else None
                ),
                keys=(),
                extra=extra,
            )
        )

    memberships: list[list[str]] = [[] for _ in entries]
    for key_index, indexes in enumerate(key_entries):
        for entry_index in indexes:
            if 0 <= entry_index < len(entries):
                memberships[entry_index].append(key_names[key_index])

    return CatalogSnapshot(
        raw=catalog,
        key_names=tuple(key_names),
        key_entries=tuple(key_entries),
        entries=tuple(
            CatalogEntry(
                entry_index=entry.entry_index,
                internal_id=entry.internal_id,
                provider=entry.provider,
                dependency_key_index=entry.dependency_key_index,
                primary_key=entry.primary_key,
                resource_type=entry.resource_type,
                keys=tuple(memberships[entry.entry_index]),
                extra=entry.extra,
            )
            for entry in entries
        ),
    )
