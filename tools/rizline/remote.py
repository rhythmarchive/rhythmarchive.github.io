"""Patch-aware canonical remote bundle acquisition."""

from __future__ import annotations

import hashlib
import json
import re
import socket
import time
import urllib.error
import urllib.request
import zlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from .model import BundleRequirement, Payload, PayloadStatus
from .patch import PatchChainIncomplete, PatchList, PatchMetadataError, validate_path_segment
from .resolver import PayloadResolver, SUPPORTED_UNITY_HEADERS


class RemoteAcquisitionError(RuntimeError):
    pass


@dataclass
class RemoteBundleRecord:
    dependency_key: str | None
    bundle_hash: str | None
    bundle_name: str | None
    server_filename: str
    provider: str | None
    selected_resource_version: str | None
    patch_mapping_source: str | None
    remote_url: str | None
    cache_path: str | None
    expected_size: int | None
    downloaded_size: int | None
    bundle_sha256: str | None
    unity_header: str | None
    crc_status: str
    http_status: int | None
    download_status: str
    verification_status: str
    cache_reused: bool
    retrieved_at: str
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unity_header(path: Path) -> str | None:
    with path.open("rb") as handle:
        header = handle.read(16)
    signature = next((item for item in SUPPORTED_UNITY_HEADERS if header.startswith(item)), None)
    return signature.decode("ascii") if signature else None


def _crc_status(path: Path, expected_crc: int | None) -> str:
    if not expected_crc:
        return "CRC_NOT_PROVIDED"
    value = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value = zlib.crc32(chunk, value)
    return "CRC_VERIFIED" if value & 0xFFFFFFFF == expected_crc & 0xFFFFFFFF else "CRC_MISMATCH"

def _cache_target(root: Path, *segments: str) -> Path:
    root_resolved = root.resolve()
    target = root.joinpath(*segments).resolve()
    try:
        target.relative_to(root_resolved)
    except ValueError as exc:
        raise RemoteAcquisitionError(
            f"CACHE_TARGET_OUTSIDE_ROOT:{target}:{root_resolved}"
        ) from exc
    return target


