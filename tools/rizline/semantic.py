"""Player-facing Rizline semantic catalog and variant policies."""

from __future__ import annotations

import re
import hashlib
from collections import defaultdict
from typing import Any, Iterable

from PIL import Image, ImageChops, ImageStat

from .asset_list import (
    AssetListResult,
    layout_metadata,
    song_metadata,
    special_art_metadata,
    static_card_metadata,
)
from .catalog import CatalogSnapshot, iter_logical_keys, parse_logical_key, resolve_logical_key


PUBLISH_FAMILIES = (
    "illustration",
    "altIllustration",
    "layout",
    "rizcard",
    "seriesPoster",
    "seriesBanner",
    "avatar.npc",
    "banner",
)


CATEGORY_BY_FAMILY = {
    "illustration": ("Songs / Illustrations", "SONG_ILLUSTRATION"),
    "altIllustration": ("Special Arts", "SPECIAL_ART"),
    "layout": ("Rizcard Layout", "RIZCARD_LAYOUT"),
    "rizcard": ("Rizcard", "UNKNOWN"),
    "seriesPoster": ("Track Series", "POSTER"),
    "seriesBanner": ("Track Series", "BANNER"),
    "avatar.npc": ("Character Assets", "CHARACTER_AVATAR"),
    "banner": ("Promotional / Event Visuals", "OTHER_OFFICIAL_VISUAL"),
}


def stable_asset_id(family: str, semantic_id: str) -> str:
    kind = {
        "illustration": "illustration",
        "altIllustration": "special-art",
        "layout": "layout",
        "rizcard": "rizcard",
        "seriesPoster": "series",
        "seriesBanner": "series",
        "avatar.npc": "character",
        "banner": "promotional",
    }.get(family, family.lower())
    suffix = ":poster" if family == "seriesPoster" else ":banner" if family == "seriesBanner" else ""
    return f"rizline:{kind}:{semantic_id}{suffix}"


def filesystem_id(asset_id: str) -> str:
    value = re.sub(r"[^0-9A-Za-z._-]+", "-", asset_id).strip("-.")
    value = value or "rizline-asset"
    if any(ord(character) > 127 for character in asset_id):
        digest = hashlib.sha256(asset_id.encode("utf-8")).hexdigest()[:10]
        value = f"{value}-{digest}"
    return value


def _replacement_map(result: AssetListResult | None) -> dict[str, str]:
    mapping: dict[str, str] = {}
    if result is None:
        return mapping
    for group in result.fields.get("resourceReplacements", []) or []:
        if not isinstance(group, dict):
            continue
        for pair in group.get("pairs", []) or []:
            if isinstance(pair, dict) and pair.get("oldKey") and pair.get("newKey"):
                mapping[str(pair["newKey"])] = str(pair["oldKey"])
    return mapping


def _series_relations(result: AssetListResult | None) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    if result is None:
        return {}, {}
    levels_by_index: dict[str, list[str]] = defaultdict(list)
    for level in result.fields.get("levels", []) or []:
        if isinstance(level, dict) and level.get("seriesIndex") not in (None, -1):
            levels_by_index[str(level["seriesIndex"])].append(str(level.get("id")))
    relations: dict[str, dict[str, Any]] = {}
    poster_to_index: dict[str, str] = {}
    for config in result.fields.get("seriesConfigs", []) or []:
        if not isinstance(config, dict) or config.get("seriesIndex") is None:
            continue
        index = str(config["seriesIndex"])
        resolved = result.resolved_series_posters.get(index, {})
        poster_name = resolved.get("object_name")
        if isinstance(poster_name, str) and poster_name.startswith("seriesPoster."):
            poster_to_index[poster_name] = index
        relations[index] = {
            "series_id": index,
            "display_name": None,
            "poster_logical_key": poster_name if isinstance(poster_name, str) and poster_name.startswith("seriesPoster.") else None,
            "related_songs": sorted(filter(None, levels_by_index.get(index, []))),
            "related_layouts": sorted({
                str(item.get("itemId"))
                for item in config.get("preOrderMetaConfig", {}).get("attachments", [])
                if isinstance(item, dict) and str(item.get("itemId", "")).startswith("layout.")
            }),
            "collaboration": None,
        }
    return relations, poster_to_index


