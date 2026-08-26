"""Read Rotaeno chart metadata from APK-local Journey map bundles.

Rotaeno keeps the chart body encrypted, but the Unity ScriptableObjects still
expose the fields needed by the gallery: the song reference, difficulty class,
current inner difficulty value, and chart designer.  This module deliberately
does not export the encrypted chart string or any note data.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


CHART_SCRIPT = "StandardChartDataSO"
SONG_SCRIPT = "SongDataSO"
STANDALONE_CHART_SCRIPT = "StandaloneChartDataSO"
DIFFICULTY_ORDER = {"I": 0, "II": 1, "III": 2, "IV": 3, "IV_Alpha": 4}
CHART_NAME_RE = re.compile(r"^(?P<song>.+?) \[(?P<difficulty>I|II|III|IV)(?:_(?P<variant>[A-Za-z0-9]+))?\]$")
MAP_BUNDLE_RE = re.compile(r"/journey/.+(?:mapview|map\.prefab)", re.IGNORECASE)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _pointer_parts(value: Any) -> tuple[int, int] | None:
    if isinstance(value, dict):
        path_id = value.get("m_PathID", value.get("path_id"))
        file_id = value.get("m_FileID", value.get("file_id", 0))
    else:
        path_id = getattr(value, "path_id", None)
        file_id = getattr(value, "file_id", getattr(value, "m_FileID", 0))
    if isinstance(path_id, bool) or not isinstance(path_id, int):
        return None
    if isinstance(file_id, bool) or not isinstance(file_id, int):
        return None
    return path_id, file_id


def _pointer_path_id(value: Any) -> int | None:
    pointer = _pointer_parts(value)
    return pointer[0] if pointer is not None and pointer[1] == 0 else None


def _constant_string(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    for key in ("_constantString", "m_ConstantString", "constantString"):
        result = _text(value.get(key))
        if result:
            return result
    return None


def format_rating(value: Any) -> str | None:
    """Format the current Rotaeno inner difficulty without float noise."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        if not math.isfinite(float(value)):
            return None
    except (OverflowError, ValueError):
        return None
    return f"{value:.1f}".rstrip("0").rstrip(".")


def chart_difficulty(tree: dict[str, Any]) -> str | None:
    """Return the user-facing class encoded by levelId and m_Name.

    The name suffix is the authoritative distinction for the one special
    class currently present in the APK (for example [IV_Alpha]).  The
    numeric levelId remains available in the scanner's diagnostics, but is
    not exposed as public metadata.
    """

    name = _text(tree.get("m_Name"))
    match = CHART_NAME_RE.match(name or "")
    if match:
        difficulty = match.group("difficulty")
        variant = match.group("variant")
        return difficulty + ("_" + variant if variant else "")
    level_id = tree.get("levelId")
    return {0: "I", 1: "II", 2: "III", 3: "IV"}.get(level_id)


def chart_song_hint(tree: dict[str, Any]) -> str | None:
    name = _text(tree.get("m_Name"))
    match = CHART_NAME_RE.match(name or "")
    return match.group("song") if match else None


def chart_metadata(tree: dict[str, Any]) -> dict[str, Any] | None:
    """Project one StandardChartDataSO into the public-safe chart shape."""

    difficulty = chart_difficulty(tree)
    if difficulty is None:
        return None
    rating = format_rating(tree.get("v2InnerDifficulty"))
    override_song_info = tree.get("overrideSongInfo")
    charter = _constant_string(override_song_info.get("charterName")) if isinstance(override_song_info, dict) else None
    result: dict[str, Any] = {
        "difficulty": difficulty,
        "available": True,
        "status": "available",
    }
    if rating:
        result["level"] = rating
    if charter:
        result["artist"] = charter
    return result


def _script_map(environment: Any) -> dict[int, str]:
    scripts: dict[int, str] = {}
    for obj in environment.objects:
        if getattr(obj.type, "name", str(obj.type)) != "MonoScript":
            continue
        try:
            script = obj.read()
        except Exception:
            continue
        name = _text(getattr(script, "m_ClassName", None))
        if name:
            scripts[obj.path_id] = name
    return scripts


