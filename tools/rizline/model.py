"""Stable Phase 3 data model.

The model deliberately keeps catalog identity, payload identity, decoded
object identity, and publication/review state separate.  In particular, a
runtime catalog can never replace :class:`GameVersion`'s APK catalog fields.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


class PayloadStatus(str, Enum):
    FOUND = "FOUND"
    MISSING = "MISSING"
    INVALID = "INVALID"
    UNRESOLVED = "UNRESOLVED"


class ParseStatus(str, Enum):
    SUCCESS = "SUCCESS"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    NOT_ATTEMPTED = "NOT_ATTEMPTED"


class ReviewStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class SemanticCompleteness(str, Enum):
    COMPLETE = "COMPLETE"
    STATIC_ONLY = "STATIC_ONLY"
    PARTIAL = "PARTIAL"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class GameVersion:
    game: str
    package_name: str | None
    version_name: str | None
    version_code: str | None
    apk_sha256: str
    catalog_sha256: str
    catalog_build_hash: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BundleRequirement:
    dependency_key: str | None
    bundle_name: str | None
    bundle_hash: str | None
    bundle_size: int | None
    crc: int | None
    internal_id: str | None
    provider: str | None = None
    server_filename: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class LogicalAsset:
    logical_key: str
    asset_family: str
    semantic_id: str
    variant: str
    language: str | None
    catalog_declared_type: str | None
    asset_entry_indexes: tuple[int, ...]
    bundle: BundleRequirement | None
    publication_candidate: str
    family_status: str
    object_internal_ids: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["asset_entry_indexes"] = list(self.asset_entry_indexes)
        result["object_internal_ids"] = list(self.object_internal_ids)
        return result


@dataclass(frozen=True)
class Payload:
    source: str
    path: str | None
    sha256: str | None
    size: int | None
    unity_signature: str | None
    match_status: str
    payload_status: PayloadStatus
    version_attribution: str | None
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["payload_status"] = self.payload_status.value
        result["notes"] = list(self.notes)
        return result


@dataclass(frozen=True)
class ResolvedObject:
    resolved_object_type: str
    object_name: str | None
    object_path_id: int | None
    width: int | None
    height: int | None
    texture_format: str | None
    has_alpha: str | None
    mipmap_count: int | None
    sprite_rect: dict[str, float] | None
    sprite_pivot: dict[str, float] | None
    sprite_full_texture: bool | None
    texture_source_path_id: int | None
    sprite_atlas_path_id: int | None
    decoded_sha256: str | None
    phash: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExtractedAsset:
    """A manifest row, kept as a dataclass until JSON/CSV serialization."""

    game: str
    package_name: str | None
    game_version: str | None
    version_code: str | None
    apk_sha256: str
    catalog_sha256: str
    catalog_build_hash: str | None
    asset_family: str
    logical_key: str
    semantic_id: str
    variant: str
    language: str | None
    catalog_declared_type: str | None
    dependency_key: str | None
    bundle_name: str | None
    bundle_hash: str | None
    bundle_size: int | None
    crc: int | None
    internal_id: str | None
    preferred_dependency_key: str | None
    preferred_bundle_name: str | None
    preferred_bundle_hash: str | None
    preferred_bundle_size: int | None
    preferred_crc: int | None
    preferred_internal_id: str | None
    payload_source: str | None
    payload_path: str | None
    payload_sha256: str | None
    payload_status: str
    payload_match_status: str | None
    version_attribution: str | None
    parse_status: str
    resolved_object_type: str | None
    object_name: str | None
    object_path_id: int | None
    width: int | None
    height: int | None
    texture_format: str | None
    has_alpha: str | None
    mipmap_count: int | None
    sprite_rect: dict[str, float] | None
    sprite_pivot: dict[str, float] | None
    sprite_full_texture: bool | None
    decoded_sha256: str | None
    phash: str | None
    preferred_variant: str
    resolved_variant: str | None
    variant_fallback: bool
    fallback_reason: str | None
    publication_candidate: str
    review_status: str
    semantic_completeness: str
    export_path: str | None
    notes: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