class DirectAssetResolver(PayloadResolver):
    """Resolve one catalog-declared AssetBundleProvider requirement."""

    def __init__(
        self,
        resource_base_url: str,
        patch_list: PatchList,
        bundle_cache: Path,
        *,
        platform: str = "Android",
        timeout: float = 60.0,
        retries: int = 2,
    ) -> None:
        self.resource_base_url = resource_base_url.rstrip("/")
        self.patch_list = patch_list
        self.bundle_cache = bundle_cache
        self.platform = validate_path_segment(platform.strip("/"), "PLATFORM")
        self.timeout = timeout
        self.retries = retries
        self.records: dict[tuple[str | None, str], RemoteBundleRecord] = {}

    @staticmethod
    def server_filename(requirement: BundleRequirement) -> str:
        if requirement.provider and "AssetBundleProvider" not in requirement.provider:
            raise RemoteAcquisitionError(f"UNSUPPORTED_PROVIDER: {requirement.provider}")
        filename = requirement.server_filename
        if filename and filename.endswith(".bundle") and "/" not in filename and "\\" not in filename:
            return validate_path_segment(filename, "SERVER_FILENAME")
        if requirement.bundle_hash:
            bundle_hash = validate_path_segment(
                requirement.bundle_hash, "BUNDLE_HASH",
            )
            return validate_path_segment(f"{bundle_hash}.bundle", "SERVER_FILENAME")
        raise RemoteAcquisitionError("SERVER_FILENAME_UNRESOLVED")

    def construct_url(self, requirement: BundleRequirement) -> tuple[str, str, str]:
        filename = self.server_filename(requirement)
        version = self.patch_list.resource_version_for_platform(self.platform, filename)
        url = f"{self.resource_base_url}/{version}/{self.platform}/{filename}"
        return version, filename, url

    def _record(
        self,
        requirement: BundleRequirement,
        filename: str,
        *,
        version: str | None = None,
        url: str | None = None,
        path: Path | None = None,
        status: str = "FAILED",
        verification: str = "NOT_VERIFIED",
        http_status: int | None = None,
        cache_reused: bool = False,
        error: str | None = None,
    ) -> RemoteBundleRecord:
        size = path.stat().st_size if path and path.is_file() else None
        sha = _sha256(path) if path and path.is_file() else None
        header = _unity_header(path) if path and path.is_file() else None
        crc_status = _crc_status(path, requirement.crc) if path and path.is_file() else ("CRC_NOT_PROVIDED" if not requirement.crc else "NOT_VERIFIED")
        record = RemoteBundleRecord(
            dependency_key=requirement.dependency_key,
            bundle_hash=requirement.bundle_hash,
            bundle_name=requirement.bundle_name,
            server_filename=filename,
            provider=requirement.provider,
            selected_resource_version=version,
            patch_mapping_source=f"patch_list:{self.platform}/{filename}" if version else None,
            remote_url=url,
            cache_path=str(path.resolve()) if path else None,
            expected_size=requirement.bundle_size,
            downloaded_size=size,
            bundle_sha256=sha,
            unity_header=header,
            crc_status=crc_status,
            http_status=http_status,
            download_status=status,
            verification_status=verification,
            cache_reused=cache_reused,
            retrieved_at=datetime.now(timezone.utc).isoformat(),
            error=error,
        )
        self.records[(requirement.bundle_hash, filename)] = record
        return record

    @staticmethod
    def _verify(path: Path, requirement: BundleRequirement) -> tuple[bool, str]:
        if requirement.bundle_size is not None and path.stat().st_size != requirement.bundle_size:
            return False, f"SIZE_MISMATCH:{path.stat().st_size}!={requirement.bundle_size}"
        if _unity_header(path) is None:
            return False, "UNSUPPORTED_UNITY_HEADER"
        crc = _crc_status(path, requirement.crc)
        if crc == "CRC_MISMATCH":
            return False, crc
        return True, "VERIFIED"

    @staticmethod
    def _cache_evidence_matches(
        path: Path,
        metadata_path: Path,
        *,
        version: str,
        url: str,
        filename: str,
    ) -> tuple[bool, str]:
        try:
            evidence = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return False, f"CACHE_EVIDENCE_INVALID:{type(exc).__name__}:{exc}"
        expected_sha = evidence.get("bundle_sha256")
        if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
            return False, "CACHE_EVIDENCE_SHA256_MISSING"
        checks = {
            "selected_resource_version": version,
            "remote_url": url,
            "server_filename": filename,
        }
        for field, expected in checks.items():
            if evidence.get(field) != expected:
                return False, f"CACHE_EVIDENCE_{field.upper()}_MISMATCH"
        actual_sha = _sha256(path)
        if actual_sha != expected_sha:
            return False, f"CACHE_SHA256_MISMATCH:{actual_sha}!={expected_sha}"
        saved_size = evidence.get("downloaded_size")
        if saved_size is not None and saved_size != path.stat().st_size:
            return False, f"CACHE_EVIDENCE_SIZE_MISMATCH:{path.stat().st_size}!={saved_size}"
        return True, "CACHE_EVIDENCE_VERIFIED"

    def _download(self, url: str, target: Path) -> tuple[int, bool]:
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            offset = target.stat().st_size if target.is_file() else 0
            headers = {"User-Agent": "rizline-publish-prep/1.0"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    status = int(response.status)
                    if status not in {200, 206}:
                        raise RemoteAcquisitionError(f"HTTP_{status}")
                    resumed = bool(offset and status == 206)
                    if resumed:
                        content_range = response.headers.get("Content-Range")
                        match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range or "")
                        if not match or int(match.group(1)) != offset:
                            raise RemoteAcquisitionError(
                                "CONTENT_RANGE_MISMATCH:"
                                f"requested={offset},received={content_range!r}"
                            )
                    mode = "ab" if resumed else "wb"
                    with target.open(mode) as handle:
                        for chunk in iter(lambda: response.read(1024 * 1024), b""):
                            handle.write(chunk)
                    return status, resumed
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise RemoteAcquisitionError(f"HTTP_404:{url}") from exc
                last_error = exc
                if 500 <= exc.code < 600 and attempt < self.retries:
                    time.sleep(0.75 * (attempt + 1))
                    continue
                raise RemoteAcquisitionError(f"HTTP_{exc.code}:{url}") from exc
            except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(0.75 * (attempt + 1))
                    continue
                break
        raise RemoteAcquisitionError(f"NETWORK_FAILED:{url}:{last_error}")

    def acquire(self, requirement: BundleRequirement) -> RemoteBundleRecord:
        try:
            version, filename, url = self.construct_url(requirement)
        except (RemoteAcquisitionError, PatchChainIncomplete, PatchMetadataError) as exc:
            filename = requirement.server_filename or (f"{requirement.bundle_hash}.bundle" if requirement.bundle_hash else "unresolved.bundle")
            return self._record(requirement, filename, error=str(exc))

        try:
            cache_dir = _cache_target(self.bundle_cache, version)
            target = _cache_target(self.bundle_cache, version, filename)
            metadata_path = target.with_suffix(target.suffix + ".json")
        except (RemoteAcquisitionError, OSError) as exc:
            return self._record(
                requirement, filename, version=version, url=url, error=str(exc),
            )
        if target.is_file():
            valid, reason = self._verify(target, requirement)
            evidence_valid, evidence_reason = self._cache_evidence_matches(
                target, metadata_path, version=version, url=url, filename=filename,
            )
            if valid and evidence_valid:
                return self._record(requirement, filename, version=version, url=url, path=target, status="CACHE_REUSED", verification="VERIFIED", http_status=None, cache_reused=True)

        cache_dir.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(target.suffix + ".part")
        if (
            partial.is_file()
            and requirement.bundle_size is not None
            and partial.stat().st_size > requirement.bundle_size
        ):
            partial.unlink()
        if (
            partial.is_file()
            and requirement.bundle_size is not None
            and partial.stat().st_size == requirement.bundle_size
        ):
            valid, reason = self._verify(partial, requirement)
            # A complete orphan partial has no saved remote SHA evidence.
            # Promote it only when the catalog supplied an independently
            # verifiable CRC; otherwise redownload it from byte zero.
            if valid and requirement.crc:
                partial.replace(target)
                record = self._record(
                    requirement, filename, version=version, url=url, path=target,
                    status="RESUMED_CACHE", verification="VERIFIED",
                    http_status=206, cache_reused=True,
                )
                metadata_path.write_text(
                    json.dumps(record.to_dict(), ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                return record
            partial.unlink()
        try:
            http_status, resumed = self._download(url, partial)
            valid, reason = self._verify(partial, requirement)
            if not valid:
                partial.unlink(missing_ok=True)
                return self._record(requirement, filename, version=version, url=url, status="FAILED", verification=reason, http_status=http_status, error=reason)
            partial.replace(target)
            record = self._record(
                requirement, filename, version=version, url=url, path=target,
                status="RESUMED" if resumed else "DOWNLOADED",
                verification="VERIFIED", http_status=http_status,
            )
            metadata_path.write_text(json.dumps(record.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return record
        except Exception as exc:
            return self._record(
                requirement, filename, version=version, url=url,
                status="PARTIAL_PRESERVED" if partial.is_file() else "FAILED",
                verification="NOT_VERIFIED", error=f"{type(exc).__name__}:{exc}",
            )

    def resolve(self, requirement: BundleRequirement) -> Payload:
        record = self.acquire(requirement)
        found = record.verification_status == "VERIFIED" and record.cache_path is not None
        return Payload(
            source="REMOTE_CANONICAL",
            path=record.cache_path,
            sha256=record.bundle_sha256,
            size=record.downloaded_size,
            unity_signature=record.unity_header,
            match_status="EXACT" if found else "MISSING",
            payload_status=PayloadStatus.FOUND if found else PayloadStatus.UNRESOLVED,
            version_attribution=record.selected_resource_version,
            notes=tuple(filter(None, (record.crc_status, record.error))),
        )


    @staticmethod
    def _catalog_valid(path: Path) -> tuple[bool, str]:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return False, f"CATALOG_JSON_INVALID:{type(exc).__name__}:{exc}"
        required = {
            "m_KeyDataString", "m_BucketDataString", "m_EntryDataString",
            "m_ExtraDataString", "m_InternalIds", "m_ProviderIds",
        }
        missing = sorted(required - set(value))
        if missing:
            return False, f"CATALOG_FIELDS_MISSING:{','.join(missing)}"
        return True, "VERIFIED"


    @staticmethod
    def _catalog_cache_evidence(
        path: Path,
        metadata_path: Path,
        *,
        version: str,
        url: str,
    ) -> tuple[dict[str, object] | None, str]:
        try:
            evidence = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return None, f"CATALOG_CACHE_EVIDENCE_INVALID:{type(exc).__name__}:{exc}"
        expected_sha = evidence.get("sha256")
        if (
            not isinstance(expected_sha, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_sha)
        ):
            return None, "CATALOG_CACHE_SHA256_MISSING"
        if evidence.get("selected_resource_version") != version:
            return None, "CATALOG_CACHE_VERSION_MISMATCH"
        if evidence.get("remote_url") != url:
            return None, "CATALOG_CACHE_URL_MISMATCH"
        actual_sha = _sha256(path)
        if actual_sha != expected_sha:
            return None, f"CATALOG_CACHE_SHA256_MISMATCH:{actual_sha}!={expected_sha}"
        saved_size = evidence.get("downloaded_size")
        if saved_size is not None and saved_size != path.stat().st_size:
            return None, "CATALOG_CACHE_SIZE_MISMATCH"
        result = dict(evidence)
        result.update({
            "status": "CACHE_REUSED",
            "verification_status": "VERIFIED",
            "cache_path": str(path.resolve()),
            "downloaded_size": path.stat().st_size,
            "sha256": actual_sha,
            "http_status": None,
        })
        return result, "VERIFIED"
    def acquire_catalog(
        self,
        filename: str = "catalog_catalog.json",
    ) -> tuple[Path | None, dict[str, object]]:
        """Acquire the current platform catalog through the same PatchList."""

        try:
            version = self.patch_list.resource_version_for_platform(
                self.platform, filename,
            )
        except PatchChainIncomplete as exc:
            return None, {
                "status": "FAILED",
                "error": str(exc),
                "filename": filename,
            }
        filename = validate_path_segment(filename, "CATALOG_FILENAME")
        url = f"{self.resource_base_url}/{version}/{self.platform}/{filename}"
        catalog_root = (self.bundle_cache.parent / "cache" / "remote_catalogs")
        target = _cache_target(catalog_root, version, filename)
        metadata_path = target.with_suffix(target.suffix + ".metadata.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file():
            valid, reason = self._catalog_valid(target)
            if valid:
                evidence, evidence_reason = self._catalog_cache_evidence(
                    target, metadata_path, version=version, url=url,
                )
                if evidence is not None:
                    return target, evidence
        partial = target.with_suffix(target.suffix + ".part")
        if partial.is_file():
            complete, _complete_reason = self._catalog_valid(partial)
            if complete:
                # A structurally complete orphan has no trusted sidecar and a
                # Range request from EOF can loop on HTTP 416. Redownload it
                # from byte zero to restore canonical remote evidence.
                partial.unlink()
        try:
            http_status, resumed = self._download(url, partial)
            valid, reason = self._catalog_valid(partial)
            if not valid:
                partial.unlink(missing_ok=True)
                return None, {
                    "status": "FAILED",
                    "verification_status": reason,
                    "selected_resource_version": version,
                    "remote_url": url,
                    "http_status": http_status,
                }
            partial.replace(target)
            evidence = {
                "status": "RESUMED" if resumed else "DOWNLOADED",
                "verification_status": "VERIFIED",
                "selected_resource_version": version,
                "patch_mapping_source": f"patch_list:{self.platform}/{filename}",
                "remote_url": url,
                "cache_path": str(target.resolve()),
                "downloaded_size": target.stat().st_size,
                "sha256": _sha256(target),
                "http_status": http_status,
            }
            metadata_path.write_text(
                json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            return target, evidence
        except Exception as exc:
            return None, {
                "status": "PARTIAL_PRESERVED" if partial.is_file() else "FAILED",
                "selected_resource_version": version,
                "remote_url": url,
                "cache_path": str(partial.resolve()) if partial.is_file() else None,
                "error": f"{type(exc).__name__}:{exc}",
            }