def _read_business_objects(bundle: bytes) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    try:
        import UnityPy  # type: ignore[import-not-found]
    except ImportError as error:  # pragma: no cover - depends on local APK tooling
        raise RuntimeError("UnityPy is required for Rotaeno chart extraction") from error

    environment = UnityPy.load(io.BytesIO(bundle))
    scripts = _script_map(environment)
    songs: list[dict[str, Any]] = []
    charts: list[dict[str, Any]] = []
    standalone_count = 0
    for obj in environment.objects:
        if getattr(obj.type, "name", str(obj.type)) != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if not isinstance(tree, dict):
            continue
        script_id = _pointer_path_id(tree.get("m_Script"))
        script_name = scripts.get(script_id or 0)
        if script_name == SONG_SCRIPT:
            songs.append({"path_id": obj.path_id, "tree": tree})
        elif script_name == CHART_SCRIPT:
            charts.append({"path_id": obj.path_id, "tree": tree})
        elif script_name == STANDALONE_CHART_SCRIPT:
            standalone_count += 1
    return songs, charts, standalone_count


def _bundle_song_rows(bundle_name: str, bundle: bytes) -> tuple[list[dict[str, Any]], dict[str, int]]:
    songs, charts, standalone_count = _read_business_objects(bundle)
    charts_by_path = {row["path_id"]: row for row in charts}
    linked_chart_ids: set[int] = set()
    song_ids: set[str] = set()
    output: list[dict[str, Any]] = []
    for song in songs:
        tree = song["tree"]
        song_id = _text(tree.get("id")) or _text(tree.get("m_Name"))
        if not song_id:
            continue
        song_ids.add(song_id)
        chart_rows: list[dict[str, Any]] = []
        references = tree.get("charts")
        if isinstance(references, list):
            for reference in references:
                path_id = _pointer_path_id(reference)
                chart_row = charts_by_path.get(path_id) if path_id is not None else None
                if chart_row is None:
                    continue
                linked_chart_ids.add(chart_row["path_id"])
                metadata = chart_metadata(chart_row["tree"])
                if metadata:
                    chart_rows.append(metadata)
        if chart_rows:
            output.append({
                "songId": song_id,
                "charts": _sort_charts(chart_rows),
                "source": {"bundle": bundle_name, "songPathId": song["path_id"]},
            })

    # A few Unity releases omit the SongDataSO reference even though the chart
    # name still contains a stable song id. Keep this fallback deterministic and
    # report it separately in diagnostics, but never bind an unknown song name.
    fallback_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    fallback_unknown_song_count = 0
    for chart in charts:
        if chart["path_id"] in linked_chart_ids:
            continue
        song_hint = chart_song_hint(chart["tree"])
        metadata = chart_metadata(chart["tree"])
        if song_hint and metadata:
            if song_hint not in song_ids:
                fallback_unknown_song_count += 1
                continue
            fallback_rows[song_hint].append(metadata)
    for song_id, chart_rows in sorted(fallback_rows.items()):
        output.append({
            "songId": song_id,
            "charts": _sort_charts(chart_rows),
            "source": {"bundle": bundle_name, "association": "chart-name-fallback"},
        })
    return output, {
        "songCount": len(songs),
        "standardChartCount": len(charts),
        "standaloneChartCount": standalone_count,
        "fallbackChartCount": sum(len(value) for value in fallback_rows.values()),
        "fallbackUnknownSongCount": fallback_unknown_song_count,
    }


