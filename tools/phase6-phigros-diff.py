"""Phase 6 Phigros image-content diff.

This is a small supplement to the existing extractor. It records a complete
new-source inventory, then compares extracted Texture2D content for bundles
whose bytes changed by bundle path + Unity object path id/name. A same-name
bundle is therefore not treated as unchanged merely because its filename is
unchanged. Unchanged bundles contribute identity metadata but no re-exported
image files. Ambiguous display metadata is left for Admin review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

try:
    import UnityPy
except ImportError:  # pragma: no cover - operator setup error
    UnityPy = None


BUNDLE_RE = "assets/aa/Android/"
ILLUSTRATION = "\u66f2\u7ed8"
AVATAR = "\u5934\u50cf"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk-dir", default="")
    parser.add_argument("--new", required=True)
    parser.add_argument("--old", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def apk_path(value: str) -> Path:
    return Path(value).resolve()


def apk_bundles(apk: Path) -> dict[str, str]:
    with zipfile.ZipFile(apk) as archive:
        result: dict[str, str] = {}
        for info in archive.infolist():
            if not info.filename.startswith(BUNDLE_RE) or not info.filename.lower().endswith(".bundle"):
                continue
            with archive.open(info) as source:
                result[info.filename] = hashlib.sha256(source.read()).hexdigest()
        return result


def extract_bundle(apk: Path, bundle: str, destination: Path) -> Path:
    target = destination / bundle
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(apk) as archive, archive.open(bundle) as source, target.open("wb") as output:
        shutil.copyfileobj(source, output)
    return target


def image_hash(image: Any) -> str:
    payload = image.tobytes()
    return hashlib.sha256(payload).hexdigest()


def classify(object_name: str, width: int, height: int) -> str | None:
    if object_name == "Illustration" and width >= 1000 and height >= 500:
        return ILLUSTRATION
    if width <= 200 and height <= 200:
        return AVATAR
    return None


def read_images(bundle_path: Path, bundle_name: str, include_pixels: bool = True) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    environment = UnityPy.load(str(bundle_path))
    for obj in environment.objects:
        if obj.type.name != "Texture2D":
            continue
        data = obj.read()
        image = getattr(data, "image", None) if include_pixels else None
        width = int(getattr(data, "m_Width", 0) or 0)
        height = int(getattr(data, "m_Height", 0) or 0)
        name = str(getattr(data, "m_Name", "") or "")
        category = classify(name, width, height)
        if category is None or (include_pixels and image is None):
            continue
        path_id = str(getattr(obj, "path_id", "") or "")
        stable_id = path_id or name
        result[(bundle_name, stable_id)] = {"bundle": bundle_name, "objectName": name, "pathId": path_id, "category": category, "width": width, "height": height, **({"image": image, "imageContentHash": image_hash(image)} if include_pixels and image is not None else {})}
    return result


def safe_filename(value: str) -> str:
    cleaned = "".join(char for char in value if char not in '<>:"/\\|?*')
    return cleaned.strip().rstrip(".") or "unnamed"


def main() -> int:
    if UnityPy is None:
        raise SystemExit("UnityPy and texture2ddecoder are required for the Phase 6 Phigros diff")
    args = parse_args()
    new_apk = apk_path(args.new)
    old_apk = apk_path(args.old)
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    new_bundles = apk_bundles(new_apk)
    old_bundles = apk_bundles(old_apk)
    changed = sorted(bundle for bundle, digest in new_bundles.items() if old_bundles.get(bundle) != digest)
    exported: list[dict[str, Any]] = []
    source_inventory: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="phase6-phigros-") as temporary:
        root = Path(temporary)
        for bundle in sorted(new_bundles):
            new_path = extract_bundle(new_apk, bundle, root / "new")
            is_changed_bundle = bundle in changed
            new_images = read_images(new_path, bundle, include_pixels=is_changed_bundle)
            for item in new_images.values():
                source_inventory.append({"category": item["category"], "bundle": bundle, "objectName": item["objectName"], "objectPathId": item["pathId"], "sourceRelativePath": bundle, "width": item["width"], "height": item["height"], "bundleHash": new_bundles[bundle], **({"imageContentHash": item["imageContentHash"]} if "imageContentHash" in item else {})})
            if not is_changed_bundle:
                continue
            old_images: dict[tuple[str, str], dict[str, Any]] = {}
            if bundle in old_bundles:
                old_path = extract_bundle(old_apk, bundle, root / "old")
                old_images = read_images(old_path, bundle, include_pixels=True)
            for key, item in new_images.items():
                previous = old_images.get(key)
                if previous and previous["imageContentHash"] == item["imageContentHash"]:
                    continue
                detection = "added" if previous is None else "changed"
                filename = f"{safe_filename(Path(bundle).stem)}_{safe_filename(item['pathId'] or item['objectName'])}.png"
                destination = output / item["category"] / filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                item["image"].save(destination)
                exported.append({"category": item["category"], "outputPath": str(destination.relative_to(output)), "bundle": bundle, "objectName": item["objectName"], "objectPathId": item["pathId"], "width": item["width"], "height": item["height"], "nameSource": "bundle-path-content-hash", "sourceKey": None, "detection": detection, "bundleHash": new_bundles[bundle], "imageContentHash": item["imageContentHash"]})
    report = {"generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "newVersion": new_apk.stem, "oldVersion": old_apk.stem, "outputDir": str(output), "totals": {"changedBundles": len(changed), "inventory": len(source_inventory), "exported": len(exported), "changedContent": sum(1 for item in exported if item["detection"] == "changed")}, "sourceInventory": source_inventory, "exported": exported, "note": "Bundle hashes are only a scan filter; final changed classification uses extracted image content hash keyed by bundle path and Unity object identity. Unchanged bundles retain inventory identity without re-exporting image files."}
    (output / "phigros-update-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
