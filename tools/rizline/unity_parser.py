"""UnityPy boundary for the Rizline Phase 3 extractor."""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from statistics import median
from typing import Any

try:  # Keep catalog/dry-run commands usable without UnityPy installed.
    import UnityPy
    from UnityPy.enums import TextureFormat
except ImportError:  # pragma: no cover - setup error exercised by CLI
    UnityPy = None
    TextureFormat = None

from .model import ResolvedObject


@dataclass
class ParsedImage:
    metadata: ResolvedObject
    image: Any | None
    decode_error: str | None = None
    is_primary: bool = False


@dataclass
class ParsedBundle:
    unity_version: str | None
    object_counts: dict[str, int]
    images: list[ParsedImage] = field(default_factory=list)
    gameobjects: list[dict[str, Any]] = field(default_factory=list)
    sprite_atlases: list[dict[str, Any]] = field(default_factory=list)
    container_keys: list[str] = field(default_factory=list)
    primary_path_ids: list[int] = field(default_factory=list)
    parse_failures: list[dict[str, Any]] = field(default_factory=list)


def _safe_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _member(value: Any, *names: str, default: Any = None) -> Any:
    if value is None:
        return default
    for name in names:
        if hasattr(value, name):
            return getattr(value, name)
    return default


def _component(value: Any, name: str) -> float | None:
    return _safe_float(_member(value, name))


def _path_id(value: Any) -> int | None:
    return _safe_int(_member(value, "m_PathID", "path_id", default=None))


def _texture_format_name(code: Any) -> str | None:
    number = _safe_int(code)
    if number is None:
        return None
    if TextureFormat is not None:
        try:
            return TextureFormat(number).name
        except (ValueError, TypeError):
            pass
    return f"Unknown({number})"


def _alpha_value(format_name: str | None, optional: bool) -> str:
    if not format_name:
        return "unknown"
    upper = format_name.upper()
    if any(token in upper for token in ("RGBA", "ARGB", "BGRA", "PVRTC_RGBA", "ETC2_RGBA", "ASTC_RGBA", "DXT5", "BC7", "ALPHA")):
        return "yes"
    if optional:
        return "optional"
    if any(token in upper for token in ("RGB", "DXT1", "ETC_RGB", "ASTC_RGB", "BC4", "BC5", "R8", "R16", "RHALF", "RFLOAT")):
        return "no"
    return "unknown"


def _pixel_sha256(image: Any) -> str | None:
    if image is None or not hasattr(image, "convert"):
        return None
    try:
        return hashlib.sha256(image.convert("RGBA").tobytes()).hexdigest()
    except Exception:
        return None


def _phash(image: Any) -> str | None:
    """Small dependency-free 64-bit DCT perceptual hash."""

    if image is None or not hasattr(image, "convert"):
        return None
    try:
        gray = image.convert("L").resize((32, 32))
        pixels = [float(value) for value in gray.getdata()]
        coefficients: list[float] = []
        for u in range(8):
            for v in range(8):
                total = 0.0
                for x in range(32):
                    for y in range(32):
                        total += pixels[x * 32 + y] * math.cos(((2 * x + 1) * u * math.pi) / 64) * math.cos(((2 * y + 1) * v * math.pi) / 64)
                coefficients.append(total)
        threshold = median(coefficients[1:])
        value = 0
        for coefficient in coefficients:
            value = (value << 1) | int(coefficient > threshold)
        return f"{value:016x}"
    except Exception:
        return None


def _pointer_description(pointer: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"path_id": _path_id(pointer), "object_type": None, "object_name": None}
    if pointer is None:
        return result
    wrapper = None
    for method_name in ("get_obj", "get_object"):
        method = getattr(pointer, method_name, None)
        if callable(method):
            try:
                wrapper = method()
            except Exception:
                wrapper = None
            if wrapper is not None:
                break
    if wrapper is None:
        return result
    result["object_type"] = getattr(getattr(wrapper, "type", None), "name", None)
    try:
        data = wrapper.read()
        result["object_name"] = _member(data, "m_Name", default=None)
    except Exception:
        pass
    return result