def _sort_charts(charts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(charts, key=lambda chart: (DIFFICULTY_ORDER.get(str(chart.get("difficulty")), 99), str(chart.get("level", "")), str(chart.get("artist", ""))))


def _apk_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _bundle_names(archive: zipfile.ZipFile) -> list[str]:
    return sorted(
        info.filename
        for info in archive.infolist()
        if info.filename.lower().endswith(".bundle") and MAP_BUNDLE_RE.search(info.filename)
    )


def scan_charts(apk_path: str | Path, output_dir: str | Path) -> dict[str, Any]:
    """Scan chart-bearing Journey map bundles and write a safe JSON manifest."""

    apk = Path(apk_path)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    apk_sha256 = _apk_sha256(apk)
    bundles: list[dict[str, Any]] = []
    by_song: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, str]] = []
    with zipfile.ZipFile(apk) as archive:
        names = _bundle_names(archive)
        available = {info.filename.casefold(): info.filename for info in archive.infolist()}
        for bundle_name in names:
            archive_name = available.get(bundle_name.casefold())
            if archive_name is None:
                continue
            try:
                bundle = archive.read(archive_name)
                rows, counts = _bundle_song_rows(bundle_name, bundle)
                bundle_record = {
                    "path": bundle_name,
                    "sha256": _sha256(bundle),
                    "sizeBytes": len(bundle),
                    **counts,
                }
                bundles.append(bundle_record)
                for row in rows:
                    target = by_song.get(row["songId"])
                    if target is None:
                        target = {"songId": row["songId"], "charts": [], "sources": []}
                        by_song[row["songId"]] = target
                    target["charts"] = _sort_charts([*target["charts"], *row["charts"]])
                    target["sources"].append({**row["source"], "bundleSha256": bundle_record["sha256"]})
            except Exception as error:
                failures.append({"bundle": bundle_name, "reason": str(error)})

    songs: list[dict[str, Any]] = []
    duplicate_difficulties: list[dict[str, Any]] = []
    duplicate_charts: list[dict[str, Any]] = []
    for song_id in sorted(by_song):
        row = by_song[song_id]
        seen: set[tuple[str, str, str]] = set()
        unique_charts: list[dict[str, Any]] = []
        duplicates: list[dict[str, str]] = []
        for chart in row["charts"]:
            difficulty = str(chart.get("difficulty"))
            level = str(chart.get("level", ""))
            artist = str(chart.get("artist", ""))
            identity = (difficulty, level, artist)
            if identity in seen:
                duplicates.append({"difficulty": difficulty, "level": level, "artist": artist})
                continue
            seen.add(identity)
            unique_charts.append(chart)
        if duplicates:
            duplicate_difficulties.append({"songId": song_id, "difficulties": sorted({item["difficulty"] for item in duplicates})})
            duplicate_charts.append({"songId": song_id, "charts": duplicates})
        songs.append({"songId": song_id, "charts": _sort_charts(unique_charts), "sources": row["sources"]})

    fallback_chart_count = sum(int(bundle.get("fallbackChartCount", 0)) for bundle in bundles)
    fallback_unknown_song_count = sum(int(bundle.get("fallbackUnknownSongCount", 0)) for bundle in bundles)
    version = "unknown"
    try:
        from .apk import inspect_apk

        version = str(inspect_apk(apk).get("version_name") or version)
    except Exception:
        pass
    manifest: dict[str, Any] = {
        "kind": "rotaeno-chart-manifest",
        "schemaVersion": "1",
        "game": "rotaeno",
        "version": version,
        "sourceSnapshot": f"rotaeno:chart-metadata:{version}:{apk_sha256}",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "apk": {"filename": apk.name, "sha256": apk_sha256, "sizeBytes": apk.stat().st_size},
        "bundles": bundles,
        "songs": songs,
        "diagnostics": {
            "bundleCount": len(bundles),
            "songCount": len(songs),
            "chartCount": sum(len(song["charts"]) for song in songs),
            "standardChartCount": sum(int(bundle.get("standardChartCount", 0)) for bundle in bundles),
            "standaloneChartCount": sum(int(bundle.get("standaloneChartCount", 0)) for bundle in bundles),
            "duplicateDifficulties": duplicate_difficulties,
            "duplicateCharts": duplicate_charts,
            "fallbackChartCount": fallback_chart_count,
            "fallbackUnknownSongCount": fallback_unknown_song_count,
            "failures": failures,
        },
        "notes": [
            "Only StandardChartDataSO metadata was projected; encrypted chart bodies and note data were not exported.",
            "SongDataSO.charts references are preferred for song association; the chart-name fallback is reported in bundle diagnostics.",
            "StandaloneChartDataSO records are retained only as diagnostics because they represent minigame/special charts rather than the song's standard chart set.",
        ],
    }
    (output / "rotaeno-chart-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest
