"""Machine-readable JSON manifest and human-auditable CSV output."""

from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .model import ExtractedAsset, GameVersion


MANIFEST_SCHEMA = "rizline.phase3.manifest.v1"


def _json_value(value: Any) -> Any:
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _csv_value(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(_json_value(value), ensure_ascii=False, separators=(",", ":"))
    return str(_json_value(value))


def manifest_payload(version: GameVersion, assets: Iterable[ExtractedAsset], *, resolver: str = "RuntimeCacheResolver") -> dict[str, Any]:
    return {
        "schema_version": MANIFEST_SCHEMA,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "catalog_role": "version_source",
        "version": version.to_dict(),
        "resolver": resolver,
        "assets": [_json_value(asset.to_dict()) for asset in assets],
    }


def write_manifest(output_dir: Path, version: GameVersion, assets: list[ExtractedAsset], *, resolver: str = "RuntimeCacheResolver") -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "manifest.json"
    csv_path = output_dir / "manifest.csv"
    json_path.write_text(json.dumps(manifest_payload(version, assets, resolver=resolver), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    fields = list(ExtractedAsset.__dataclass_fields__.keys())
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for asset in assets:
            writer.writerow({key: _csv_value(getattr(asset, key)) for key in fields})
    return json_path, csv_path