def _unity_version(environment: Any) -> str | None:
    versions: set[str] = set()
    for obj in list(getattr(environment, "objects", []))[:5]:
        assets_file = getattr(obj, "assets_file", None)
        version = getattr(assets_file, "unity_version", None) if assets_file is not None else None
        if version:
            versions.add(str(version))
    return "|".join(sorted(versions)) or None


def _read_source_texture(texture_pointer: Any, object_map: dict[int, Any]) -> tuple[int | None, Any | None]:
    source_path_id = _path_id(texture_pointer)
    if source_path_id is None:
        return None, None
    source_object = object_map.get(source_path_id)
    if source_object is None:
        return source_path_id, None
    try:
        return source_path_id, source_object.read()
    except Exception:
        return source_path_id, None


def _image_metadata(obj: Any, data: Any, object_map: dict[int, Any]) -> tuple[ResolvedObject, Any | None]:
    object_type = str(getattr(getattr(obj, "type", None), "name", ""))
    path_id = _safe_int(getattr(obj, "path_id", None))
    object_name = _member(data, "m_Name", default=None)
    source_data = data
    source_texture_path_id = path_id if object_type == "Texture2D" else None
    sprite_rect: dict[str, float] | None = None
    sprite_pivot: dict[str, float] | None = None
    sprite_atlas_path_id: int | None = None

    if object_type == "Sprite":
        render_data = _member(data, "m_RD", default=None)
        source_texture_path_id, source_data = _read_source_texture(_member(render_data, "texture", default=None), object_map)
        rect = _member(data, "m_Rect", default=None)
        rect_values = {name: _component(rect, name) for name in ("x", "y", "width", "height")}
        sprite_rect = {name: value for name, value in rect_values.items() if value is not None}
        pivot = _member(data, "m_Pivot", default=None)
        pivot_values = {name: _component(pivot, name) for name in ("x", "y")}
        sprite_pivot = {name: value for name, value in pivot_values.items() if value is not None}
        sprite_atlas_path_id = _path_id(_member(data, "m_SpriteAtlas", default=None))

    width = _safe_int(_member(data, "m_Width", default=None))
    height = _safe_int(_member(data, "m_Height", default=None))
    if object_type == "Sprite":
        width = _safe_int((sprite_rect or {}).get("width")) or _safe_int(_member(source_data, "m_Width", default=None))
        height = _safe_int((sprite_rect or {}).get("height")) or _safe_int(_member(source_data, "m_Height", default=None))

    format_code = _member(source_data, "m_TextureFormat", default=None)
    format_name = _texture_format_name(format_code)
    optional_alpha = bool(_member(source_data, "m_IsAlphaChannelOptional", default=False))
    mipmap_count = _safe_int(_member(source_data, "m_MipCount", default=None))
    source_width = _safe_int(_member(source_data, "m_Width", default=None))
    source_height = _safe_int(_member(source_data, "m_Height", default=None))
    full_texture = None
    if object_type == "Sprite" and sprite_rect and source_width and source_height:
        full_texture = sprite_rect.get("width") == source_width and sprite_rect.get("height") == source_height and sprite_rect.get("x") == 0 and sprite_rect.get("y") == 0

    image = None
    try:
        image = getattr(data, "image", None)
    except Exception:
        image = None
    # UnityPy may trim transparent Sprite borders while m_Rect keeps the
    # untrimmed logical canvas. Frontend dimensions must describe the bitmap
    # actually written; the original canvas remains in sprite_rect.
    decoded_width = _safe_int(getattr(image, "width", None)) if image is not None else None
    decoded_height = _safe_int(getattr(image, "height", None)) if image is not None else None

    metadata = ResolvedObject(
        resolved_object_type=object_type,
        object_name=str(object_name) if object_name is not None else None,
        object_path_id=path_id,
        width=decoded_width or width,
        height=decoded_height or height,
        texture_format=format_name,
        has_alpha=_alpha_value(format_name, optional_alpha),
        mipmap_count=mipmap_count,
        sprite_rect=sprite_rect,
        sprite_pivot=sprite_pivot,
        sprite_full_texture=full_texture,
        texture_source_path_id=source_texture_path_id,
        sprite_atlas_path_id=sprite_atlas_path_id,
        decoded_sha256=_pixel_sha256(image),
        phash=_phash(image),
    )
    return metadata, image


