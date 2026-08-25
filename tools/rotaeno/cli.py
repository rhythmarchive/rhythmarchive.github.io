"""Command line entry point for the Rotaeno inspection milestone."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
from typing import Any

from .apk import inspect_apk
from .catalog import decode_catalog_bytes
from .images import extract_images
from .manifest import build_manifest, diff_manifests


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def inspect_command(args: argparse.Namespace) -> int:
    apk_path = Path(args.apk)
    identity = inspect_apk(apk_path)
    with zipfile.ZipFile(apk_path) as archive:
        catalog_raw = archive.read("assets/aa/catalog.json")
    snapshot = decode_catalog_bytes(catalog_raw)
    manifest = build_manifest(identity, snapshot, include_unknown=args.include_unknown)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        _write_json(out / "apk_identity.json", identity)
        _write_json(out / "semantic_manifest.json", manifest)
        _write_json(out / "catalog_summary.json", snapshot.summary())
    print(
        json.dumps(
            {
                "game": manifest["game"],
                "version": manifest["version"],
                "channel": manifest["channel"],
                "package_name": manifest["apk"]["package_name"],
                "unity_version": identity.get("unity_version"),
                "catalog": snapshot.summary(),
                "resource_counts": manifest["resource_counts"],
                "output": str(Path(args.out).resolve()) if args.out else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def diff_command(args: argparse.Namespace) -> int:
    old = json.loads(Path(args.old).read_text(encoding="utf-8"))
    new = json.loads(Path(args.new).read_text(encoding="utf-8"))
    result = diff_manifests(old, new)
    if args.out:
        _write_json(Path(args.out), result)
    print(json.dumps({"counts": result["counts"], "output": str(Path(args.out).resolve()) if args.out else None}, indent=2))
    return 0


def extract_images_command(args: argparse.Namespace) -> int:
    manifest = extract_images(args.apk, args.selection, args.out)
    print(
        json.dumps(
            {
                "game": manifest["game"],
                "version": manifest["version"],
                "source_snapshot": manifest["source_snapshot"],
                "requested": manifest["diagnostics"]["requested"],
                "extracted": manifest["diagnostics"]["extracted"],
                "failed": manifest["diagnostics"]["failed"],
                "output": str(Path(args.out).resolve()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if manifest["diagnostics"]["failed"] == 0 else 2

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tools.rotaeno")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="inspect an APK-local catalog and identity")
    inspect_parser.add_argument("--apk", required=True, help="path to an APK; it is read only")
    inspect_parser.add_argument("--out", help="optional directory for JSON outputs")
    inspect_parser.add_argument("--include-unknown", action="store_true", help="include path-like catalog rows not yet classified")
    inspect_parser.set_defaults(handler=inspect_command)

    diff_parser = subparsers.add_parser("diff", help="diff two semantic manifests")
    diff_parser.add_argument("--old", required=True, help="old semantic_manifest.json")
    diff_parser.add_argument("--new", required=True, help="new semantic_manifest.json")
    diff_parser.add_argument("--out", help="optional update-set JSON path")
    diff_parser.set_defaults(handler=diff_command)
    extract_parser = subparsers.add_parser("extract-images", help="extract explicitly selected Texture2D images from an APK")
    extract_parser.add_argument("--apk", required=True, help="path to an APK; it is read only")
    extract_parser.add_argument("--selection", required=True, help="JSON selection file")
    extract_parser.add_argument("--out", required=True, help="output directory for extracted images and manifest")
    extract_parser.set_defaults(handler=extract_images_command)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)
