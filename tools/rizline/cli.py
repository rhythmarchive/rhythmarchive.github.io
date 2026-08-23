"""Small, conservative ``inspect`` / ``extract`` command line interface."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Sequence

from .catalog import SUPPORTED_FAMILIES, family_summary, load_apk_catalog, load_catalog_file
from .extractor import build_selections, extract_assets
from .resolver import RuntimeCacheResolver


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tools.rizline", description="Rizline APK-catalog + local RuntimeCache extractor")
    sub = parser.add_subparsers(dest="command", required=True)

    for command in ("inspect", "extract"):
        command_parser = sub.add_parser(command)
        command_parser.add_argument("--apk", required=True, type=Path)
        command_parser.add_argument("--cache-root", required=True, type=Path)
        command_parser.add_argument("--runtime-catalog", type=Path, help="Optional diagnostic catalog; never used as version source")
        command_parser.add_argument("--family", action="append", choices=sorted(SUPPORTED_FAMILIES), help="Repeat to select one or more semantic families")
        command_parser.add_argument("--key", action="append", help="Repeat to select exact logical keys and their normal/HiRes siblings")
        command_parser.add_argument("--prefer-hires", action="store_true")
        command_parser.add_argument("--verbose", action="store_true")
        if command == "extract":
            command_parser.add_argument("--output", required=True, type=Path)
            command_parser.add_argument("--dry-run", action="store_true")
    return parser


def _repo_root() -> Path | None:
    try:
        result = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False)
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return Path(result.stdout.strip()).resolve()


def _verify_output_ignored(output: Path) -> None:
    root = _repo_root()
    if root is None:
        return
    candidate = (output.resolve() / "manifest.json")
    try:
        candidate.relative_to(root)
    except ValueError:
        return
    result = subprocess.run(["git", "check-ignore", "-q", "--no-index", str(candidate)], cwd=root, check=False)
    if result.returncode != 0:
        raise SystemExit(f"OUTPUT_NOT_IGNORED: {candidate}")


def _summary_for_selections(selections) -> dict[str, int]:
    payload = Counter(selection.resolved_payload.payload_status.value for selection in selections)
    fallbacks = sum(selection.variant_fallback for selection in selections)
    return {"selected": len(selections), "payload_found": payload.get("FOUND", 0), "payload_missing": payload.get("MISSING", 0), "payload_unresolved": payload.get("UNRESOLVED", 0), "payload_invalid": payload.get("INVALID", 0), "variant_fallback": fallbacks}


def _inspect(args: argparse.Namespace) -> int:
    version, catalog = load_apk_catalog(args.apk)
    resolver = RuntimeCacheResolver(args.cache_root)
    result = {
        "command": "inspect",
        "version": version.to_dict(),
        "catalog": catalog.summary(),
        "catalog_role": "version_source",
        "family_summary": family_summary(catalog),
        "supported_family_status": {family: SUPPORTED_FAMILIES[family] for family in sorted(SUPPORTED_FAMILIES)},
        "runtime_catalog_diagnostic": None,
        "cache_root": str(resolver.shared_root),
    }
    if args.runtime_catalog:
        runtime = load_catalog_file(args.runtime_catalog, catalog_role="diagnostic/runtime")
        result["runtime_catalog_diagnostic"] = runtime.summary()
    if args.key or args.family:
        selections = build_selections(catalog, resolver, families=args.family, keys=args.key, prefer_hires=args.prefer_hires)
        result["selected_cache_summary"] = _summary_for_selections(selections)
        result["selected_keys"] = [selection.preferred.asset.logical_key for selection in selections]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _extract(args: argparse.Namespace) -> int:
    _verify_output_ignored(args.output)
    version, catalog = load_apk_catalog(args.apk)
    resolver = RuntimeCacheResolver(args.cache_root)
    families = args.family
    keys = args.key
    if not families and not keys:
        families = [family for family, status in SUPPORTED_FAMILIES.items() if status in {"SUPPORTED", "PARTIAL"}]
    assets = extract_assets(version, catalog, resolver, args.output, families=families, keys=keys, prefer_hires=args.prefer_hires, dry_run=args.dry_run)
    counts = Counter(asset.parse_status for asset in assets)
    result = {
        "command": "extract",
        "dry_run": bool(args.dry_run),
        "version": version.to_dict(),
        "selected": len(assets),
        "payload_status": dict(Counter(asset.payload_status for asset in assets)),
        "parse_status": dict(counts),
        "fallback_count": sum(asset.variant_fallback for asset in assets),
        "export_count": sum(asset.export_path is not None for asset in assets),
        "manifest_json": str((args.output / "manifest.json").resolve()),
        "manifest_csv": str((args.output / "manifest.csv").resolve()),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "inspect":
        return _inspect(args)
    if args.command == "extract":
        return _extract(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
