"""Canonical remote acquisition and frontend-oriented publish-dataset preparation."""

from __future__ import annotations

import csv
import hashlib
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont

from .asset_list import AssetListResult, parse_asset_list
from .catalog import CatalogResolution, CatalogSnapshot, iter_logical_keys, parse_logical_key, resolve_logical_key
from .model import BundleRequirement, GameVersion
from .patch import PatchList
from .remote import DirectAssetResolver, RemoteBundleRecord
from .semantic import PUBLISH_FAMILIES, build_semantic_catalog, filesystem_id, layout_variant_relation, selected_variant_keys
from .unity_parser import ParsedBundle, UnityBundleParser, choose_export_image


REPORT_FILENAME = "RIZLINE_PUBLISH_DATASET_PREPARATION_REPORT.md"
EXPECTED_COUNTS = {
    "illustration": 144,
    "altIllustration": 6,
    "layout": 68,
    "rizcard": 65,
    "seriesPoster": 30,
    "seriesBanner": 31,
    "avatar.npc": 8,
    "banner": 7,
}
EXCLUDED = (
    "common.", "ui.", "effect.", "shader.", "material.", "font.",
    "localization.", "AssetList", "StaticCardsInfoAsset", "catalog_catalog.json",
)


@dataclass
class AcquiredVariant:
    logical_key: str
    requested_variant: str
    resolved_variant: str | None
    fallback_from: str | None
    status: str
    reason: str | None
    bundle: RemoteBundleRecord | None
    parsed: ParsedBundle | None
    canonical_path: str | None
    preview_path: str | None
    object_metadata: dict[str, Any] | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "logical_key": self.logical_key,
            "requested_variant": self.requested_variant,
            "resolved_variant": self.resolved_variant,
            "fallback_from": self.fallback_from,
            "status": self.status,
            "reason": self.reason,
            "bundle": self.bundle.to_dict() if self.bundle else None,
            "canonical_path": self.canonical_path,
            "preview_path": self.preview_path,
            "object_metadata": self.object_metadata,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_default(value: Any) -> Any:
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if hasattr(value, "__dict__"):
        return value.__dict__
    if isinstance(value, bytes):
        return {"encoding": "hex", "value": value.hex()}
    return str(value)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, default=_json_default) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _write_csv(path: Path, rows: Iterable[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({
                field: json.dumps(row.get(field), ensure_ascii=False)
                if isinstance(row.get(field), (dict, list, tuple))
                else row.get(field)
                for field in fields
            })


def _relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _variant_name(logical_key: str) -> str:
    return "hires" if logical_key.endswith(".HiRes") else "normal"


def _candidate_requirements(resolution: CatalogResolution) -> list[BundleRequirement]:
    source = (resolution.asset.bundle,) if resolution.asset.bundle else resolution.container_candidates
    result: list[BundleRequirement] = []
    seen: set[tuple[str | None, str | None]] = set()
    for requirement in source:
        identity = requirement.bundle_hash, requirement.server_filename
        if identity not in seen:
            seen.add(identity)
            result.append(requirement)
    return result


def _parse_verified_bundle(
    parser: UnityBundleParser,
    record: RemoteBundleRecord,
    object_ids: tuple[str, ...],
) -> tuple[ParsedBundle | None, str | None]:
    if record.verification_status != "VERIFIED" or not record.cache_path:
        return None, record.error or record.verification_status
    try:
        parsed = parser.parse(Path(record.cache_path), object_ids)
    except Exception as exc:
        return None, f"PARSE_FAILED:{type(exc).__name__}:{exc}"
    if object_ids and not any(item in parsed.container_keys for item in object_ids):
        return None, "CATALOG_OBJECT_NOT_IN_CONTAINER"
    return parsed, None


def _object_metadata(parsed: ParsedBundle | None) -> dict[str, Any] | None:
    image = choose_export_image(parsed, require_primary=True) if parsed else None
    if not image:
        return None
    value = image.metadata.to_dict()
    value["is_catalog_primary"] = image.is_primary
    return value


def _export_image(
    parsed: ParsedBundle,
    output: Path,
    asset_id: str,
    category: str,
    variant: str,
    path_claims: dict[str, str],
) -> tuple[str | None, str | None]:
    selected = choose_export_image(parsed, require_primary=True)
    if not selected or selected.image is None:
        return None, None
    category_slug = {
        "Songs / Illustrations": "songs",
        "Special Arts": "special_arts",
        "Rizcard Layout": "rizcard_layouts",
        "Rizcard": "rizcards",
        "Character Assets": "characters",
        "Promotional / Event Visuals": "promotional",
    }.get(category, filesystem_id(category.lower()))
    if category == "Track Series":
        variant_group = "posters" if asset_id.endswith(":poster") else "banners"
        category_slug = f"track_series/{variant_group}"
    stem = f"{filesystem_id(asset_id)}__{variant}"
    canonical = output / "canonical" / category_slug / f"{stem}.png"
    preview = output / "previews" / category_slug / f"{stem}.webp"
    canonical.parent.mkdir(parents=True, exist_ok=True)
    owner = f"{asset_id}:{variant}"
    for target in (canonical, preview):
        relative = _relative(target, output)
        normalized = relative.replace("\\", "/").casefold()
        previous = path_claims.get(normalized)
        if previous is not None and previous != owner:
            raise RuntimeError(
                f"OUTPUT_PATH_COLLISION:{relative}:{previous}:{owner}"
            )
        path_claims[normalized] = owner
    preview.parent.mkdir(parents=True, exist_ok=True)
    selected.image.save(canonical, format="PNG", optimize=True)
    thumbnail = selected.image.copy()
    thumbnail.thumbnail((640, 640), Image.Resampling.LANCZOS)
    if thumbnail.mode not in {"RGB", "RGBA"}:
        thumbnail = thumbnail.convert("RGBA")
    thumbnail.save(preview, format="WEBP", quality=86, method=6)
    return _relative(canonical, output), _relative(preview, output)


def _acquire_resolution(
    resolution: CatalogResolution,
    resolver: DirectAssetResolver,
    parser: UnityBundleParser,
    output: Path,
    asset_id: str,
    category: str,
    path_claims: dict[str, str],
) -> AcquiredVariant:
    logical_key = resolution.asset.logical_key
    requested_variant = resolution.asset.variant
    requirements = _candidate_requirements(resolution)
    if not requirements:
        return AcquiredVariant(
            logical_key, requested_variant, None, None, "FAILED",
            f"PRIMARY_BUNDLE_{resolution.primary_bundle_status}", None, None,
            None, None, None,
        )
    failures: list[str] = []
    for requirement in requirements:
        remote = resolver.acquire(requirement)
        parsed, parse_error = _parse_verified_bundle(
            parser, remote, resolution.asset.object_internal_ids,
        )
        if parsed is None:
            failures.append(
                f"{remote.server_filename}:{parse_error or remote.error or remote.verification_status}"
            )
            continue
        try:
            canonical_path, preview_path = _export_image(
                parsed, output, asset_id, category, requested_variant,
                path_claims,
            )
        except Exception as exc:
            return AcquiredVariant(
                logical_key, requested_variant, requested_variant, None,
                "FAILED",
                f"POSTPROCESS_FAILED:{type(exc).__name__}:{exc}",
                remote, parsed, None, None, _object_metadata(parsed),
            )
        if canonical_path:
            return AcquiredVariant(
                logical_key, requested_variant, requested_variant, None, "SUCCESS",
                None, remote, parsed, canonical_path, preview_path,
                _object_metadata(parsed),
            )
        declared_type = resolution.asset.catalog_declared_type or ""
        no_image_reason = (
            "STATIC_COMPOSITE_NO_CANONICAL_BITMAP"
            if "GameObject" in declared_type or parsed.gameobjects
            else "NO_EXPORTABLE_PRIMARY_IMAGE"
        )
        return AcquiredVariant(
            logical_key, requested_variant, requested_variant, None,
            "REVIEW_REQUIRED", no_image_reason, remote, parsed, None, None, None,
        )
    return AcquiredVariant(
        logical_key, requested_variant, None, None, "FAILED",
        ";".join(failures) or "NO_VERIFIED_CONTAINER", None, None,
        None, None, None,
    )


def _find_asset_list(
    snapshot: CatalogSnapshot,
    resolver: DirectAssetResolver,
) -> tuple[AssetListResult | None, dict[str, Any]]:
    resolution = resolve_logical_key(snapshot, "AssetList")
    evidence: dict[str, Any] = {
        "logical_key": "AssetList",
        "status": "UNRESOLVED",
        "primary_bundle_status": resolution.primary_bundle_status if resolution else None,
        "attempts": [],
    }
    if resolution is None:
        evidence["error"] = "CATALOG_KEY_MISSING"
        return None, evidence
    for requirement in _candidate_requirements(resolution):
        remote = resolver.acquire(requirement)
        evidence["attempts"].append(remote.to_dict())
        if remote.verification_status != "VERIFIED" or not remote.cache_path:
            continue
        try:
            result = parse_asset_list(
                Path(remote.cache_path), resolution.asset.object_internal_ids,
            )
        except Exception as exc:
            evidence.setdefault("parse_errors", []).append(
                f"{type(exc).__name__}:{exc}"
            )
            continue
        evidence.update({
            "status": result.status,
            "selected_bundle": remote.to_dict(),
            "object_internal_ids": list(resolution.asset.object_internal_ids),
            "object_internal_id": result.object_internal_id,
            "object_path_id": result.object_path_id,
        })
        return result, evidence
    evidence["error"] = "REMOTE_ASSET_LIST_UNRESOLVED"
    return None, evidence


def _load_resume_rows(
    output: Path,
    version: GameVersion,
    snapshot: CatalogSnapshot,
    catalog_evidence: dict[str, Any],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    rows: dict[tuple[str, str, str], dict[str, Any]] = {}
    manifest_directory = output / "manifests"
    for path in (
        manifest_directory / "acquisition_manifest.json",
        manifest_directory / "acquisition_manifest.checkpoint.json",
    ):
        if not path.is_file():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        saved_version = value.get("game_version") or {}
        saved_catalog = value.get("acquisition_catalog") or {}
        if (
            value.get("schema_version") != "rizline.acquisition-manifest.v1"
            or saved_version.get("apk_sha256") != version.apk_sha256
            or saved_catalog.get("sha256") != catalog_evidence.get("sha256")
        ):
            continue
        for row in value.get("records", []):
            if not isinstance(row, dict):
                continue
            key = (
                str(row.get("asset_id") or ""),
                str(row.get("logical_key") or ""),
                str(row.get("requested_variant") or ""),
            )
            if (
                all(key)
                and row.get("catalog_build_hash") == snapshot.build_hash
                and row.get("acquisition_status") == "SUCCESS"
                and row.get("parse_status") == "SUCCESS"
                and not row.get("variant_fallback")
            ):
                rows[key] = row
    return rows


def _verified_output_image(
    output: Path,
    relative: str,
    *,
    suffix: str,
    decoded_sha256: str | None = None,
) -> Path | None:
    try:
        path = (output / relative).resolve()
        path.relative_to(output.resolve())
        if path.suffix.lower() != suffix or not path.is_file():
            return None
        with Image.open(path) as source:
            source.load()
            if decoded_sha256:
                actual = hashlib.sha256(source.convert("RGBA").tobytes()).hexdigest()
                if actual != decoded_sha256:
                    return None
        return path
    except (OSError, ValueError):
        return None


def _resume_acquired_variant(
    row: dict[str, Any],
    resolution: CatalogResolution,
    resolver: DirectAssetResolver,
    output: Path,
    path_claims: dict[str, str],
) -> AcquiredVariant | None:
    canonical_relative = row.get("canonical_path")
    preview_relative = row.get("preview_path")
    if not isinstance(canonical_relative, str) or not isinstance(preview_relative, str):
        return None
    canonical = _verified_output_image(
        output, canonical_relative, suffix=".png",
        decoded_sha256=row.get("decoded_sha256"),
    )
    preview = _verified_output_image(output, preview_relative, suffix=".webp")
    if canonical is None or preview is None:
        return None
    requirements = _candidate_requirements(resolution)
    requirement = next(
        (
            item for item in requirements
            if item.bundle_hash == row.get("bundle_hash")
            and DirectAssetResolver.server_filename(item) == row.get("server_filename")
        ),
        None,
    )
    if requirement is None:
        return None
    remote = resolver.acquire(requirement)
    if (
        remote.verification_status != "VERIFIED"
        or remote.bundle_sha256 != row.get("bundle_sha256")
        or remote.selected_resource_version != row.get("selected_resource_version")
    ):
        return None
    owner = f"{row.get('asset_id')}:{row.get('requested_variant')}"
    for relative in (canonical_relative, preview_relative):
        normalized = relative.replace("\\", "/").casefold()
        previous = path_claims.get(normalized)
        if previous is not None and previous != owner:
            return None
        path_claims[normalized] = owner
    object_metadata = {
        name: row.get(name)
        for name in (
            "resolved_object_type", "object_name", "object_path_id", "width",
            "height", "texture_format", "has_alpha", "decoded_sha256", "phash",
        )
    }
    object_metadata["is_catalog_primary"] = True
    return AcquiredVariant(
        logical_key=str(row["logical_key"]),
        requested_variant=str(row["requested_variant"]),
        resolved_variant=str(row.get("variant") or row["requested_variant"]),
        fallback_from=None,
        status="SUCCESS",
        reason=None,
        bundle=remote,
        parsed=None,
        canonical_path=canonical_relative,
        preview_path=preview_relative,
        object_metadata=object_metadata,
    )


def _write_acquisition_manifest(
    output: Path,
    version: GameVersion,
    patch_list: PatchList,
    catalog_evidence: dict[str, Any],
    asset_list_evidence: dict[str, Any],
    rows: list[dict[str, Any]],
    *,
    checkpoint: bool,
) -> None:
    manifest_directory = output / "manifests"
    checkpoint_path = manifest_directory / "acquisition_manifest.checkpoint.json"
    path = checkpoint_path if checkpoint else manifest_directory / "acquisition_manifest.json"
    _write_json(path, {
        "schema_version": "rizline.acquisition-manifest.v1",
        "generated_at": _now(),
        "checkpoint": checkpoint,
        "game_version": version.to_dict(),
        "patch_list": patch_list.to_dict(),
        "acquisition_catalog": catalog_evidence,
        "asset_list_evidence": asset_list_evidence,
        "records": rows,
    })
    if not checkpoint:
        checkpoint_path.unlink(missing_ok=True)



def _contact_sheet(
    output: Path,
    title: str,
    paths: list[tuple[str, str]],
    filename: str,
) -> str | None:
    loaded: list[tuple[str, str, Image.Image]] = []
    for label, relative_path in paths:
        try:
            with Image.open(output / relative_path) as source:
                loaded.append((label, relative_path, source.convert("RGBA")))
        except Exception:
            continue
    if not loaded:
        return None
    paths = [(label, relative_path) for label, relative_path, _image in loaded]
    cell_w, cell_h, header = 220, 250, 52
    columns = min(5, max(1, len(paths)))
    rows = (len(paths) + columns - 1) // columns
    canvas = Image.new("RGB", (columns * cell_w, header + rows * cell_h), "#15171b")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((14, 18), title, fill="white", font=font)
    for index, (label, relative_path, image) in enumerate(loaded):
        image.thumbnail((196, 196), Image.Resampling.LANCZOS)
        x = (index % columns) * cell_w + (cell_w - image.width) // 2
        y = header + (index // columns) * cell_h + 8
        background = Image.new("RGBA", image.size, "#242830")
        background.alpha_composite(image)
        canvas.paste(background.convert("RGB"), (x, y))
        text = label if len(label) <= 30 else label[:27] + "..."
        draw.text(
            ((index % columns) * cell_w + 8, header + (index // columns) * cell_h + 214),
            text, fill="#e5e7eb", font=font,
        )
    target = output / "contact_sheets" / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(target, format="WEBP", quality=88, method=6)
    return _relative(target, output)



def _reconcile_generated_files(
    output: Path,
    acquisition_rows: list[dict[str, Any]],
    contact_sheets: list[str],
) -> list[str]:
    """Remove only stale files in tool-managed image directories."""

    allowed = {
        str(value).replace("\\", "/").casefold()
        for row in acquisition_rows
        for value in (row.get("canonical_path"), row.get("preview_path"))
        if value
    }
    allowed.update(path.replace("\\", "/").casefold() for path in contact_sheets)
    removed: list[str] = []
    scans = (
        (output / "canonical", "*.png"),
        (output / "previews", "*.webp"),
        (output / "contact_sheets", "*.webp"),
    )
    for directory, pattern in scans:
        for path in directory.rglob(pattern):
            relative = _relative(path, output)
            if relative.replace("\\", "/").casefold() not in allowed:
                path.unlink()
                removed.append(relative)
    return sorted(removed)


def _apply_high_confidence_series_pairing(
    semantic: list[dict[str, Any]],
) -> int:
    """Pair poster/banner only when both decoded primary object names agree."""

    by_family_id = {
        (item["asset_family"], item["semantic_id"]): item
        for item in semantic
        if item["asset_family"] in {"seriesPoster", "seriesBanner"}
    }
    poster_ids = {
        semantic_id
        for family, semantic_id in by_family_id
        if family == "seriesPoster"
    }
    banner_ids = {
        semantic_id
        for family, semantic_id in by_family_id
        if family == "seriesBanner"
    }
    paired = 0
    for semantic_id in sorted(poster_ids & banner_ids):
        poster = by_family_id[("seriesPoster", semantic_id)]
        banner = by_family_id[("seriesBanner", semantic_id)]
        poster_names = {
            (asset.get("object") or {}).get("object_name")
            for asset in poster.get("canonical_assets", [])
        }
        banner_names = {
            (asset.get("object") or {}).get("object_name")
            for asset in banner.get("canonical_assets", [])
        }
        if poster_names != {semantic_id} or banner_names != {semantic_id}:
            continue
        series_id = f"rizline:track-series:{semantic_id}"
        evidence = {
            "method": "EXACT_DECODED_PRIMARY_OBJECT_NAME_MATCH",
            "poster_object_name": semantic_id,
            "banner_object_name": semantic_id,
            "confidence": "HIGH",
        }
        for record in (poster, banner):
            record["series_id"] = series_id
            record["series_pairing_evidence"] = evidence
            record.setdefault("metadata", {})["series_id"] = series_id
        paired += 1
    return paired

def _build_report(
    output: Path,
    version: GameVersion,
    catalog_evidence: dict[str, Any],
    patch_list: PatchList,
    semantic: list[dict[str, Any]],
    acquisition_rows: list[dict[str, Any]],
    asset_list_evidence: dict[str, Any],
    contact_sheets: list[str],
    asset_list: AssetListResult | None,
    excluded_count: int,
    stale_removed: list[str],
) -> None:
    by_family: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in semantic:
        by_family[record["asset_family"]].append(record)
    family_labels = {
        "illustration": "Songs",
        "altIllustration": "Special Arts",
        "rizcard": "Rizcard",
        "layout": "Rizcard Layout",
        "seriesPoster": "Track Series Poster",
        "seriesBanner": "Track Series Banner",
        "avatar.npc": "Character Assets",
        "banner": "Promotional",
    }
    lines = [
        "# Rizline canonical publish-dataset preparation report",

        f"Generated: {_now()}",
        "",
        "## Provenance and safety",
        "",
        "- Production payload source: REMOTE_CANONICAL only.",
        "- Formal Remote Resolver is implemented with declared PatchList mapping, serial fetches, conservative retry/resume, SHA sidecars, cache-root containment, and no URL guessing.",
        "- Runtime cache was not used as a canonical payload source.",
        f"- APK version: {version.version_name} ({version.version_code}).",
        f"- APK SHA-256: {version.apk_sha256}.",
        f"- Embedded APK catalog SHA-256: {version.catalog_sha256}.",
        f"- Remote acquisition catalog SHA-256: {catalog_evidence.get('sha256')}.",
        f"- Remote acquisition catalog resource version: {catalog_evidence.get('selected_resource_version')}.",
        f"- Patch chain status: {patch_list.status}; declared layers: {len(patch_list.chain)}; mapped files: {len(patch_list.file_to_version)}.",
        f"- AssetList parse status: {asset_list_evidence.get('status')}.",
        "- No website/public asset directory was modified and no publish/upload action was performed.",
        "",
        "## Readiness by semantic family",
        "",
        "| Category | Semantic | Metadata Ready | Canonical Ready | Review | Publish Candidate |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for family in EXPECTED_COUNTS:
        records = by_family.get(family, [])
        canonical = sum(bool(item.get("canonical_assets")) for item in records)
        metadata_ready = sum(item.get("metadata_status") == "COMPLETE" for item in records)
        review = sum(item.get("publish_status") != "READY_CANDIDATE" for item in records)
        publish_candidate = sum(item.get("publish_status") == "READY_CANDIDATE" for item in records)
        lines.append(
            f"| {family_labels[family]} | {len(records)} | {metadata_ready} | {canonical} | {review} | {publish_candidate} |"
        )
    status_counts = Counter(row.get("acquisition_status") for row in acquisition_rows)
    source_counts = Counter(
        row.get("download_status") for row in acquisition_rows if row.get("download_status")
    )
    canonical_files = list((output / "canonical").rglob("*.png"))
    preview_files = list((output / "previews").rglob("*.webp"))
    bytes_total = sum(path.stat().st_size for path in canonical_files)
    layout_relations = Counter(
        item.get("variant_relation", {}).get("relation")
        for item in by_family.get("layout", []) if item.get("variant_relation")
    )
    preview_bytes = sum(path.stat().st_size for path in preview_files)
    fallback_count = sum(
        bool(asset.get("fallback_from"))
        for record in semantic for asset in record.get("canonical_assets", [])
    )
    unique_bundles = {
        row.get("bundle_sha256") for row in acquisition_rows
        if row.get("bundle_sha256")
    }
    http_success = sum(row.get("http_status") in {200, 206} for row in acquisition_rows)
    http_failed = sum(
        row.get("http_status") not in {None, 200, 206}
        or "HTTP_" in str(row.get("error") or "")
        for row in acquisition_rows
    )
    parse_counts = Counter(row.get("parse_status") for row in acquisition_rows)
    requested_semantic = sum(
        item.get("acquisition_status") != "NOT_REQUESTED" for item in semantic
    )
    canonical_exported = sum(bool(row.get("canonical_path")) for row in acquisition_rows)
    review_count = sum(item.get("publish_status") != "READY_CANDIDATE" for item in semantic)
    publish_count = sum(item.get("publish_status") == "READY_CANDIDATE" for item in semantic)
    unresolved_count = sum(
        item.get("metadata_status") != "COMPLETE" or not item.get("display_name")
        for item in semantic
    )
    hires_songs = sum(
        row.get("asset_family") == "illustration"
        and row.get("requested_variant") == "hires"
        and row.get("acquisition_status") == "SUCCESS"
        for row in acquisition_rows
    )
    rizcard_subtypes = Counter(
        item.get("subtype") for item in by_family.get("rizcard", [])
    )
    grouped_series = {
        item.get("series_id") for family in ("seriesPoster", "seriesBanner")
        for item in by_family.get(family, []) if item.get("series_id")
    }
    field_counts = {
        name: len(value) if isinstance(value, list) else int(value is not None)
        for name, value in (asset_list.fields.items() if asset_list else [])
        if name in {
            "levels", "discOLevels", "musics", "illustrations",
            "altIllustrationInfos", "charts", "layoutColors", "discs",
            "specialLevels", "seriesConfigs",
        }
    }
    lines.extend([
        "",
        "## Acquisition statistics",
        "",
        f"- Requested semantic assets: {requested_semantic}; unique verified bundles: {len(unique_bundles)}.",
        f"- Acquisition attempts by outcome: {dict(status_counts)}.",
        f"- Remote bundle outcomes: {dict(source_counts)}.",
        f"- HTTP success: {http_success}; HTTP failed: {http_failed}.",
        f"- Unity parse success/partial/failed/not-attempted: {dict(parse_counts)}.",
        f"- Canonical exported variants: {canonical_exported}; review required: {review_count}; excluded catalog keys: {excluded_count}.",
        f"- Canonical PNG files: {len(canonical_files)} ({bytes_total:,} bytes).",
        f"- Preview WebP files: {len(preview_files)} ({preview_bytes:,} bytes).",
        f"- HiRes song-illustration coverage: {hires_songs}/{len(by_family.get('illustration', []))}; fallbacks: {fallback_count}.",
        f"- Layout variant relations: {dict(layout_relations)}.",
        f"- Stale generated files reconciled: {len(stale_removed)}.",
        "",
        "## Metadata and category findings",
        "",
        f"- Default.asset / AssetList fields obtained: {field_counts}.",
        "- Website-facing metadata includes stable IDs, display names, song/artist/illustrator, character, series, layout, variant dimensions, provenance, review, publish, and copyright states where evidenced.",
        f"- Songs: {len(by_family.get('illustration', []))} semantic records; {sum(item.get('metadata_status') == 'COMPLETE' for item in by_family.get('illustration', []))} metadata-complete.",
        f"- Special Arts: {len(by_family.get('altIllustration', []))} semantic records; {sum(item.get('metadata_status') == 'COMPLETE' for item in by_family.get('altIllustration', []))} metadata-complete.",
        f"- Rizcard Layout: {len(by_family.get('layout', []))} semantic records with both variants retained when available; relations {dict(layout_relations)}.",
        f"- Rizcard classification: {dict(rizcard_subtypes)}. Exact catalog-key to configured-card intersection remains unresolved; component evidence is retained and no runtime composite is presented as static art.",
        f"- Track Series: {len(by_family.get('seriesPoster', []))} posters and {len(by_family.get('seriesBanner', []))} banners; high-confidence exact primary-object-name groups: {len(grouped_series)}. Unmatched poster/banner numbering is not guessed.",
        f"- Character assets: {len(by_family.get('avatar.npc', []))}; metadata-ready {sum(item.get('metadata_status') == 'COMPLETE' for item in by_family.get('avatar.npc', []))}; canonical-ready {sum(bool(item.get('canonical_assets')) for item in by_family.get('avatar.npc', []))}.",
        f"- Promotional / other visuals: {len(by_family.get('banner', []))}; canonical-ready {sum(bool(item.get('canonical_assets')) for item in by_family.get('banner', []))}; runtime-composed items remain review-only.",
        "",
        "## Publish and review",
        "",
        f"- Frontend manifest semantic records: {len(semantic)}; READY_CANDIDATE: {publish_count}.",
        f"- Review queue: {review_count}; unresolved metadata rows: {unresolved_count}.",
        "- The nine prior CACHE_UNMAPPED HIGH_VALUE_UNKNOWN census items remain REFERENCE_ONLY. No runtime-cache payload was copied into this dataset.",
        "",
        "## Dataset artifacts",
        "",
        "- metadata/rizline_semantic_catalog.json: stable semantic inventory.",
        "- metadata/asset_list.json: parsed Default.asset/AssetList evidence.",
        "- manifests/acquisition_manifest.json: remote acquisition evidence.",
        "- manifests/rizline_publish_manifest.json: frontend candidate categories and assets.",
        "- review/*.csv: unresolved metadata, failures, variants, exclusions, and review queue.",
        "- canonical/ and previews/: remote-canonical images and previews.",
    ])
    if contact_sheets:
        lines.extend(["", "## Contact sheets", ""])
        lines.extend(f"- {path}" for path in contact_sheets)
    lines.extend([
        "",
        "## Explicit exclusions",
        "",
        "Technical/common UI, effects, shaders, materials, fonts, localization payloads, and AssetList/config objects are excluded. Composite Rizcard GameObjects are classified and queued for review; they are not presented as rendered static artwork.",
        "",
        f"- Actual excluded catalog-key inventory contains {excluded_count} rows in review/excluded_assets.csv.",
        "- Default exclusions cover SDK/debug UI, font atlases, masks/noise/LUTs, shaders/particles, generic UI, login/anti-addiction assets, and other technical/configuration keys.",
        "",
        "## Remaining before website integration",
        "",
        "- Human copyright/publication approval is still required.",
        "- Rizcard runtime composites need authoritative component-to-config joins or an official static render before they can become page artwork.",
        "- Track Series needs authoritative names and poster/banner pairing for records not linked by AssetList.",
        "- Layout, character, and promotional records remain review-only under this phase's conservative page-readiness policy; metadata-incomplete subsets need further curation.",
        "- The website adapter, page wiring, public-file copy, deployment, and upload are intentionally outside this phase.",
        "",
        "## Readiness interpretation",
        "",
        "READY_CANDIDATE is limited to clearly identified Songs, Special Arts, or high-confidence Track Series assets with verified remote provenance, decoded canonical imagery, and complete metadata. It does not mean copyright or publication approval. REVIEW_REQUIRED and failed rows remain visible instead of being silently dropped.",
        "",
    ])
    (output / REPORT_FILENAME).write_text("\n".join(lines), encoding="utf-8")




def acquire_asset_list_metadata(
    version: GameVersion,
    snapshot: CatalogSnapshot,
    resolver: DirectAssetResolver,
    catalog_evidence: dict[str, Any],
    output: Path,
) -> dict[str, Any]:
    """Acquire only the catalog-declared AssetList bundle and map metadata."""

    output.mkdir(parents=True, exist_ok=True)
    asset_list, evidence = _find_asset_list(snapshot, resolver)
    semantic = build_semantic_catalog(snapshot, version.version_name, asset_list)
    _write_json(output / "metadata" / "asset_list.json", {
        "schema_version": "rizline.asset-list.v1",
        "game_version": version.to_dict(),
        "acquisition_catalog": catalog_evidence,
        "evidence": evidence,
        "asset_list": asset_list.to_dict() if asset_list else None,
    })
    _write_json(output / "metadata" / "rizline_semantic_catalog.json", {
        "schema_version": "rizline.semantic-catalog.v1",
        "generated_at": _now(),
        "game_version": version.to_dict(),
        "acquisition_catalog": catalog_evidence,
        "production_payload_source": "REMOTE_CANONICAL",
        "records": semantic,
    })
    return {
        "asset_list_status": evidence.get("status"),
        "semantic_records": len(semantic),
        "asset_list_json": str((output / "metadata" / "asset_list.json").resolve()),
        "semantic_catalog_json": str(
            (output / "metadata" / "rizline_semantic_catalog.json").resolve()
        ),
    }

def prepare_publish_dataset(
    version: GameVersion,
    snapshot: CatalogSnapshot,
    patch_list: PatchList,
    resolver: DirectAssetResolver,
    catalog_evidence: dict[str, Any],
    output: Path,
) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    for directory in (
        "metadata", "manifests", "review", "canonical", "previews", "contact_sheets",
    ):
        (output / directory).mkdir(parents=True, exist_ok=True)

    parser = UnityBundleParser()
    asset_list, asset_list_evidence = _find_asset_list(snapshot, resolver)
    _write_json(output / "metadata" / "asset_list.json", {
        "schema_version": "rizline.asset-list.v1",
        "game_version": version.to_dict(),
        "acquisition_catalog": catalog_evidence,
        "evidence": asset_list_evidence,
        "asset_list": asset_list.to_dict() if asset_list else None,
    })

    semantic = build_semantic_catalog(snapshot, version.version_name, asset_list)
    acquisition_rows: list[dict[str, Any]] = []
    canonical_by_category: dict[str, list[tuple[str, str]]] = defaultdict(list)
    path_claims: dict[str, str] = {}
    resume_rows = _load_resume_rows(
        output, version, snapshot, catalog_evidence,
    )

    for record_index, record in enumerate(semantic, start=1):
        acquired: list[AcquiredVariant] = []
        for logical_key in selected_variant_keys(record):
            resolution = resolve_logical_key(snapshot, logical_key)
            if resolution is None:
                acquired.append(AcquiredVariant(
                    logical_key, _variant_name(logical_key), None, None, "FAILED",
                    "CATALOG_KEY_UNRESOLVED", None, None, None, None, None,
                ))
                continue
            resume_key = (
                record["asset_id"], logical_key, _variant_name(logical_key),
            )
            prior_row = resume_rows.get(resume_key)
            if prior_row is not None:
                resumed = _resume_acquired_variant(
                    prior_row, resolution, resolver, output, path_claims,
                )
                if resumed is not None:
                    acquired.append(resumed)
                    continue
            result = _acquire_resolution(
                resolution, resolver, parser, output,
                record["asset_id"], record["category"], path_claims,
            )
            if result.status == "FAILED" and record["asset_family"] in {
                "illustration", "altIllustration",
            } and logical_key.endswith(".HiRes"):
                fallback_key = logical_key.removesuffix(".HiRes")
                fallback_resolution = resolve_logical_key(snapshot, fallback_key)
                if fallback_resolution:
                    fallback = _acquire_resolution(
                        fallback_resolution, resolver, parser, output,
                        record["asset_id"], record["category"], path_claims,
                    )
                    fallback.logical_key = logical_key
                    fallback.requested_variant = "hires"
                    fallback.fallback_from = "hires"
                    if fallback.status == "SUCCESS":
                        fallback.reason = f"FALLBACK_AFTER:{result.reason}"
                        result = fallback
            acquired.append(result)

        images_by_variant: dict[str, Image.Image] = {}
        phash_by_variant: dict[str, str | None] = {}
        for item in acquired:
            bundle = item.bundle.to_dict() if item.bundle else {}
            object_metadata = item.object_metadata or {}
            row = {
                "asset_id": record["asset_id"],
                "asset_family": record["asset_family"],
                "semantic_id": record["semantic_id"],
                "logical_key": item.logical_key,
                "variant": item.resolved_variant or item.requested_variant,
                "requested_variant": item.requested_variant,
                "variant_fallback": bool(item.fallback_from),
                "catalog_build_hash": snapshot.build_hash,
                "dependency_key": bundle.get("dependency_key"),
                "bundle_hash": bundle.get("bundle_hash"),
                "bundle_name": bundle.get("bundle_name"),
                "server_filename": bundle.get("server_filename"),
                "selected_resource_version": bundle.get("selected_resource_version"),
                "patch_mapping_source": bundle.get("patch_mapping_source"),
                "remote_url": bundle.get("remote_url"),
                "expected_size": bundle.get("expected_size"),
                "downloaded_size": bundle.get("downloaded_size"),
                "bundle_sha256": bundle.get("bundle_sha256"),
                "unity_header": bundle.get("unity_header"),
                "crc_status": bundle.get("crc_status"),
                "http_status": bundle.get("http_status"),
                "download_status": bundle.get("download_status"),
                "resolved_object_type": object_metadata.get("resolved_object_type"),
                "object_name": object_metadata.get("object_name"),
                "object_path_id": object_metadata.get("object_path_id"),
                "width": object_metadata.get("width"),
                "height": object_metadata.get("height"),
                "texture_format": object_metadata.get("texture_format"),
                "has_alpha": object_metadata.get("has_alpha"),
                "decoded_sha256": object_metadata.get("decoded_sha256"),
                "phash": object_metadata.get("phash"),
                "object_counts": item.parsed.object_counts if item.parsed else None,
                "gameobjects": item.parsed.gameobjects if item.parsed else None,
                "container_keys": item.parsed.container_keys if item.parsed else None,
                "parse_failures": item.parsed.parse_failures if item.parsed else None,
                "acquisition_status": item.status,
                "parse_status": (
                    "SUCCESS" if item.status == "SUCCESS"
                    else "PARTIAL" if item.parsed is not None
                    else "NOT_ATTEMPTED" if item.bundle is None
                    else "FAILED"
                ),
                "payload_source": "REMOTE_CANONICAL" if item.bundle else None,
                "canonical_path": item.canonical_path,
                "preview_path": item.preview_path,
                "error": item.reason or bundle.get("error"),
            }
            acquisition_rows.append(row)
            if item.canonical_path:
                try:
                    with Image.open(output / item.canonical_path) as source:
                        source.load()
                        images_by_variant[item.resolved_variant or item.requested_variant] = source.copy()
                except Exception as exc:
                    reason = f"CANONICAL_REOPEN_FAILED:{type(exc).__name__}:{exc}"
                    item.status = "FAILED"
                    item.reason = reason
                    item.canonical_path = None
                    item.preview_path = None
                    row.update({
                        "acquisition_status": "FAILED",
                        "parse_status": "FAILED",
                        "canonical_path": None,
                        "preview_path": None,
                        "error": reason,
                    })
                else:
                    canonical_by_category[record["category"]].append(
                        (record.get("display_name") or record["semantic_id"], item.preview_path or item.canonical_path)
                    )
                    phash_by_variant[item.resolved_variant or item.requested_variant] = (
                        item.object_metadata or {}
                    ).get("phash")

        successful = [item for item in acquired if item.canonical_path]
        record["canonical_assets"] = [
            {
                "logical_key": item.logical_key,
                "variant": item.resolved_variant,
                "fallback_from": item.fallback_from,
                "canonical_path": item.canonical_path,
                "preview_path": item.preview_path,
                "object": item.object_metadata,
                "bundle_sha256": item.bundle.bundle_sha256 if item.bundle else None,
                "resource_version": item.bundle.selected_resource_version if item.bundle else None,
                "source": "REMOTE_CANONICAL",
            }
            for item in successful
        ]
        statuses = {item.status for item in acquired}
        record["component_evidence"] = [
            {
                "logical_key": item.logical_key,
                "object_counts": item.parsed.object_counts,
                "gameobjects": item.parsed.gameobjects,
                "parse_failures": item.parsed.parse_failures,
            }
            for item in acquired
            if item.parsed and item.parsed.gameobjects
        ]
        record["acquisition_status"] = (
            "SUCCESS" if statuses == {"SUCCESS"}
            else "PARTIAL" if successful
            else "REVIEW_REQUIRED" if "REVIEW_REQUIRED" in statuses
            else "FAILED"
        )
        record["publish_status"] = (
            "READY_CANDIDATE"
            if record["acquisition_status"] == "SUCCESS"
            and record.get("metadata_status") == "COMPLETE"
            and record["asset_family"] in {"illustration", "altIllustration", "seriesPoster", "seriesBanner"}
            else "REVIEW_REQUIRED"
        )
        record["review_status"] = "PENDING"
        record["acquisition_notes"] = [
            {"logical_key": item.logical_key, "status": item.status, "reason": item.reason}
            for item in acquired if item.status != "SUCCESS" or item.reason
        ]
        if record["asset_family"] == "layout":
            if "normal" in images_by_variant and "hires" in images_by_variant:
                record["variant_relation"] = layout_variant_relation(
                    images_by_variant["normal"], images_by_variant["hires"],
                    phash_by_variant.get("normal"), phash_by_variant.get("hires"),
                )
            else:
                record["variant_relation"] = {
                    "relation": "UNKNOWN",
                    "same_aspect_ratio": None,
                    "phash_distance": None,
                    "resize_mae": None,
                    "aspect_ratio_delta": None,
                    "reason": "ONE_OR_BOTH_VARIANTS_UNAVAILABLE",
                }

        if record_index % 10 == 0:
            _write_acquisition_manifest(
                output, version, patch_list, catalog_evidence,
                asset_list_evidence, acquisition_rows, checkpoint=True,
            )

    _apply_high_confidence_series_pairing(semantic)


    canonical_claims: dict[str, list[str]] = defaultdict(list)
    for row in acquisition_rows:
        if row.get("canonical_path"):
            canonical_claims[str(row["canonical_path"])].append(
                f"{row.get('asset_id')}:{row.get('logical_key')}"
            )
    duplicate_paths = {
        path: claims
        for path, claims in canonical_claims.items()
        if len(set(claims)) > 1
    }
    if duplicate_paths:
        raise RuntimeError(
            "CANONICAL_PATH_COLLISION:"
            + json.dumps(duplicate_paths, ensure_ascii=False, sort_keys=True)
        )


    _write_json(output / "metadata" / "rizline_semantic_catalog.json", {
        "schema_version": "rizline.semantic-catalog.v1",
        "generated_at": _now(),
        "game_version": version.to_dict(),
        "acquisition_catalog": catalog_evidence,
        "production_payload_source": "REMOTE_CANONICAL",
        "records": semantic,
    })
    _write_acquisition_manifest(
        output, version, patch_list, catalog_evidence,
        asset_list_evidence, acquisition_rows, checkpoint=False,
    )
    publish_assets = []
    for record in semantic:
        variants = []
        for item in record.get("canonical_assets", []):
            object_metadata = item.get("object") or {}
            variants.append({
                "name": item.get("variant"),
                "fallback_from": item.get("fallback_from"),
                "width": object_metadata.get("width"),
                "height": object_metadata.get("height"),
                "has_alpha": object_metadata.get("has_alpha"),
                "download_file": item.get("canonical_path"),
                "preview_file": item.get("preview_path"),
                "decoded_sha256": object_metadata.get("decoded_sha256"),
            })
        preferred_variant = None
        if variants:
            if record["asset_family"] in {"illustration", "altIllustration"}:
                preferred_variant = variants[0]["name"]
            elif record["asset_family"] == "layout":
                relation = (record.get("variant_relation") or {}).get("relation")
                preferred_variant = "hires" if relation == "SAME_VISUAL_HIGHER_RES" else None
            else:
                preferred_variant = variants[0]["name"]
        publish_assets.append({
            "id": record["asset_id"],
            "category": record["category"],
            "subtype": record["subtype"],
            "display_name": record.get("display_name"),
            "original_name": record["semantic_id"],
            "song": ({
                "id": record.get("song_id"),
                "title": record.get("song_title"),
            } if record.get("song_id") or record.get("song_title") else None),
            "music_artist": record.get("music_artist"),
            "illustrator": record.get("illustrator"),
            "character": ({
                "id": record.get("character_id"),
                "name": record.get("character_name"),
            } if record.get("character_id") or record.get("character_name") else None),
            "track_series": ({
                "id": record.get("series_id"),
                "name": record.get("series_name"),
            } if record.get("series_id") or record.get("series_name") else None),
            "layout_id": record.get("layout_id"),
            "rizcard_id": record.get("rizcard_id"),
            "variants": variants,
            "preferred_variant": preferred_variant,
            "variant_relation": record.get("variant_relation"),
            "source_game_version": version.version_name,
            "review_status": record.get("review_status"),
            "publish_status": record.get("publish_status"),
            "copyright_status": record.get("copyright_status"),
            "notes": record.get("notes") or record.get("acquisition_notes"),
        })
    category_counts = Counter(item["category"] for item in publish_assets)
    _write_json(output / "manifests" / "rizline_publish_manifest.json", {
        "schema_version": "rizline.publish-manifest.v1",
        "game": "rizline",
        "generated_at": _now(),
        "generated_from": {
            "game_version": version.version_name,
            "apk_sha256": version.apk_sha256,
            "catalog_build_hash": snapshot.build_hash,
            "catalog_sha256": catalog_evidence.get("sha256"),
            "resource_version": catalog_evidence.get("selected_resource_version"),
        },
        "categories": [
            {
                "id": filesystem_id(category.lower()),
                "name": category,
                "asset_count": count,
            }
            for category, count in sorted(category_counts.items())
        ],
        "assets": publish_assets,
    })

    review_queue = [
        {
            "asset_id": item["asset_id"], "asset_family": item["asset_family"],
            "display_name": item.get("display_name"),
            "publish_status": item.get("publish_status"),
            "acquisition_status": item.get("acquisition_status"),
            "metadata_status": item.get("metadata_status"),
            "copyright_status": item.get("copyright_status"),
            "reason": item.get("acquisition_notes") or item.get("notes"),
        }
        for item in semantic if item.get("publish_status") != "READY_CANDIDATE"
    ]
    unresolved_metadata = [
        {
            "asset_id": item["asset_id"], "asset_family": item["asset_family"],
            "semantic_id": item["semantic_id"],
            "missing_fields": [
                field for field in (
                    "display_name",
                    "song_id" if item["asset_family"] == "illustration" else None,
                    "series_id" if item["asset_family"] in {"seriesPoster", "seriesBanner"} else None,
                    "character_name" if item["asset_family"] == "avatar.npc" else None,
                ) if field and not item.get(field)
            ],
            "metadata_source": item.get("metadata_source"),
        }
        for item in semantic
        if item.get("metadata_status") != "COMPLETE" or not item.get("display_name")
    ]
    failed = [row for row in acquisition_rows if row.get("acquisition_status") != "SUCCESS"]
    variants = [
        {"asset_id": item["asset_id"], "semantic_id": item["semantic_id"], **item.get("variant_relation", {})}
        for item in semantic if item["asset_family"] == "layout"
    ]
    published_keys = {
        key for item in semantic for key in item.get("logical_keys", [])
    }
    excluded = []
    for key in iter_logical_keys(snapshot):
        if key in published_keys:
            continue
        family = parse_logical_key(key)[0]
        resolution = resolve_logical_key(snapshot, key)
        declared_type = (
            resolution.asset.catalog_declared_type if resolution else None
        )
        reason = (
            "ADDRESSABLES_DEPENDENCY_OR_BUNDLE_KEY"
            if key.endswith(".bundle") or key.isdigit()
            else "OUT_OF_SCOPE_TECHNICAL_OR_CONFIGURATION_KEY"
        )
        excluded.append({
            "key_or_prefix": key,
            "family": family,
            "resource_type": declared_type,
            "reason": reason,
            "policy": "EXCLUDED",
            "reference_count": None,
        })
    excluded.append({
        "key_or_prefix": "prior-census:CACHE_UNMAPPED_HIGH_VALUE_UNKNOWN",
        "family": "HIGH_VALUE_UNKNOWN",
        "resource_type": None,
        "reason": "NO_CANONICAL_CATALOG_MAPPING;RUNTIME_CACHE_NOT_A_PRODUCTION_SOURCE",
        "policy": "REFERENCE_ONLY",
        "reference_count": 9,
    })
    _write_csv(
        output / "review" / "review_queue.csv", review_queue,
        ["asset_id", "asset_family", "display_name", "publish_status", "acquisition_status", "metadata_status", "copyright_status", "reason"],
    )
    _write_csv(
        output / "review" / "unresolved_metadata.csv", unresolved_metadata,
        ["asset_id", "asset_family", "semantic_id", "missing_fields", "metadata_source"],
    )
    _write_csv(
        output / "review" / "failed_acquisition.csv", failed,
        ["asset_id", "asset_family", "semantic_id", "logical_key", "requested_variant", "variant", "acquisition_status", "parse_status", "selected_resource_version", "remote_url", "http_status", "error"],
    )
    _write_csv(
        output / "review" / "variant_review.csv", variants,
        ["asset_id", "semantic_id", "relation", "same_aspect_ratio", "aspect_ratio_delta", "phash_distance", "resize_mae", "reason"],
    )
    _write_csv(
        output / "review" / "excluded_assets.csv", excluded,
        ["key_or_prefix", "family", "resource_type", "reason", "policy", "reference_count"],
    )

    contact_sheets = []
    for category, rows in sorted(canonical_by_category.items()):
        if category not in {
            "Rizcard Layout", "Rizcard", "Character Assets",
            "Promotional / Event Visuals",
        }:
            continue
        try:
            result = _contact_sheet(
                output, category, rows, f"{filesystem_id(category.lower())}.webp",
            )
        except Exception:
            result = None
        if result:
            contact_sheets.append(result)
    stale_removed = _reconcile_generated_files(
        output, acquisition_rows, contact_sheets,
    )
    excluded_count = sum(item["policy"] == "EXCLUDED" for item in excluded)
    _build_report(
        output, version, catalog_evidence, patch_list, semantic, acquisition_rows,
        asset_list_evidence, contact_sheets, asset_list, excluded_count,
        stale_removed,
    )
    return {
        "output": str(output.resolve()),
        "report": str((output / REPORT_FILENAME).resolve()),
        "semantic_records": len(semantic),
        "acquisition_attempts": len(acquisition_rows),
        "canonical_png": len(list((output / "canonical").rglob("*.png"))),
        "preview_webp": len(list((output / "previews").rglob("*.webp"))),
        "publish_status": dict(Counter(item.get("publish_status") for item in semantic)),
        "acquisition_status": dict(Counter(item.get("acquisition_status") for item in semantic)),
        "patch_chain_status": patch_list.status,
        "asset_list_status": asset_list_evidence.get("status"),
    }
