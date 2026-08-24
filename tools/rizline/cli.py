"""Conservative local inspection and remote-canonical preparation CLI."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Sequence

from .catalog import SUPPORTED_FAMILIES, family_summary, load_apk_catalog, load_catalog_file, resolve_logical_key
from .extractor import build_selections, extract_assets
from .patch import PatchMetadataResolver
from .publish import acquire_asset_list_metadata, prepare_publish_dataset
from .remote import DirectAssetResolver
from .resolver import RuntimeCacheResolver


DEFAULT_RESOURCE_BASE_URL = "https://rizlineasset.pigeongames.net/versions"
DEFAULT_RESOURCE_VERSION = "v137_2_7_0_7c39d404bbP"
DEFAULT_PLATFORM = "Android"


def _add_remote_arguments(command: argparse.ArgumentParser, *, apk: bool = False) -> None:
    if apk:
        command.add_argument("--apk", required=True, type=Path)
    command.add_argument("--output", required=True, type=Path)
    command.add_argument("--resource-base-url", default=DEFAULT_RESOURCE_BASE_URL)
    command.add_argument("--resource-version", default=DEFAULT_RESOURCE_VERSION)
    command.add_argument("--platform", default=DEFAULT_PLATFORM)
    command.add_argument("--refresh-patch-list", action="store_true")
    command.add_argument("--timeout", type=float, default=60.0)
    command.add_argument("--retries", type=int, default=2)



def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tools.rizline", description="Rizline catalog inspection and remote-canonical publish preparation")
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

    patch_list = sub.add_parser("patch-list", help="Build/cache the declared patch metadata chain")
    _add_remote_arguments(patch_list)

    metadata = sub.add_parser("metadata", help="Acquire and parse Default.asset/AssetList")
    _add_remote_arguments(metadata, apk=True)

    acquire = sub.add_parser("acquire", help="Acquire only explicitly requested logical keys")
    _add_remote_arguments(acquire, apk=True)
    acquire.add_argument("--key", action="append", required=True)

    prepare = sub.add_parser("prepare-publish", help="Prepare the complete ignored publish-review dataset")
    _add_remote_arguments(prepare, apk=True)

    integration = sub.add_parser("integration", help="Run the opt-in Life is PIANO remote integration probe")
    _add_remote_arguments(integration, apk=True)
    integration.add_argument("--key", default="illustration.LifeisPIANO.Junk.0.HiRes")
    integration.add_argument("--integration", action="store_true", required=True)

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
    candidate = output.resolve()
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise SystemExit(f"OUTPUT_OUTSIDE_REPOSITORY: {candidate}") from exc
    expected_root = Path("temp") / "rizline_publish_prep"
    if relative != expected_root and expected_root not in relative.parents:
        raise SystemExit(
            f"OUTPUT_OUTSIDE_RIZLINE_STAGING: {candidate}"
        )
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




def _remote_components(args: argparse.Namespace):
    patch_resolver = PatchMetadataResolver(
        args.resource_base_url,
        args.resource_version,
        args.platform,
        args.output / "cache" / "patch_list.json",
    )
    patch_list = patch_resolver.build(refresh=args.refresh_patch_list)
    resolver = DirectAssetResolver(
        args.resource_base_url,
        patch_list,
        args.output / "bundle_cache",
        platform=args.platform,
        timeout=args.timeout,
        retries=args.retries,
    )
    return patch_list, resolver




def _acquisition_catalog(resolver: DirectAssetResolver):
    path, evidence = resolver.acquire_catalog()
    if path is None:
        raise SystemExit(
            "REMOTE_CATALOG_ACQUISITION_FAILED: "
            + json.dumps(evidence, ensure_ascii=False)
        )
    catalog = load_catalog_file(
        path, catalog_role="production/remote-canonical",
    )
    evidence["catalog_build_hash"] = catalog.build_hash
    evidence["catalog_locator_id"] = catalog.locator_id
    return catalog, evidence

def _patch_list(args: argparse.Namespace) -> int:
    _verify_output_ignored(args.output)
    patch_list, _resolver = _remote_components(args)
    print(json.dumps({
        "command": "patch-list",
        "cache": str((args.output / "cache" / "patch_list.json").resolve()),
        "status": patch_list.status,
        "layers": len(patch_list.chain),
        "mapped_files": len(patch_list.file_to_version),
        "base_version": patch_list.base_version,
    }, ensure_ascii=False, indent=2))
    return 0


def _metadata(args: argparse.Namespace) -> int:
    _verify_output_ignored(args.output)
    version, _embedded_catalog = load_apk_catalog(args.apk)
    _patch_list_value, resolver = _remote_components(args)
    catalog, catalog_evidence = _acquisition_catalog(resolver)
    result = acquire_asset_list_metadata(
        version, catalog, resolver, catalog_evidence, args.output,
    )
    print(json.dumps({
        "command": "metadata",
        "version": version.to_dict(),
        **result,
    }, ensure_ascii=False, indent=2))
    return 0 if result["asset_list_status"] in {"SUCCESS", "PARTIAL"} else 1


def _acquire(args: argparse.Namespace) -> int:
    _verify_output_ignored(args.output)
    version, _embedded_catalog = load_apk_catalog(args.apk)
    patch_list, resolver = _remote_components(args)
    rows = []
    catalog, catalog_evidence = _acquisition_catalog(resolver)
    for logical_key in args.key:
        resolution = resolve_logical_key(catalog, logical_key)
        if resolution is None:
            rows.append({
                "logical_key": logical_key,
                "status": "FAILED",
                "error": "CATALOG_KEY_UNRESOLVED",
            })
            continue
        requirements = (
            (resolution.asset.bundle,)
            if resolution.asset.bundle
            else resolution.container_candidates
        )
        if not requirements:
            rows.append({
                "logical_key": logical_key,
                "status": "FAILED",
                "error": f"PRIMARY_BUNDLE_{resolution.primary_bundle_status}",
            })
            continue
        for requirement in requirements:
            remote = resolver.acquire(requirement)
            rows.append({
                "logical_key": logical_key,
                "object_internal_ids": list(resolution.asset.object_internal_ids),
                "primary_bundle_status": resolution.primary_bundle_status,
                "status": (
                    "SUCCESS"
                    if remote.verification_status == "VERIFIED"
                    else "FAILED"
                ),
                "bundle": remote.to_dict(),
            })
    target = args.output / "manifests" / "explicit_acquisition_manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "schema_version": "rizline.explicit-acquisition.v1",
        "game_version": version.to_dict(),
        "patch_list": patch_list.to_dict(),
        "records": rows,
        "acquisition_catalog": catalog_evidence,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = {
        "command": args.command,
        "requested_keys": len(args.key),
        "verified_bundles": sum(row.get("status") == "SUCCESS" for row in rows),
        "failed": sum(row.get("status") == "FAILED" for row in rows),
        "manifest": str(target.resolve()),
        "records": rows if args.command == "integration" else None,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["verified_bundles"] else 1


def _prepare_publish(args: argparse.Namespace) -> int:
    _verify_output_ignored(args.output)
    version, _embedded_catalog = load_apk_catalog(args.apk)
    patch_list, resolver = _remote_components(args)
    catalog, catalog_evidence = _acquisition_catalog(resolver)
    result = prepare_publish_dataset(
        version, catalog, patch_list, resolver, catalog_evidence, args.output,
    )
    print(json.dumps({
        "command": "prepare-publish",
        "version": version.to_dict(),
        **result,
    }, ensure_ascii=False, indent=2))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "inspect":
        return _inspect(args)
    if args.command == "extract":
        return _extract(args)
    if args.command == "patch-list":
        return _patch_list(args)
    if args.command == "metadata":
        return _metadata(args)
    if args.command == "acquire":
        return _acquire(args)
    if args.command == "prepare-publish":
        return _prepare_publish(args)
    if args.command == "integration":
        args.key = [args.key]
        return _acquire(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