def classify_rizcard(
    logical_key: str,
    cards: dict[str, dict[str, Any]],
    catalog_declared_type: str | None = None,
) -> tuple[str, str]:
    if logical_key in cards:
        avatar = str(cards[logical_key].get("avatar_key") or "")
        return (
            "CHARACTER_RIZCARD"
            if avatar.startswith("avatar.npc.")
            else "PARTIAL_COMPOSITE",
            "COMPOSITE",
        )
    semantic_id = logical_key.removeprefix("rizcard.")
    if semantic_id == "Default":
        return "RIZCARD_TEMPLATE", "COMPOSITE"
    if "Tutorial" in semantic_id:
        return "RIZCARD_TUTORIAL", "COMPOSITE"
    if "GameObject" in (catalog_declared_type or ""):
        return "PARTIAL_COMPOSITE", "COMPOSITE"
    if semantic_id.startswith("Static"):
        return "STATIC_CARD_ART", "STATIC_ONLY"
    if catalog_declared_type:
        return "RIZCARD_COMPONENT", "PARTIAL"
    return "UNKNOWN", "UNKNOWN"


def _promotional_subtype(semantic_id: str) -> str:
    lower = semantic_id.lower()
    if "unlock" in lower:
        return "UNLOCK_VISUAL"
    if "event" in lower:
        return "EVENT_BANNER"
    if "poster" in lower:
        return "PROMOTIONAL_POSTER"
    return "OTHER_OFFICIAL_VISUAL"


def build_semantic_catalog(
    snapshot: CatalogSnapshot,
    game_version: str | None,
    asset_list: AssetListResult | None,
) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    for key in iter_logical_keys(snapshot, PUBLISH_FAMILIES):
        family, semantic_id, _variant, _language = parse_logical_key(key)
        groups[(family, semantic_id)].append(key)

    songs = song_metadata(asset_list) if asset_list else {}
    special_arts = special_art_metadata(asset_list) if asset_list else {}
    layouts = layout_metadata(asset_list) if asset_list else {}
    cards = static_card_metadata(asset_list) if asset_list else {}
    replacements = _replacement_map(asset_list)
    series_relations, poster_to_index = _series_relations(asset_list)
    character_names = {
        str(card.get("avatar_key")): card.get("character_name")
        for card in cards.values()
        if str(card.get("avatar_key") or "").startswith("avatar.npc.")
    }

    records: list[dict[str, Any]] = []
    for (family, semantic_id), logical_keys in sorted(groups.items()):
        category, subtype = CATEGORY_BY_FAMILY[family]
        variants = []
        for logical_key in sorted(logical_keys, key=lambda item: (parse_logical_key(item)[2] != "normal", item)):
            resolution = resolve_logical_key(snapshot, logical_key)
            variants.append({
                "logical_key": logical_key,
                "variant": parse_logical_key(logical_key)[2],
                "catalog_declared_type": resolution.asset.catalog_declared_type if resolution else None,
                "primary_bundle_status": resolution.primary_bundle_status if resolution else "UNRESOLVED",
            })

        base_key = next((item for item in logical_keys if parse_logical_key(item)[2] == "normal"), logical_keys[0])
        metadata_key = replacements.get(base_key, base_key)
        metadata: dict[str, Any] = {}
        metadata_verified = False
        completeness = "COMPLETE"
        if family == "illustration":
            metadata = dict(songs.get(metadata_key, {}))
            metadata_verified = metadata_key in songs
        elif family == "altIllustration":
            metadata = dict(special_arts.get(metadata_key, {}))
            metadata_verified = metadata_key in special_arts
        elif family == "layout":
            metadata = dict(layouts.get(metadata_key, {}))
            metadata_verified = metadata_key in layouts
            metadata.setdefault("display_name", None)
            if not metadata.get("display_name"):
                metadata["display_name"] = f"Layout {semantic_id}"
        elif family == "rizcard":
            declared_type = "|".join(
                str(item.get("catalog_declared_type") or "") for item in variants
            )
            subtype, completeness = classify_rizcard(base_key, cards, declared_type)
            metadata = dict(cards.get(base_key, {}))
            metadata_verified = base_key in cards
            if not metadata_verified and cards:
                metadata["configured_card_join"] = {
                    "status": "UNRESOLVED",
                    "method": "exact_logical_key_only",
                    "catalog_logical_key": base_key,
                    "configured_card_count": len(cards),
                    "reason": "NO_EXACT_CARD_ID_MATCH",
                }
        elif family in {"seriesPoster", "seriesBanner"}:
            poster_key = base_key if family == "seriesPoster" else f"seriesPoster.{semantic_id}"
            series_index = poster_to_index.get(poster_key)
            metadata = dict(series_relations.get(series_index or "", {}))
            metadata.setdefault("internal_series_id", semantic_id)
            metadata.setdefault("series_id", series_index)
            metadata_verified = series_index is not None
        elif family == "avatar.npc":
            character_name = character_names.get(base_key)
            metadata = {
                "character_id": semantic_id,
                "character_name": character_name,
                "asset_type": "avatar",
            }
            metadata_verified = bool(character_name)
        elif family == "banner":
            subtype = _promotional_subtype(semantic_id)

        metadata_source = "Default.asset/AssetList" if metadata_verified else "Addressables catalog"
        metadata_confidence = "HIGH" if metadata_verified else "MEDIUM"
        metadata_status = "COMPLETE" if metadata_verified else "INCOMPLETE"
        display_name = metadata.get("display_name") or metadata.get("song_title") or metadata.get("character_name")
        if family == "illustration" and metadata:
            display_name = metadata.get("song_title")
        ready = family in {"illustration", "altIllustration"} and bool(display_name)
        if family in {"seriesPoster", "seriesBanner"}:
            ready = bool(metadata.get("series_id"))
        copyright_status = "THIRD_PARTY_CREDIT_PRESENT" if "©" in str(metadata.get("illustrator") or "") else "UNREVIEWED"

        record = {
            "game": "rizline",
            "game_version": game_version,
            "asset_id": stable_asset_id(family, semantic_id),
            "asset_family": family,
            "semantic_id": semantic_id,
            "category": category,
            "subtype": subtype,
            "logical_keys": sorted(logical_keys),
            "variants": variants,
            "display_name": display_name,
            "song_id": metadata.get("song_id"),
            "song_title": metadata.get("song_title"),
            "music_artist": metadata.get("music_artist"),
            "illustrator": metadata.get("illustrator"),
            "character_id": metadata.get("character_id") or metadata.get("avatar_key"),
            "character_name": metadata.get("character_name"),
            "series_id": metadata.get("series_id"),
            "series_name": metadata.get("display_name") if family in {"seriesPoster", "seriesBanner"} else None,
            "layout_id": metadata.get("layout_id") or metadata.get("layout_key"),
            "rizcard_id": metadata.get("rizcard_id"),
            "metadata": metadata,
            "metadata_source": metadata_source,
            "metadata_confidence": metadata_confidence,
            "metadata_status": metadata_status,
            "semantic_completeness": completeness,
            "publication_candidate": "HIGH" if family in {"illustration", "altIllustration", "seriesPoster", "seriesBanner"} else "MEDIUM",
            "review_status": "REVIEW_REQUIRED",
            "publish_status": "READY_CANDIDATE" if ready else "REVIEW_REQUIRED",
            "copyright_status": copyright_status,
            "notes": [],
        }
        records.append(record)
    return records


