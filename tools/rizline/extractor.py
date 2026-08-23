"""Semantic selection, HiRes fallback, parsing, and conservative export."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .catalog import CatalogResolution, CatalogSnapshot, iter_logical_keys, parse_logical_key, resolve_logical_key
from .manifest import write_manifest
from .model import ExtractedAsset, GameVersion, Payload, PayloadStatus, ParseStatus, SemanticCompleteness
from .resolver import RuntimeCacheResolver
from .unity_parser import ParsedBundle, UnityBundleParser, choose_export_image, safe_filename


PREFERRED_HIRES_FAMILIES = {"illustration", "layout", "altIllustration"}


@dataclass
class AssetSelection:
    preferred: CatalogResolution
    preferred_payload: Payload
    resolved: CatalogResolution | None
    resolved_payload: Payload
    preferred_variant: str
    resolved_variant: str | None
    variant_fallback: bool
    fallback_reason: str | None


def _unresolved_payload(source: str = "runtime_cache") -> Payload:
    return Payload(
        source=source,
        path=None,
        sha256=None,
        size=None,
        unity_signature=None,
        match_status="MISSING",
        payload_status=PayloadStatus.UNRESOLVED,
        version_attribution=None,
        notes=("bundle_requirement_unresolved",),
    )


def _family_from_resolution(resolution: CatalogResolution) -> str:
    return resolution.asset.asset_family


def _selection_groups(snapshot: CatalogSnapshot, families: Iterable[str] | None, keys: Iterable[str] | None) -> list[list[CatalogResolution]]:
    allowed_families = set(families) if families else None
    requested_keys = set(keys or ())
    resolutions: dict[str, CatalogResolution] = {}
    for logical_key in iter_logical_keys(snapshot, allowed_families):
        resolution = resolve_logical_key(snapshot, logical_key)
        if resolution is not None:
            resolutions[logical_key] = resolution

    if requested_keys:
        requested_groups = {(*parse_logical_key(key)[:2], parse_logical_key(key)[3]) for key in requested_keys}
        resolutions = {
            key: resolution
            for key, resolution in resolutions.items()
            if key in requested_keys or (*parse_logical_key(key)[:2], parse_logical_key(key)[3]) in requested_groups
        }

    groups: dict[tuple[str, str, str | None], list[CatalogResolution]] = {}
    for resolution in resolutions.values():
        asset = resolution.asset
        groups.setdefault((asset.asset_family, asset.semantic_id, asset.language), []).append(resolution)
    return [sorted(group, key=lambda item: (item.asset.variant != "hires", item.asset.logical_key)) for group in sorted(groups.values(), key=lambda group: group[0].asset.logical_key)]


def _payload_for(resolution: CatalogResolution, resolver: RuntimeCacheResolver, cache: dict[tuple[str | None, str | None], Payload]) -> Payload:
    requirement = resolution.asset.bundle
    if requirement is None:
        return _unresolved_payload()
    cache_key = (requirement.bundle_name, requirement.bundle_hash)
    if cache_key not in cache:
        cache[cache_key] = resolver.resolve(requirement)
    return cache[cache_key]


def build_selections(
    snapshot: CatalogSnapshot,
    resolver: RuntimeCacheResolver,
    *,
    families: Iterable[str] | None = None,
    keys: Iterable[str] | None = None,
    prefer_hires: bool = False,
) -> list[AssetSelection]:
    payload_cache: dict[tuple[str | None, str | None], Payload] = {}
    requested_variants: dict[tuple[str, str, str | None], set[str]] = {}
    for key in keys or ():
        family, semantic_id, variant, language = parse_logical_key(key)
        requested_variants.setdefault((family, semantic_id, language), set()).add(variant)
    selections: list[AssetSelection] = []
    for group in _selection_groups(snapshot, families, keys):
        family = group[0].asset.asset_family
        group_identity = (group[0].asset.asset_family, group[0].asset.semantic_id, group[0].asset.language)
        explicit_hires = requested_variants.get(group_identity) == {"hires"}
        preferred_variant = "hires" if (prefer_hires and family in PREFERRED_HIRES_FAMILIES) or explicit_hires else "normal"
        preferred = next((item for item in group if item.asset.variant == preferred_variant), group[0])
        preferred_payload = _payload_for(preferred, resolver, payload_cache)
        resolved = preferred
        resolved_payload = preferred_payload
        fallback = False
        fallback_reason = None

        if prefer_hires and preferred_variant == "hires" and preferred_payload.payload_status != PayloadStatus.FOUND:
            normal = next((item for item in group if item.asset.variant == "normal"), None)
            if normal is not None:
                normal_payload = _payload_for(normal, resolver, payload_cache)
                if normal_payload.payload_status == PayloadStatus.FOUND:
                    resolved = normal
                    resolved_payload = normal_payload
                    fallback = True
                    fallback_reason = "payload_unavailable"
        selections.append(
            AssetSelection(
                preferred=preferred,
                preferred_payload=preferred_payload,
                resolved=resolved if resolved_payload.payload_status == PayloadStatus.FOUND else None,
                resolved_payload=resolved_payload,
                preferred_variant=preferred_variant,
                resolved_variant=resolved.asset.variant if resolved_payload.payload_status == PayloadStatus.FOUND else None,
                variant_fallback=fallback,
                fallback_reason=fallback_reason,
            )
        )
    return selections


def _asset_directory(family: str, variant: str | None) -> str:
    if family == "illustration":
        return "illustrations_hires" if variant == "hires" else "illustrations"
    return {
        "seriesPoster": "series_posters",
        "seriesBanner": "series_banners",
        "avatar.npc": "avatars",
        "rizcard": "rizcards",
        "layout": "layouts",
        "altIllustration": "illustrations_hires" if variant == "hires" else "illustrations",
        "banner": "partial",
    }.get(family, "unknown")


def _semantic_completeness(family: str, has_image: bool) -> str:
    if family == "rizcard":
        return SemanticCompleteness.STATIC_ONLY.value if has_image else SemanticCompleteness.PARTIAL.value
    if family == "banner":
        return SemanticCompleteness.PARTIAL.value
    if has_image:
        return SemanticCompleteness.COMPLETE.value
    return SemanticCompleteness.UNKNOWN.value


def _make_record(
    version: GameVersion,
    selection: AssetSelection,
    *,
    parsed: ParsedBundle | None,
    export_path: str | None,
    dry_run: bool,
) -> ExtractedAsset:
    preferred_asset = selection.preferred.asset
    resolved_asset = selection.resolved.asset if selection.resolved is not None else preferred_asset
    requirement = resolved_asset.bundle
    preferred_requirement = preferred_asset.bundle
    payload = selection.resolved_payload
    selected_image = choose_export_image(parsed) if parsed is not None else None
    metadata = selected_image.metadata if selected_image is not None else None

    if dry_run:
        parse_status = ParseStatus.NOT_ATTEMPTED.value
    elif payload.payload_status != PayloadStatus.FOUND:
        parse_status = ParseStatus.NOT_ATTEMPTED.value
    elif parsed is None:
        parse_status = ParseStatus.FAILED.value
    elif selected_image is not None:
        parse_status = ParseStatus.PARTIAL.value if parsed.parse_failures or parsed.sprite_atlases else ParseStatus.SUCCESS.value
    else:
        parse_status = ParseStatus.PARTIAL.value if preferred_asset.asset_family == "banner" or "GameObject" in (preferred_asset.catalog_declared_type or "") or parsed.gameobjects or parsed.parse_failures else ParseStatus.FAILED.value

    notes: list[str] = list(payload.notes)
    if selection.variant_fallback and selection.fallback_reason:
        notes.append(f"variant_fallback:{selection.fallback_reason}")
    if preferred_asset.catalog_declared_type and "GameObject" in preferred_asset.catalog_declared_type:
        notes.append("catalog_declared_type_preserved; static object resolution does not imply complete GameObject rendering")
    if parsed is not None and parsed.sprite_atlases:
        notes.append("SPRITE_ATLAS_DETECTED_UNSUPPORTED")
    if parsed is not None and parsed.parse_failures:
        notes.append(f"parse_failures={len(parsed.parse_failures)}")

    return ExtractedAsset(
        game=version.game,
        package_name=version.package_name,
        game_version=version.version_name,
        version_code=version.version_code,
        apk_sha256=version.apk_sha256,
        catalog_sha256=version.catalog_sha256,
        catalog_build_hash=version.catalog_build_hash,
        asset_family=preferred_asset.asset_family,
        logical_key=preferred_asset.logical_key,
        semantic_id=preferred_asset.semantic_id,
        variant=preferred_asset.variant,
        language=preferred_asset.language,
        catalog_declared_type=preferred_asset.catalog_declared_type,
        dependency_key=requirement.dependency_key if requirement else None,
        bundle_name=requirement.bundle_name if requirement else None,
        bundle_hash=requirement.bundle_hash if requirement else None,
        bundle_size=requirement.bundle_size if requirement else None,
        crc=requirement.crc if requirement else None,
        internal_id=requirement.internal_id if requirement else None,
        preferred_dependency_key=preferred_requirement.dependency_key if preferred_requirement else None,
        preferred_bundle_name=preferred_requirement.bundle_name if preferred_requirement else None,
        preferred_bundle_hash=preferred_requirement.bundle_hash if preferred_requirement else None,
        preferred_bundle_size=preferred_requirement.bundle_size if preferred_requirement else None,
        preferred_crc=preferred_requirement.crc if preferred_requirement else None,
        preferred_internal_id=preferred_requirement.internal_id if preferred_requirement else None,
        payload_source=payload.source if payload.path else None,
        payload_path=payload.path,
        payload_sha256=payload.sha256,
        payload_status=payload.payload_status.value,
        payload_match_status=payload.match_status,
        version_attribution=payload.version_attribution,
        parse_status=parse_status,
        resolved_object_type=metadata.resolved_object_type if metadata else None,
        object_name=metadata.object_name if metadata else None,
        object_path_id=metadata.object_path_id if metadata else None,
        width=metadata.width if metadata else None,
        height=metadata.height if metadata else None,
        texture_format=metadata.texture_format if metadata else None,
        has_alpha=metadata.has_alpha if metadata else None,
        mipmap_count=metadata.mipmap_count if metadata else None,
        sprite_rect=metadata.sprite_rect if metadata else None,
        sprite_pivot=metadata.sprite_pivot if metadata else None,
        sprite_full_texture=metadata.sprite_full_texture if metadata else None,
        decoded_sha256=metadata.decoded_sha256 if metadata else None,
        phash=metadata.phash if metadata else None,
        preferred_variant=selection.preferred_variant,
        resolved_variant=selection.resolved_variant,
        variant_fallback=selection.variant_fallback,
        fallback_reason=selection.fallback_reason,
        publication_candidate=preferred_asset.publication_candidate,
        review_status="PENDING",
        semantic_completeness=_semantic_completeness(preferred_asset.asset_family, selected_image is not None),
        export_path=export_path,
        notes="; ".join(notes) if notes else None,
    )


def extract_assets(
    version: GameVersion,
    snapshot: CatalogSnapshot,
    resolver: RuntimeCacheResolver,
    output_dir: Path,
    *,
    families: Iterable[str] | None = None,
    keys: Iterable[str] | None = None,
    prefer_hires: bool = False,
    dry_run: bool = False,
) -> list[ExtractedAsset]:
    selections = build_selections(snapshot, resolver, families=families, keys=keys, prefer_hires=prefer_hires)
    parser = UnityBundleParser()
    parsed_cache: dict[tuple[str | None, str | None], ParsedBundle] = {}
    assets: list[ExtractedAsset] = []

    for selection in selections:
        parsed = None
        export_path = None
        payload = selection.resolved_payload
        requirement = selection.resolved.asset.bundle if selection.resolved is not None and selection.resolved.asset.bundle else selection.preferred.asset.bundle
        cache_key = (requirement.bundle_name, requirement.bundle_hash) if requirement else (None, None)
        if not dry_run and payload.payload_status == PayloadStatus.FOUND and payload.path:
            if cache_key not in parsed_cache:
                try:
                    parsed_cache[cache_key] = parser.parse(Path(payload.path))
                except Exception as exc:
                    parsed_cache[cache_key] = ParsedBundle(unity_version=None, object_counts={}, parse_failures=[{"stage": "load_bundle", "error": f"{type(exc).__name__}: {exc}"}])
            parsed = parsed_cache[cache_key]
            image = choose_export_image(parsed)
            if image is not None and image.image is not None:
                resolved_variant = selection.resolved_variant or selection.preferred_variant
                relative = Path("exports") / _asset_directory(selection.preferred.asset.asset_family, resolved_variant) / f"{safe_filename(selection.preferred.asset.asset_family)}__{safe_filename(selection.preferred.asset.semantic_id)}__{resolved_variant}.png"
                target = output_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                image.image.save(target, format="PNG")
                export_path = relative.as_posix()
        assets.append(_make_record(version, selection, parsed=parsed, export_path=export_path, dry_run=dry_run))

    write_manifest(output_dir, version, assets)
    return assets
