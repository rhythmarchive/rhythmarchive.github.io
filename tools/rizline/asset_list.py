"""Default.asset / AssetList extraction and player-facing metadata mapping."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import UnityPy
except ImportError:  # pragma: no cover
    UnityPy = None


class AssetListError(RuntimeError):
    pass


@dataclass
class AssetListResult:
    status: str
    object_name: str | None
    object_path_id: int | None
    object_internal_id: str | None
    fields: dict[str, Any]
    static_cards: dict[str, Any] | None
    resolved_series_posters: dict[str, dict[str, Any]]
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "object_name": self.object_name,
            "object_path_id": self.object_path_id,
            "object_internal_id": self.object_internal_id,
            "fields": self.fields,
            "static_cards": self.static_cards,
            "resolved_series_posters": self.resolved_series_posters,
            "notes": self.notes,
        }


def _path_id(pointer: Any) -> int | None:
    if not isinstance(pointer, dict):
        return None
    value = pointer.get("m_PathID")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _reader_name(reader: Any) -> str | None:
    try:
        data = reader.read()
        name = getattr(data, "m_Name", None)
        return str(name) if name is not None else None
    except Exception:
        return None


def parse_asset_list(bundle_path: Path, object_internal_ids: Iterable[str]) -> AssetListResult:
    if UnityPy is None:
        raise AssetListError("UNITYPY_NOT_INSTALLED")
    environment = UnityPy.load(str(bundle_path))
    container = getattr(environment, "container", {})
    reader = None
    matched_internal_id = None
    for internal_id in object_internal_ids:
        if internal_id in container:
            reader = container[internal_id]
            matched_internal_id = internal_id
            break
    if reader is None:
        candidates = []
        for obj in environment.objects:
            if getattr(getattr(obj, "type", None), "name", "") != "MonoBehaviour":
                continue
            try:
                tree = obj.read_typetree()
            except Exception:
                continue
            if tree.get("m_Name") == "Default" and "musics" in tree and "illustrations" in tree:
                candidates.append((obj, tree))
        if len(candidates) != 1:
            raise AssetListError(f"ASSET_LIST_OBJECT_UNRESOLVED:{len(candidates)}")
        reader, fields = candidates[0]
    else:
        fields = reader.read_typetree()

    required = {"levels", "musics", "illustrations", "charts", "layoutColors", "discs"}
    missing = sorted(required - set(fields))
    notes = [f"missing_field:{name}" for name in missing]
    object_map = {int(obj.path_id): obj for obj in environment.objects}

    static_cards = None
    static_pointer = _path_id(fields.get("staticCardsInfoAsset"))
    if static_pointer and static_pointer in object_map:
        try:
            static_cards = object_map[static_pointer].read_typetree()
        except Exception as exc:
            notes.append(f"static_cards_parse_failed:{type(exc).__name__}:{exc}")
    elif static_pointer:
        notes.append(f"static_cards_pointer_unresolved:{static_pointer}")

    resolved_series_posters: dict[str, dict[str, Any]] = {}
    for config in fields.get("seriesConfigs", []) or []:
        if not isinstance(config, dict):
            continue
        poster_path_id = _path_id(config.get("poster"))
        if not poster_path_id or poster_path_id not in object_map:
            continue
        poster_reader = object_map[poster_path_id]
        resolved_series_posters[str(config.get("seriesIndex"))] = {
            "object_path_id": poster_path_id,
            "object_type": getattr(getattr(poster_reader, "type", None), "name", None),
            "object_name": _reader_name(poster_reader),
        }

    return AssetListResult(
        status="SUCCESS" if not missing else "PARTIAL",
        object_name=str(fields.get("m_Name")) if fields.get("m_Name") is not None else None,
        object_path_id=int(reader.path_id),
        object_internal_id=matched_internal_id,
        fields=fields,
        static_cards=static_cards,
        resolved_series_posters=resolved_series_posters,
        notes=notes,
    )


def _indexed(items: Iterable[dict[str, Any]], key: str = "id") -> dict[str, dict[str, Any]]:
    return {str(item[key]): item for item in items if isinstance(item, dict) and item.get(key) is not None}


def song_metadata(result: AssetListResult) -> dict[str, dict[str, Any]]:
    fields = result.fields
    musics = _indexed(fields.get("musics", []))
    illustrations = _indexed(fields.get("illustrations", []))
    discs = _indexed(fields.get("discs", []), "name")
    rows: dict[str, dict[str, Any]] = {}
    levels = list(fields.get("levels", []) or []) + list(fields.get("discOLevels", []) or [])
    for level in levels:
        if not isinstance(level, dict) or not level.get("illustrationId"):
            continue
        logical_key = str(level["illustrationId"])
        music = musics.get(str(level.get("musicId")), {})
        illustration = illustrations.get(logical_key, {})
        disc_name = str(level.get("discName")) if level.get("discName") is not None else None
        disc = discs.get(disc_name or "", {})
        rows[logical_key] = {
            "song_id": str(level.get("musicId")) if level.get("musicId") is not None else None,
            "song_title": music.get("musicName"),
            "music_artist": music.get("artist"),
            "illustration_id": logical_key,
            "illustrator": illustration.get("artist"),
            "disc_id": disc.get("shortName") or disc_name,
            "disc_name": disc_name,
            "level_id": level.get("id"),
            "chart_ids": list(level.get("chartIds", [])),
            "series_index": level.get("seriesIndex"),
        }
    return rows


def special_art_metadata(result: AssetListResult) -> dict[str, dict[str, Any]]:
    return {
        str(item["id"]): {
            "special_art_id": item.get("id"),
            "display_name": item.get("name"),
            "illustrator": item.get("artist"),
            "related_song": None,
            "related_event": None,
        }
        for item in result.fields.get("altIllustrationInfos", []) or []
        if isinstance(item, dict) and item.get("id")
    }


def layout_metadata(result: AssetListResult) -> dict[str, dict[str, Any]]:
    return {
        str(item["id"]): {
            "layout_id": item.get("id"),
            "display_name": None,
            "background_colors": [item.get("bgColor1"), item.get("bgColor2")],
            "foreground_color": item.get("fgColor"),
            "rarity": None,
            "source": None,
        }
        for item in result.fields.get("layoutColors", []) or []
        if isinstance(item, dict) and item.get("id")
    }


def static_card_metadata(result: AssetListResult) -> dict[str, dict[str, Any]]:
    if not result.static_cards:
        return {}
    rows: dict[str, dict[str, Any]] = {}
    for item in result.static_cards.get("staticCardsInfo", []) or []:
        if not isinstance(item, dict) or not item.get("cardId"):
            continue
        config = item.get("rizcard") if isinstance(item.get("rizcard"), dict) else {}
        card_id = str(item["cardId"])
        rows[card_id] = {
            "rizcard_id": card_id,
            "character_name": item.get("cardName"),
            "avatar_key": config.get("avatarId"),
            "background_key": config.get("backgroundId"),
            "layout_key": config.get("layoutId"),
            "bio_ids": [config.get("bioId1"), config.get("bioId2")],
            "static_dynamic_status": "STATIC_CONFIGURATION",
        }
    return rows