def selected_variant_keys(record: dict[str, Any]) -> list[str]:
    variants = {item["variant"]: item["logical_key"] for item in record.get("variants", [])}
    if record.get("asset_family") == "layout":
        return [variants[name] for name in ("normal", "hires") if name in variants]
    if record.get("asset_family") in {"illustration", "altIllustration"}:
        return [variants.get("hires") or variants.get("normal")] if variants else []
    return [variants["normal"]] if "normal" in variants else list(variants.values())[:1]


def phash_distance(first: str | None, second: str | None) -> int | None:
    if not first or not second:
        return None
    try:
        return (int(first, 16) ^ int(second, 16)).bit_count()
    except ValueError:
        return None


def layout_variant_relation(normal: Image.Image, hires: Image.Image, normal_phash: str | None, hires_phash: str | None) -> dict[str, Any]:
    same_aspect = normal.width * hires.height == normal.height * hires.width
    normal_aspect = normal.width / normal.height
    hires_aspect = hires.width / hires.height
    aspect_delta = abs(normal_aspect - hires_aspect) / max(normal_aspect, hires_aspect)
    resized = hires.convert("RGBA").resize(normal.size, Image.Resampling.LANCZOS)
    difference = ImageChops.difference(normal.convert("RGBA"), resized)
    mae = sum(ImageStat.Stat(difference).mean) / 4.0
    distance = phash_distance(normal_phash, hires_phash)
    # Sprite border trimming can produce a small decoded-aspect mismatch even
    # when the visual and untrimmed canvas are the same. Require converging
    # pHash, resize-MAE, and aspect evidence before preferring HiRes.
    if (
        distance is not None
        and distance <= 4
        and mae <= 8.0
        and aspect_delta <= 0.03
    ):
        relation = "SAME_VISUAL_HIGHER_RES"
    elif (
        distance is not None
        and distance > 8
        and mae > 15.0
    ):
        relation = "VISUAL_VARIATION"
    else:
        relation = "UNKNOWN"
    return {
        "relation": relation,
        "same_aspect_ratio": same_aspect,
        "aspect_ratio_delta": aspect_delta,
        "phash_distance": distance,
        "resize_mae": mae,
    }
