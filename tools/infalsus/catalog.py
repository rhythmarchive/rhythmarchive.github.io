"""Minimal reader for Unity Addressables binary catalogs (v2 and v3)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import struct

UINT_MAX = 0xFFFFFFFF
UNICODE_FLAG = 0x80000000
DYNAMIC_FLAG = 0x40000000
CLEAR_FLAGS_MASK = 0x3FFFFFFF
MAGIC = 0x0DE38942


class CatalogFormatError(ValueError):
    """Raised when a binary catalog is malformed or unsupported."""


@dataclass(frozen=True)
class CatalogHeader:
    magic: int
    version: int
    keys_offset: int
    id_offset: int
    instance_provider: int
    scene_provider: int
    init_objects_array: int
    build_result_hash: int


@dataclass(frozen=True)
class CatalogLocation:
    offset: int
    primary_key: str | None
    internal_id: str | None
    provider_id: str | None
    dependency_set_offset: int
    dependency_hash: int
    extra_data_offset: int
    resource_type: str | None
    extra_data_type: str | None


@dataclass(frozen=True)
class CatalogKey:
    key: str
    location_offsets: tuple[int, ...]


class BinaryCatalog:
    """Read the catalog's keys and resource-location relationships."""

    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        self.header = self._read_header()
        self.keys = self._read_keys()
        self._location_cache: dict[int, CatalogLocation] = {}

    def _check(self, offset: int, size: int = 1) -> None:
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise CatalogFormatError(
                f"catalog offset {offset}..{offset + size} is outside {len(self.data)} bytes"
            )

    def u32(self, offset: int) -> int:
        self._check(offset, 4)
        return struct.unpack_from("<I", self.data, offset)[0]

    def _read_header(self) -> CatalogHeader:
        self._check(0, 32)
        header = CatalogHeader(*struct.unpack_from("<ii6I", self.data, 0))
        if header.magic & 0xFFFFFFFF != MAGIC:
            raise CatalogFormatError(f"unexpected catalog magic 0x{header.magic & 0xFFFFFFFF:08x}")
        if header.version not in (2, 3):
            raise CatalogFormatError(f"unsupported Addressables catalog version {header.version}")
        return header

    def _read_array_bytes(self, offset: int) -> bytes:
        if offset == UINT_MAX:
            return b""
        if offset < 4:
            raise CatalogFormatError(f"invalid array offset {offset}")
        byte_size = self.u32(offset - 4)
        self._check(offset, byte_size)
        return self.data[offset : offset + byte_size]

    def _read_u32_array(self, offset: int) -> tuple[int, ...]:
        payload = self._read_array_bytes(offset)
        if len(payload) % 4:
            raise CatalogFormatError(f"u32 array at {offset} has {len(payload)} bytes")
        return tuple(struct.unpack_from(f"<{len(payload) // 4}I", payload, 0)) if payload else ()

    def _read_keys(self) -> tuple[CatalogKey, ...]:
        payload = self._read_array_bytes(self.header.keys_offset)
        if len(payload) % 8:
            raise CatalogFormatError(f"key array has {len(payload)} bytes, not a multiple of 8")
        entries: list[CatalogKey] = []
        for offset in range(0, len(payload), 8):
            key_name_offset, location_set_offset = struct.unpack_from("<2I", payload, offset)
            key = self.read_object_string(key_name_offset)
            if key is not None:
                entries.append(CatalogKey(key, self._read_u32_array(location_set_offset)))
        return tuple(entries)

    def _read_string_data(self, offset: int, encoding: str) -> str:
        if offset < 4:
            raise CatalogFormatError(f"invalid string offset {offset}")
        byte_size = self.u32(offset - 4)
        self._check(offset, byte_size)
        try:
            return self.data[offset : offset + byte_size].decode(encoding)
        except UnicodeDecodeError as exc:
            raise CatalogFormatError(f"invalid {encoding} string at {offset}") from exc

    def read_string(self, identifier: int, separator: str = "") -> str | None:
        if identifier == UINT_MAX:
            return None
        if separator and identifier & DYNAMIC_FLAG:
            return self._read_dynamic_string(identifier & CLEAR_FLAGS_MASK, separator)
        unicode_string = bool(identifier & UNICODE_FLAG)
        offset = identifier & CLEAR_FLAGS_MASK if unicode_string else identifier
        return self._read_string_data(offset, "utf-16-le" if unicode_string else "ascii")

    def _read_dynamic_string(self, offset: int, separator: str) -> str:
        parts: list[str] = []
        seen: set[int] = set()
        while offset != UINT_MAX:
            if offset in seen:
                raise CatalogFormatError("dynamic string chain contains a cycle")
            seen.add(offset)
            self._check(offset, 8)
            part_id, next_id = struct.unpack_from("<2I", self.data, offset)
            part = self.read_string(part_id)
            if part is not None:
                parts.append(part)
            offset = next_id & CLEAR_FLAGS_MASK if next_id != UINT_MAX else UINT_MAX
        return separator.join(parts)

    def _read_object_type_data(self, offset: int) -> tuple[int, int]:
        self._check(offset, 8)
        return struct.unpack_from("<2I", self.data, offset)

    def _read_type_name(self, offset: int) -> str | None:
        if offset == UINT_MAX:
            return None
        assembly_id, class_id = self._read_object_type_data(offset)
        assembly = self.read_string(assembly_id, ".")
        class_name = self.read_string(class_id, ".")
        if class_name and assembly:
            return f"{class_name} [{assembly}]"
        return class_name or assembly

    def _read_wrapped_type_name(self, offset: int) -> str | None:
        if offset == UINT_MAX:
            return None
        type_id, _object_id = self._read_object_type_data(offset)
        return self._read_type_name(type_id)

    def read_object_string(self, offset: int) -> str | None:
        if offset == UINT_MAX:
            return None
        _type_id, object_id = self._read_object_type_data(offset)
        self._check(object_id, 8)
        string_id, separator_code = struct.unpack_from("<I H", self.data, object_id)
        return self.read_string(string_id, chr(separator_code) if separator_code else "")

    def location(self, offset: int) -> CatalogLocation:
        self._check(offset, 28)
        (
            primary_key_offset,
            internal_id_offset,
            provider_offset,
            dependency_set_offset,
            dependency_hash,
            extra_data_offset,
            type_id,
        ) = struct.unpack_from("<4I i 2I", self.data, offset)
        return CatalogLocation(
            offset=offset,
            primary_key=self.read_string(primary_key_offset, "/"),
            internal_id=self.read_string(internal_id_offset, "/"),
            provider_id=self.read_string(provider_offset, "."),
            dependency_set_offset=dependency_set_offset,
            dependency_hash=dependency_hash,
            extra_data_offset=extra_data_offset,
            resource_type=self._read_type_name(type_id),
            extra_data_type=self._read_wrapped_type_name(extra_data_offset),
        )

    def locations_for_key(self, key: str) -> tuple[CatalogLocation, ...]:
        for entry in self.keys:
            if entry.key == key:
                return tuple(self.location(offset) for offset in entry.location_offsets)
        return ()

    def iter_locations(self):
        seen: set[int] = set()
        for entry in self.keys:
            for offset in entry.location_offsets:
                if offset not in seen:
                    seen.add(offset)
                    yield self.location(offset)

    def key_names(self) -> tuple[str, ...]:
        return tuple(entry.key for entry in self.keys)
