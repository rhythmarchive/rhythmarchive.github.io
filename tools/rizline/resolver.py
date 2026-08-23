"""Payload resolver interfaces and the verified local UnityCache resolver."""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from pathlib import Path

from .model import BundleRequirement, Payload, PayloadStatus


SUPPORTED_UNITY_HEADERS = (b"UnityFS", b"UnityRaw", b"UnityWeb")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class PayloadResolver(ABC):
    """Resolve an already identified bundle; it does not discover keys."""

    @abstractmethod
    def resolve(self, requirement: BundleRequirement) -> Payload:
        raise NotImplementedError


class RuntimeCacheResolver(PayloadResolver):
    """Resolve ``Shared/<bundle-name>/<bundle-hash>/__data`` directly.

    The resolver intentionally does not recurse through the cache.  This
    prevents unrelated old bundles from being guessed as a match.
    """

    def __init__(self, cache_root: Path) -> None:
        self.requested_root = cache_root.resolve()
        self.shared_root = self._normalize_shared_root(self.requested_root)

    @staticmethod
    def _normalize_shared_root(root: Path) -> Path:
        if root.name.lower() == "shared":
            return root
        candidates = (
            root / "UnityCache" / "Shared",
            root / "files" / "UnityCache" / "Shared",
            root / "Shared" if root.name.lower() == "unitycache" else root / "__not_a_shared_root__",
        )
        for candidate in candidates:
            if candidate.is_dir():
                return candidate
        return root

    def resolve(self, requirement: BundleRequirement) -> Payload:
        bundle_name = requirement.bundle_name
        bundle_hash = requirement.bundle_hash
        if not bundle_name or not bundle_hash:
            return Payload(
                source="runtime_cache",
                path=None,
                sha256=None,
                size=None,
                unity_signature=None,
                match_status="MISSING",
                payload_status=PayloadStatus.UNRESOLVED,
                version_attribution=None,
                notes=("bundle_name_or_hash_missing",),
            )

        path = self.shared_root / bundle_name / bundle_hash / "__data"
        if not path.is_file():
            return Payload(
                source="runtime_cache",
                path=str(path),
                sha256=None,
                size=None,
                unity_signature=None,
                match_status="MISSING",
                payload_status=PayloadStatus.MISSING,
                version_attribution=None,
                notes=("cache_payload_not_found",),
            )

        with path.open("rb") as handle:
            header = handle.read(16)
        signature_bytes = next((candidate for candidate in SUPPORTED_UNITY_HEADERS if header.startswith(candidate)), None)
        if signature_bytes is None:
            return Payload(
                source="runtime_cache",
                path=str(path),
                sha256=_sha256(path),
                size=path.stat().st_size,
                unity_signature=header[:8].decode("latin1", "replace"),
                match_status="INVALID",
                payload_status=PayloadStatus.INVALID,
                version_attribution=None,
                notes=("unsupported_unity_header",),
            )

        actual_size = path.stat().st_size
        exact_size = requirement.bundle_size is None or actual_size == requirement.bundle_size
        status = "EXACT" if exact_size else "STRONG"
        notes = () if exact_size else ("declared_size_differs_from_cache_file",)
        attribution = "strongly_attributed_to_2.7.0_catalog" if exact_size else "cache_identifier_and_unity_header_only"
        return Payload(
            source="runtime_cache",
            path=str(path),
            sha256=_sha256(path),
            size=actual_size,
            unity_signature=signature_bytes.decode("ascii"),
            match_status=status,
            payload_status=PayloadStatus.FOUND,
            version_attribution=attribution,
            notes=notes,
        )


class DirectCdnResolver(PayloadResolver):
    """Reserved interface; network access is deliberately not implemented."""

    def resolve(self, requirement: BundleRequirement) -> Payload:
        return Payload(
            source="remote_direct",
            path=None,
            sha256=None,
            size=None,
            unity_signature=None,
            match_status="MISSING",
            payload_status=PayloadStatus.UNRESOLVED,
            version_attribution=None,
            notes=("NOT_IMPLEMENTED_NO_NETWORK",),
        )
