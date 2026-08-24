"""Reusable In Falsus Demo metadata and jacket extractor."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
from typing import Any, Iterable
import unicodedata

from .catalog import BinaryCatalog, CatalogLocation, UINT_MAX

try:
    import UnityPy
    from UnityPy.enums import TextureFormat
except ImportError as exc:  # pragma: no cover - CLI reports this dependency error
    UnityPy = None  # type: ignore[assignment]
    TextureFormat = None  # type: ignore[assignment,misc]
    UNITYPY_IMPORT_ERROR = exc
else:
    UNITYPY_IMPORT_ERROR = None


@dataclass(frozen=True)
class GamePaths:
    root: Path
    data_root: Path
    catalog_path: Path
    bundle_root: Path
    settings_path: Path


@dataclass(frozen=True)
class ArtworkResult:
    canonical: dict[str, Any]
    small: dict[str, Any]
    addressables: dict[str, Any]


@dataclass(frozen=True)
class ExtractedSong:
    song_id: int
    base_name: str
    title: str
    artist: str
    available: bool
    jacket_illustrator: str | None
    charts: tuple[dict[str, Any], ...]
    artwork: ArtworkResult


class InfalsusExtractionError(RuntimeError):
    """Raised when the game data cannot be extracted reproducibly."""


def resolve_game_paths(game_root: str | Path) -> GamePaths:
    root = Path(game_root).expanduser().resolve()
    data_root = root / "if-app_Data"
    catalog_path = data_root / "StreamingAssets" / "aa" / "catalog.bin"
    bundle_root = data_root / "StreamingAssets" / "aa" / "StandaloneWindows64"
    settings_path = data_root / "StreamingAssets" / "aa" / "settings.json"
    missing = [str(path) for path in (catalog_path, bundle_root) if not path.exists()]
    if missing:
        raise InfalsusExtractionError("game install is missing: " + ", ".join(missing))
    return GamePaths(root, data_root, catalog_path, bundle_root, settings_path)


def _json_dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _value(value: Any, default: Any = None) -> Any:
    if isinstance(value, dict):
        if "Value" in value:
            return value["Value"]
        if "value" in value:
            return value["value"]
    return default if value is None else value


def _text(value: Any, default: str = "") -> str:
    return default if value is None else str(value)


def _slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    result = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_value).strip("-").lower()
    return result or "song"


def _mapping_lookup(mapping: dict[str, Any], song_id: int) -> str:
    ids = mapping.get("Ids", [])
    values = mapping.get("IdValues", [])
    id_strings = mapping.get("IdStr", [])
    for index, item in enumerate(ids):
        if _value(item) != song_id:
            continue
        if index < len(values) and isinstance(values[index], dict):
            english = _text(values[index].get("English")).strip()
            if english:
                return english
        if index < len(id_strings):
            return _text(id_strings[index]).strip()
    return ""


def _bundle_name(location: CatalogLocation) -> str | None:
    primary = location.primary_key or ""
    name = primary.split("/", 1)[0]
    if name.lower().endswith(".bundle") and Path(name).name == name:
        return name
    return None


class UnityBundleResolver:
    """Resolve catalog asset locations without scanning unrelated bundles."""

    def __init__(self, paths: GamePaths, catalog: BinaryCatalog, cache_dir: Path | None = None):
        if UnityPy is None:
            raise InfalsusExtractionError(
                "UnityPy is required for bundle extraction; install UnityPy and Pillow"
            ) from UNITYPY_IMPORT_ERROR
        self.paths = paths
        self.catalog = catalog
        self.cache_dir = cache_dir
        self._environments: dict[str, Any] = {}

    def _bundle_path(self, name: str) -> Path:
        if Path(name).name != name or not name.lower().endswith(".bundle"):
            raise InfalsusExtractionError(f"unsafe bundle name from catalog: {name!r}")
        source = self.paths.bundle_root / name
        if not source.is_file():
            raise InfalsusExtractionError(f"catalog references missing bundle: {source}")
        if self.cache_dir is None:
            return source
        destination = self.cache_dir / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        source_hash = _sha256_file(source)
        stamp = destination.with_name(destination.name + ".sha256")
        cached_hash = stamp.read_text(encoding="ascii").strip() if stamp.is_file() else ""
        if not destination.exists() or cached_hash != source_hash:
            shutil.copyfile(source, destination)
            stamp.write_text(source_hash + "\n", encoding="ascii")
        return destination

    def environment(self, name: str) -> Any:
        if name not in self._environments:
            self._environments[name] = UnityPy.load(str(self._bundle_path(name)))
        return self._environments[name]

    def dependency_locations(self, location: CatalogLocation) -> Iterable[CatalogLocation]:
        if location.dependency_set_offset == UINT_MAX:
            return ()
        return (
            self.catalog.location(offset)
            for offset in self.catalog._read_u32_array(location.dependency_set_offset)
        )

    def locate(self, location: CatalogLocation) -> tuple[Any, str]:
        internal_id = location.internal_id
        if not internal_id:
            raise InfalsusExtractionError(f"catalog location {location.offset} has no internal ID")
        for dependency in self.dependency_locations(location):
            bundle_name = _bundle_name(dependency)
            if not bundle_name:
                continue
            environment = self.environment(bundle_name)
            if internal_id not in environment.container:
                continue
            return environment.container[internal_id].deref(), bundle_name
        raise InfalsusExtractionError(
            f"could not resolve catalog asset {location.primary_key!r} internal ID {internal_id!r}"
        )


class InfalsusExtractor:
    """Discover current game data and extract only referenced song artwork."""

    def __init__(self, game_root: str | Path, cache_dir: str | Path | None = None):
        self.paths = resolve_game_paths(game_root)
        self.catalog = BinaryCatalog(self.paths.catalog_path)
        cache = Path(cache_dir).resolve() if cache_dir is not None else None
        self.resolver = UnityBundleResolver(self.paths, self.catalog, cache)
        self.settings = self._read_settings()
        self._song_location: CatalogLocation | None = None
        self._mapping_location: CatalogLocation | None = None
        self._song_data: dict[str, Any] | None = None
        self._mapping_data: dict[str, Any] | None = None

    def _read_settings(self) -> dict[str, Any]:
        if not self.paths.settings_path.is_file():
            return {}
        try:
            return json.loads(self.paths.settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InfalsusExtractionError(f"cannot read Addressables settings: {exc}") from exc

    def _find_location(self, type_name: str) -> CatalogLocation:
        matches: list[CatalogLocation] = []
        seen: set[int] = set()
        for entry in self.catalog.keys:
            for offset in entry.location_offsets:
                if offset in seen:
                    continue
                seen.add(offset)
                location = self.catalog.location(offset)
                if (location.resource_type or "").split(".", 1)[0] == type_name:
                    matches.append(location)
        if not matches:
            raise InfalsusExtractionError(f"could not discover Addressables asset type {type_name}")
        if len(matches) > 1:
            exact = [m for m in matches if (m.primary_key or "").endswith(f"/{type_name}.asset")]
            if len(exact) == 1:
                return exact[0]
        return matches[0]

    def _read_typetree(self, location: CatalogLocation) -> dict[str, Any]:
        obj, _bundle_name_value = self.resolver.locate(location)
        try:
            value = obj.read_typetree()
        except Exception as exc:
            raise InfalsusExtractionError(
                f"could not read typetree for {location.primary_key!r}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise InfalsusExtractionError(f"unexpected typetree for {location.primary_key!r}")
        return value

    @property
    def song_data(self) -> dict[str, Any]:
        if self._song_data is None:
            self._song_location = self._find_location("SongData")
            self._song_data = self._read_typetree(self._song_location)
        return self._song_data

    @property
    def mapping_data(self) -> dict[str, Any]:
        if self._mapping_data is None:
            self._mapping_location = self._find_location("DynamicStringMapping")
            self._mapping_data = self._read_typetree(self._mapping_location)
        return self._mapping_data

    def _location_for_guid(self, guid: str) -> CatalogLocation:
        candidates: list[CatalogLocation] = []
        for entry in self.catalog.keys:
            if entry.key == guid:
                candidates.extend(self.catalog.location(offset) for offset in entry.location_offsets)
        material = [c for c in candidates if (c.resource_type or "").split(".", 1)[0] == "Material"]
        if len(material) != 1:
            raise InfalsusExtractionError(
                f"expected one Material location for Addressables GUID {guid}, got {len(material)}"
            )
        return material[0]

    def _extract_texture(
        self, guid: str, output_path: Path, expected_size: tuple[int, int]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        material_location = self._location_for_guid(guid)
        material_obj, material_bundle = self.resolver.locate(material_location)
        if material_obj.type.name != "Material":
            raise InfalsusExtractionError(
                f"Addressables GUID {guid} resolved to {material_obj.type.name}, not Material"
            )
        material = material_obj.read()
        texture_envs = dict(material.m_SavedProperties.m_TexEnvs)
        main_tex = texture_envs.get("_MainTex")
        if main_tex is None or main_tex.m_Texture.m_PathID == 0:
            raise InfalsusExtractionError(f"Material {material.m_Name!r} has no _MainTex")
        texture_obj = main_tex.m_Texture.deref()
        if texture_obj is None or texture_obj.type.name != "Texture2D":
            raise InfalsusExtractionError(f"Material {material.m_Name!r} _MainTex is not Texture2D")
        texture = texture_obj.read()
        width = int(texture.m_Width)
        height = int(texture.m_Height)
        if (width, height) != expected_size:
            raise InfalsusExtractionError(
                f"{material.m_Name!r} resolved to {width}x{height}, expected {expected_size[0]}x{expected_size[1]}"
            )
        image = texture.image.convert("RGBA")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="PNG")
        format_value = getattr(texture, "m_TextureFormat", None)
        format_name = str(format_value)
        if TextureFormat is not None:
            try:
                format_name = TextureFormat(int(format_value)).name
            except (TypeError, ValueError):
                pass
        return (
            {
                "name": _text(getattr(texture, "m_Name", "")),
                "path_id": int(texture_obj.path_id),
                "width": width,
                "height": height,
                "texture_format": format_name,
                "pixel_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
                "file_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                "file": output_path.name,
            },
            {
                "name": _text(getattr(material, "m_Name", "")),
                "path_id": int(material_obj.path_id),
                "source_bundle": material_bundle,
                "addressables": {
                    "guid": guid,
                    "primary_key": material_location.primary_key,
                    "internal_id": material_location.internal_id,
                },
            },
        )

    def _jacket_reference(self, song: dict[str, Any]) -> dict[str, Any]:
        song_id = int(_value(song.get("Id"), 0))
        song_refs = [
            item
            for item in self.song_data.get("songIdJacketMaterials", [])
            if int(_value(item.get("SongId"), -1)) == song_id
        ]
        if song_refs:
            candidates = song_refs
        else:
            chart_ids = {
                _text(chart.get("Id"))
                for chart in (song.get("ChartInfos", []) or [])
                if _text(chart.get("Id"))
            }
            candidates = [
                item
                for item in self.song_data.get("chartIdJacketMaterials", [])
                if _text(item.get("ChartId")) in chart_ids
            ]
        if not candidates:
            raise InfalsusExtractionError(f"no jacket reference for available song {song_id}")
        pairs = {
            (
                _text(item.get("JacketLargeMaterial", {}).get("m_AssetGUID")),
                _text(item.get("JacketSmallMaterial", {}).get("m_AssetGUID")),
            )
            for item in candidates
        }
        if len(pairs) != 1:
            raise InfalsusExtractionError(f"song {song_id} has inconsistent jacket references")
        large_guid, small_guid = next(iter(pairs))
        if not large_guid or not small_guid:
            raise InfalsusExtractionError(f"song {song_id} has incomplete jacket references")
        return candidates[0]

    def _artwork(self, song: dict[str, Any], output_dir: Path) -> ArtworkResult:
        song_id = int(_value(song.get("Id"), 0))
        base_name = _text(song.get("BaseName"), f"song-{song_id}")
        stem = f"{song_id}-{_slug(base_name)}"
        ref = self._jacket_reference(song)
        large_guid = _text(ref.get("JacketLargeMaterial", {}).get("m_AssetGUID"))
        small_guid = _text(ref.get("JacketSmallMaterial", {}).get("m_AssetGUID"))
        canonical, large_material = self._extract_texture(
            large_guid, output_dir / "canonical" / f"{stem}.png", (2048, 2048)
        )
        small, small_material = self._extract_texture(
            small_guid, output_dir / "previews" / f"{stem}.png", (512, 512)
        )
        return ArtworkResult(
            canonical=canonical,
            small=small,
            addressables={
                "canonical": large_material,
                "small": small_material,
                "identity": f"infalsus:artwork:{song_id}:canonical",
            },
        )

    def discover_songs(self, output_dir: Path | None = None) -> tuple[list[ExtractedSong], list[dict[str, Any]]]:
        song_data = self.song_data
        mapping = self.mapping_data
        titles = mapping.get("songIdTitleTypeMapping", {})
        artists = mapping.get("songIdArtistTypeMapping", {})
        illustrators = mapping.get("jacketIllustratorNameTypeMapping", {})
        songs: list[ExtractedSong] = []
        excluded: list[dict[str, Any]] = []
        for info in song_data.get("allSongInfo", []):
            song_id = int(_value(info.get("Id"), 0))
            base_name = _text(info.get("BaseName"))
            if song_id <= 0 or not base_name:
                continue
            charts = tuple(
                {
                    "chart_id": _text(chart.get("Id")),
                    "available": bool(chart.get("Available")),
                    "difficulty": int(_value(chart.get("Difficulty"), 0)),
                    "rating": int(_value(chart.get("Rating"), 0)),
                    "chart_designer": _text(chart.get("DisplayChartDesigner")) or None,
                    "jacket_designer": _text(chart.get("DisplayJacketDesigner")) or None,
                }
                for chart in (info.get("ChartInfos", []) or [])
                if _text(chart.get("Id"))
            )
            available = any(chart["available"] for chart in charts)
            title = _mapping_lookup(titles, song_id) or base_name
            artist = _mapping_lookup(artists, song_id)
            illustrator = _mapping_lookup(illustrators, song_id) or None
            summary = {
                "identity": f"infalsus:song:{song_id}",
                "song_id": song_id,
                "base_name": base_name,
                "title": title,
                "artist": artist,
                "available": available,
                "jacket_illustrator": illustrator,
            }
            if not available:
                excluded.append({**summary, "reason": "no available chart"})
                continue
            if output_dir is None:
                raise InfalsusExtractionError("output directory is required to extract artwork")
            songs.append(
                ExtractedSong(
                    song_id,
                    base_name,
                    title,
                    artist,
                    available,
                    illustrator,
                    charts,
                    self._artwork(info, output_dir),
                )
            )
        return sorted(songs, key=lambda item: item.song_id), sorted(excluded, key=lambda item: item["song_id"])

    def inspect(self) -> dict[str, Any]:
        available_count = 0
        excluded_rows: list[dict[str, Any]] = []
        for info in self.song_data.get("allSongInfo", []):
            song_id = int(_value(info.get("Id"), 0))
            base_name = _text(info.get("BaseName"))
            if song_id <= 0 or not base_name:
                continue
            available = any(bool(chart.get("Available")) for chart in info.get("ChartInfos", []) or [])
            if available:
                available_count += 1
            else:
                excluded_rows.append({"song_id": song_id, "base_name": base_name})
        sam_root = self.paths.data_root / "StreamingAssets" / "sam"
        return {
            "game_root": str(self.paths.root),
            "catalog": {
                "path": str(self.paths.catalog_path),
                "version": self.catalog.header.version,
                "key_count": len(self.catalog.keys),
            },
            "addressables_version": self.settings.get("m_AddressablesVersion"),
            "bundle_count": sum(1 for path in self.paths.bundle_root.glob("*.bundle")),
            "sam_count": sum(1 for path in sam_root.glob("*") if path.is_file()),
            "song_data_key": self._song_location.primary_key if self._song_location else None,
            "song_count": available_count + len(excluded_rows),
            "available_song_count": available_count,
            "excluded_song_count": len(excluded_rows),
            "excluded_songs": excluded_rows,
        }


def song_to_metadata(song: ExtractedSong) -> dict[str, Any]:
    return {
        "identity": f"infalsus:song:{song.song_id}",
        "song_id": song.song_id,
        "base_name": song.base_name,
        "title": song.title,
        "artist": song.artist,
        "available": song.available,
        "jacket_illustrator": song.jacket_illustrator,
        "charts": list(song.charts),
        "artwork": {
            "identity": song.artwork.addressables["identity"],
            "canonical": song.artwork.canonical,
            "small": song.artwork.small,
            "addressables": song.artwork.addressables,
        },
    }


def _manifest_record(metadata: dict[str, Any]) -> dict[str, Any]:
    canonical = metadata["artwork"]["canonical"]
    artwork = metadata["artwork"]
    return {
        "identity": metadata["identity"],
        "song_id": metadata["song_id"],
        "base_name": metadata["base_name"],
        "title": metadata["title"],
        "artist": metadata["artist"],
        "available": metadata["available"],
        "jacket_illustrator": metadata.get("jacket_illustrator"),
        "charts": metadata.get("charts", []),
        "artwork": {
            "identity": artwork["identity"],
            "pixel_sha256": canonical["pixel_sha256"],
            "width": canonical["width"],
            "height": canonical["height"],
        },
    }


def _manifest_diff(current: list[dict[str, Any]], previous: list[dict[str, Any]] | None) -> dict[str, list[str]]:
    old = {row["identity"]: row for row in (previous or [])}
    new = {row["identity"]: row for row in current}
    modified = sorted(identity for identity in set(new) & set(old) if new[identity] != old[identity])
    unchanged = sorted(set(new) & set(old) - set(modified))
    return {
        "ADDED": sorted(set(new) - set(old)) if previous is not None else sorted(new),
        "MODIFIED": modified,
        "UNCHANGED": unchanged if previous is not None else [],
        "REMOVED": sorted(set(old) - set(new)),
    }


def prepare_publish(
    game_root: str | Path,
    output_dir: str | Path,
    previous_manifest: str | Path | None = None,
) -> dict[str, Any]:
    output = Path(output_dir).expanduser().resolve()
    extractor = InfalsusExtractor(game_root, output.parent / "cache" / "bundles")
    songs, excluded = extractor.discover_songs(output)
    metadata_rows = [song_to_metadata(song) for song in songs]
    for row in metadata_rows:
        _json_dump(output / "metadata" / f"{row['song_id']}-{_slug(row['base_name'])}.json", row)
    _json_dump(output / "metadata" / "excluded.json", {"songs": excluded})
    current_records = [_manifest_record(row) for row in metadata_rows]
    previous_records = None
    if previous_manifest is not None:
        previous_records = json.loads(Path(previous_manifest).read_text(encoding="utf-8")).get("songs", [])
    diff = _manifest_diff(current_records, previous_records)
    manifest = {
        "schemaVersion": 1,
        "game": "infalsus",
        "generatedAt": _utc_now(),
        "source": {
            "product": extractor.paths.root.name,
            "game_root": str(extractor.paths.root),
            "addressables_version": extractor.settings.get("m_AddressablesVersion"),
            "catalog_version": extractor.catalog.header.version,
            "song_data": extractor._song_location.primary_key if extractor._song_location else None,
            "mapping_data": extractor._mapping_location.primary_key if extractor._mapping_location else None,
        },
        "songs": current_records,
        "excludedSongs": excluded,
        "diff": diff,
    }
    manifest_path = output / "manifests" / "infalsus-semantic-manifest.json"
    _json_dump(manifest_path, manifest)
    _json_dump(output / "review" / "infalsus-manifest-diff.json", diff)
    warnings = []
    if excluded:
        warnings.append("unavailable tutorial/residual songs are technical-only and excluded from publish")
    _json_dump(
        output / "review" / "infalsus-review.json",
        {
            "game": "infalsus",
            "available_song_count": len(songs),
            "excluded_song_count": len(excluded),
            "canonical_artwork_count": len(songs),
            "canonical_dimensions": "2048x2048",
            "small_dimensions": "512x512",
            "public_artwork_policy": "canonical only; previews are validation/source variants",
            "diff": diff,
            "warnings": warnings,
        },
    )
    report = [
        "# In Falsus Phase 2 publish report",
        "",
        f"Generated: {manifest['generatedAt']}",
        "",
        f"Available songs: {len(songs)}; excluded unavailable/residual songs: {len(excluded)}.",
        "",
        "| song_id | base_name | title | artist | canonical | pixel_sha256 |",
        "| ---: | --- | --- | --- | --- | --- |",
    ]
    for row in metadata_rows:
        canonical = row["artwork"]["canonical"]
        report.append(
            f"| {row['song_id']} | {row['base_name']} | {row['title']} | {row['artist']} | "
            f"{canonical['width']}x{canonical['height']} | `{canonical['pixel_sha256']}` |"
        )
    report.extend(["", "## Excluded technical songs", ""])
    report.extend(
        [f"- `{row['song_id']}` {row['base_name']}: {row['reason']}" for row in excluded]
        or ["- None"]
    )
    report.extend(
        [
            "",
            "The canonical artwork follows the SongData jacket reference -> Addressables GUID -> Material -> `_MainTex` -> Texture2D chain.",
            "The bundle cache is temporary provenance under `temp/infalsus/cache/bundles`; it is not publishable data.",
        ]
    )
    report_path = output / "INFALSUS_PUBLISH_REPORT.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(report) + "\n", encoding="utf-8")
    return {
        "output": str(output),
        "manifest": str(manifest_path),
        "available_song_count": len(songs),
        "excluded_song_count": len(excluded),
        "canonical_artwork_count": len(songs),
        "diff": diff,
        "songs": metadata_rows,
    }
