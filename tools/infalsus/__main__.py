from __future__ import annotations

import argparse
import json
from pathlib import Path

from .extractor import InfalsusExtractor, prepare_publish


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract In Falsus Demo song metadata and jacket art")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect = subparsers.add_parser("inspect", help="discover SongData and report availability without exporting")
    inspect.add_argument("--game-root", required=True, type=Path)

    prepare = subparsers.add_parser("prepare-publish", help="extract publish candidates and semantic manifest")
    prepare.add_argument("--game-root", required=True, type=Path)
    prepare.add_argument("--output", required=True, type=Path)
    prepare.add_argument("--previous-manifest", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "inspect":
        result = InfalsusExtractor(args.game_root).inspect()
    else:
        result = prepare_publish(args.game_root, args.output, args.previous_manifest)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
