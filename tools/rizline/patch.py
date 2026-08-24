"""Patch-metadata parsing, conservative chain traversal, and local caching."""

from __future__ import annotations

import json
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping


PATCH_LIST_SCHEMA = "rizline.patch-list.v1"


class PatchMetadataError(ValueError):
    pass


class PatchChainError(RuntimeError):
    pass


class PatchChainIncomplete(PatchChainError):
    pass


def validate_path_segment(value: str, label: str) -> str:
    """Validate one URL/local-directory segment from remote or cached data."""

    if (
        not value
        or value in {".", ".."}
        or not re.fullmatch(r"[0-9A-Za-z._-]+", value)
    ):
        raise PatchMetadataError(f"UNSAFE_{label}:{value!r}")
    return value


def validate_relative_filepath(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or value.startswith("/")
        or "\\" in value
        or ".." in path.parts
    ):
        raise PatchMetadataError(f"PATCH_METADATA_UNSAFE_FILEPATH:{value!r}")
    return value

@dataclass(frozen=True)
class PatchMetadata:
    previous_resource_version: str
    patched_filepaths: tuple[str, ...]

    @classmethod
    def parse(cls, text: str) -> "PatchMetadata":
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            raise PatchMetadataError("PATCH_METADATA_EMPTY")
        previous = validate_path_segment(lines[0], "RESOURCE_VERSION")
        filepaths = tuple(validate_relative_filepath(path) for path in lines[1:])
        return cls(previous_resource_version=previous, patched_filepaths=filepaths)


@dataclass(frozen=True)
class FetchedPatchMetadata:
    status: int
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class PatchLayer:
    resource_version: str
    previous_resource_version: str
    file_count: int
    source_url: str
    http_status: int
    etag: str | None = None
    last_modified: str | None = None


@dataclass
class PatchList:
    current_resource_version: str
    platform: str
    chain: list[PatchLayer]
    file_to_version: dict[str, str]
    base_version: str | None
    status: str
    retrieved_at: str
    source_metadata: dict[str, object] = field(default_factory=dict)

    def resource_version_for(self, platform_and_filepath: str) -> str:
        path = platform_and_filepath.strip("/")
        validate_relative_filepath(path)
        if path in self.file_to_version:
            return validate_path_segment(self.file_to_version[path], "RESOURCE_VERSION")
        if self.status != "COMPLETE" or not self.base_version:
            raise PatchChainIncomplete(f"PATCH_CHAIN_INCOMPLETE: no verified mapping for {path}")
        return validate_path_segment(self.base_version, "RESOURCE_VERSION")

    def resource_version_for_platform(self, platform: str, filepath: str) -> str:
        platform = validate_path_segment(platform.strip("/"), "PLATFORM")
        validate_relative_filepath(filepath.strip("/"))
        return self.resource_version_for(f"{platform}/{filepath.strip('/')}")

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": PATCH_LIST_SCHEMA,
            "current_resource_version": self.current_resource_version,
            "platform": self.platform,
            "chain": [asdict(layer) for layer in self.chain],
            "file_to_version": dict(sorted(self.file_to_version.items())),
            "base_version": self.base_version,
            "status": self.status,
            "retrieved_at": self.retrieved_at,
            "source_metadata": self.source_metadata,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> "PatchList":
        if value.get("schema_version") != PATCH_LIST_SCHEMA:
            raise PatchChainError("PATCH_LIST_SCHEMA_MISMATCH")
        current = validate_path_segment(
            str(value["current_resource_version"]), "RESOURCE_VERSION",
        )
        platform = validate_path_segment(str(value["platform"]), "PLATFORM")
        chain = [PatchLayer(**item) for item in value.get("chain", [])]  # type: ignore[arg-type]
        mapping = {
            validate_relative_filepath(str(key)): validate_path_segment(
                str(item), "RESOURCE_VERSION",
            )
            for key, item in dict(value.get("file_to_version", {})).items()
        }
        for layer in chain:
            validate_path_segment(layer.resource_version, "RESOURCE_VERSION")
            validate_path_segment(
                layer.previous_resource_version, "RESOURCE_VERSION",
            )
        base = (
            validate_path_segment(str(value["base_version"]), "RESOURCE_VERSION")
            if value.get("base_version")
            else None
        )
        return cls(
            current_resource_version=current,
            platform=platform,
            chain=chain,
            file_to_version=mapping,
            base_version=base,
            status=str(value["status"]),
            retrieved_at=str(value["retrieved_at"]),
            source_metadata=dict(value.get("source_metadata", {})),
        )


FetchPatch = Callable[[str], FetchedPatchMetadata]