class UnityBundleParser:
    """Load one already-resolved Unity bundle and expose static objects."""

    def parse(self, bundle_path: Path, object_internal_ids: tuple[str, ...] = ()) -> ParsedBundle:
        if UnityPy is None:
            raise RuntimeError("UnityPy is required for bundle parsing")
        environment = UnityPy.load(str(bundle_path))
        objects = list(getattr(environment, "objects", []))
        container = getattr(environment, "container", {})
        primary_path_ids = {
            _safe_int(getattr(container[key], "path_id", None))
            for key in object_internal_ids
            if key in container
        }
        primary_path_ids.discard(None)
        counts = Counter(str(getattr(getattr(obj, "type", None), "name", "")) for obj in objects)
        object_map = {_safe_int(getattr(obj, "path_id", None)): obj for obj in objects if _safe_int(getattr(obj, "path_id", None)) is not None}
        result = ParsedBundle(
            unity_version=_unity_version(environment),
            object_counts=dict(counts),
            container_keys=list(container),
            primary_path_ids=sorted(primary_path_ids),
        )

        for obj in objects:
            object_type = str(getattr(getattr(obj, "type", None), "name", ""))
            path_id = _safe_int(getattr(obj, "path_id", None))
            try:
                data = obj.read()
            except Exception as exc:
                result.parse_failures.append({"object_type": object_type, "object_path_id": path_id, "stage": "read_object", "error": f"{type(exc).__name__}: {exc}"})
                continue

            if object_type in {"Texture2D", "Sprite"}:
                try:
                    metadata, image = _image_metadata(obj, data, object_map)
                    decode_error = None if image is not None else "image property unavailable"
                    result.images.append(ParsedImage(metadata=metadata, image=image, decode_error=decode_error, is_primary=path_id in primary_path_ids))
                except Exception as exc:
                    result.parse_failures.append({"object_type": object_type, "object_path_id": path_id, "stage": "read_image_object", "error": f"{type(exc).__name__}: {exc}"})
            elif object_type == "SpriteAtlas":
                packed = _member(data, "m_PackedSprites", default=[]) or []
                names = _member(data, "m_PackedSpriteNamesToIndex", default=[]) or []
                render_map = _member(data, "m_RenderDataMap", default=[]) or []
                result.sprite_atlases.append({"object_path_id": path_id, "object_name": _member(data, "m_Name", default=None), "packed_sprite_count": len(packed), "packed_name_count": len(names), "render_data_count": len(render_map)})
            elif object_type == "GameObject":
                components = _member(data, "m_Component", default=[]) or []
                result.gameobjects.append({"object_path_id": path_id, "object_name": _member(data, "m_Name", default=None), "component_count": len(components), "components": [_pointer_description(_member(component, "component", default=component)) for component in components]})
            elif object_type == "MonoBehaviour":
                result.gameobjects.append({"object_path_id": path_id, "object_name": _member(data, "m_Name", default=None), "component_count": None, "components": {"script": _pointer_description(_member(data, "m_Script", default=None))}})
        return result


def choose_export_image(
    parsed: ParsedBundle,
    *,
    require_primary: bool = False,
) -> ParsedImage | None:
    """Prefer a Sprite sibling and never emit both Sprite and Texture2D."""

    candidates = [
        item for item in parsed.images
        if item.image is not None and (item.is_primary or not require_primary)
    ]
    candidates.sort(key=lambda item: (not item.is_primary, item.metadata.resolved_object_type != "Sprite", item.metadata.object_path_id or 0))
    return candidates[0] if candidates else None


def safe_filename(value: str, max_length: int = 100) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "_", value)
    return (cleaned.strip("._") or "unnamed")[:max_length]