def _default_fetch(url: str, timeout: float = 30.0, retries: int = 2) -> FetchedPatchMetadata:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, headers={"User-Agent": "rizline-publish-prep/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return FetchedPatchMetadata(
                    status=int(response.status),
                    body=response.read(),
                    headers={key.lower(): value for key, value in response.headers.items()},
                )
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return FetchedPatchMetadata(status=404, body=b"", headers={key.lower(): value for key, value in exc.headers.items()})
            if 500 <= exc.code < 600 and attempt < retries:
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
                continue
            raise PatchChainError(f"PATCH_METADATA_HTTP_{exc.code}: {url}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            break
    raise PatchChainError(f"PATCH_METADATA_NETWORK_FAILED: {url}: {last_error}")


class PatchMetadataResolver:
    """Build one newest-to-oldest declared chain and cache the mapping."""

    def __init__(
        self,
        resource_base_url: str,
        current_resource_version: str,
        platform: str,
        cache_path: Path,
        *,
        fetch: FetchPatch | None = None,
        max_chain_length: int = 512,
    ) -> None:
        self.resource_base_url = resource_base_url.rstrip("/")
        self.current_resource_version = validate_path_segment(
            current_resource_version.strip("/"), "RESOURCE_VERSION",
        )
        self.platform = validate_path_segment(
            platform.strip("/"), "PLATFORM",
        )
        self.cache_path = cache_path
        self.fetch = fetch or _default_fetch
        self.max_chain_length = max_chain_length

    def _url(self, version: str) -> str:
        return f"{self.resource_base_url}/{version}/patch_metadata"

    def load_cached(self) -> PatchList | None:
        if not self.cache_path.is_file():
            return None
        try:
            value = json.loads(self.cache_path.read_text(encoding="utf-8"))
            patch_list = PatchList.from_dict(value)
        except (OSError, ValueError, TypeError, KeyError, PatchChainError):
            return None
        if patch_list.current_resource_version != self.current_resource_version or patch_list.platform != self.platform:
            return None
        return patch_list

    def _write_cache(self, patch_list: PatchList) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cache_path.with_suffix(self.cache_path.suffix + ".tmp")
        temporary.write_text(json.dumps(patch_list.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.cache_path)

    def build(self, *, refresh: bool = False) -> PatchList:
        if not refresh:
            cached = self.load_cached()
            if cached is not None:
                cached.source_metadata["cache_reused"] = True
                return cached

        current = self.current_resource_version
        visited: set[str] = set()
        chain: list[PatchLayer] = []
        file_to_version: dict[str, str] = {}
        status = "COMPLETE"
        base_version: str | None = None
        stop_reason = ""

        for _ in range(self.max_chain_length):
            if current in visited:
                status, stop_reason = "PATCH_CHAIN_INCOMPLETE", f"circular_reference:{current}"
                break
            visited.add(current)
            url = self._url(current)
            fetched = self.fetch(url)
            if fetched.status == 404:
                status = "COMPLETE"
                base_version = current
                stop_reason = f"no_older_patch_metadata:{current}"
                break
            if fetched.status != 200:
                status, stop_reason = "PATCH_CHAIN_INCOMPLETE", f"unexpected_http_status:{fetched.status}:{current}"
                break
            try:
                metadata = PatchMetadata.parse(fetched.body.decode("utf-8-sig"))
            except (UnicodeDecodeError, PatchMetadataError) as exc:
                status, stop_reason = "PATCH_CHAIN_INCOMPLETE", f"parse_failed:{current}:{exc}"
                break
            chain.append(PatchLayer(
                resource_version=current,
                previous_resource_version=metadata.previous_resource_version,
                file_count=len(metadata.patched_filepaths),
                source_url=url,
                http_status=fetched.status,
                etag=fetched.headers.get("etag"),
                last_modified=fetched.headers.get("last-modified"),
            ))
            for filepath in metadata.patched_filepaths:
                file_to_version.setdefault(filepath, current)
            base_version = metadata.previous_resource_version
            current = metadata.previous_resource_version
        else:
            status, stop_reason = "PATCH_CHAIN_INCOMPLETE", f"max_chain_length:{self.max_chain_length}"

        patch_list = PatchList(
            current_resource_version=self.current_resource_version,
            platform=self.platform,
            chain=chain,
            file_to_version=file_to_version,
            base_version=base_version,
            status=status,
            retrieved_at=datetime.now(timezone.utc).isoformat(),
            source_metadata={
                "resource_base_url": self.resource_base_url,
                "cache_reused": False,
                "stop_reason": stop_reason,
                "chain_policy": "declared_previous_resource_version_only",
            },
        )
        self._write_cache(patch_list)
        return patch_list
