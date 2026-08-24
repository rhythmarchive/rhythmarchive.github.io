import base64
import json
import struct
import unittest

from tools.rotaeno.catalog import decode_catalog_bytes
from tools.rotaeno.manifest import build_manifest, choose_highest_quality, classify_resource, diff_manifests


def _catalog_fixture() -> bytes:
    keys = ["Assets/!Rotaeno/_Scriptable Objects/Songs/demo/Cover Hd - demo.png", "demo-guid"]
    key_data = bytearray(struct.pack("<I", len(keys)))
    offsets = []
    for value in keys:
        offsets.append(len(key_data))
        encoded = value.encode("ascii")
        key_data.extend(b"\x00" + struct.pack("<I", len(encoded)) + encoded)
    bucket_data = bytearray(struct.pack("<I", len(keys)))
    for offset in offsets:
        bucket_data.extend(struct.pack("<IIi", offset, 1, 0))
    entry_data = struct.pack("<I7i", 1, 0, 0, 1, 0, -1, 0, 0)
    catalog = {
        "m_LocatorId": "AddressablesMainContentCatalog",
        "m_BuildResultHash": "fixture",
        "m_InternalIds": ["song-demo.bundle"],
        "m_ProviderIds": ["AssetBundleProvider"],
        "m_resourceTypes": [{"m_ClassName": "UnityEngine.Texture2D"}],
        "m_KeyDataString": base64.b64encode(key_data).decode("ascii"),
        "m_BucketDataString": base64.b64encode(bucket_data).decode("ascii"),
        "m_EntryDataString": base64.b64encode(entry_data).decode("ascii"),
        "m_ExtraDataString": "",
    }
    return json.dumps(catalog).encode("utf-8")


class ManifestTests(unittest.TestCase):
    def test_catalog_fixture_resolves_logical_key(self) -> None:
        snapshot = decode_catalog_bytes(_catalog_fixture())
        entries = snapshot.entries_for_key("demo-guid")
        self.assertEqual(len(entries), 1)
        self.assertEqual(snapshot.dependency_key(entries[0]), "demo-guid")

    def test_song_cover_classification_and_manifest(self) -> None:
        snapshot = decode_catalog_bytes(_catalog_fixture())
        manifest = build_manifest({"version_name": "test", "channel": "fixture", "package_name": "x", "sha256": "y"}, snapshot)
        self.assertEqual(manifest["songs"][0]["id"], "demo")
        self.assertEqual(manifest["resource_counts"]["song_jacket"], 1)
        self.assertEqual(classify_resource("Assets/!Rotaeno/_Scriptable Objects/Songs/demo/Cover Hd - demo.png", ["UnityEngine.Texture2D"])[0], "song_jacket")

    def test_highest_quality_prefers_dimensions(self) -> None:
        candidates = [
            {"width": 512, "height": 512, "pixel_sha256": "same", "export_file_sha256": "a"},
            {"width": 2048, "height": 2048, "pixel_sha256": "better", "export_file_sha256": "b"},
        ]
        self.assertEqual(choose_highest_quality(candidates)["width"], 2048)

    def test_diff_has_review_states(self) -> None:
        old = {
            "version": "2.26.0",
            "resources": [
                {"semantic_type": "song_jacket", "stable_id": "a", "logical_key": "a", "confidence": "high"},
                {"semantic_type": "song_jacket", "stable_id": "gone", "logical_key": "gone", "confidence": "high"},
                {"semantic_type": "unknown", "stable_id": "u", "logical_key": "u", "confidence": "unknown"},
            ],
        }
        new = {
            "version": "2.26.1",
            "resources": [
                {"semantic_type": "song_jacket", "stable_id": "a", "logical_key": "a", "confidence": "high"},
                {"semantic_type": "song_jacket", "stable_id": "new", "logical_key": "new", "confidence": "high"},
                {"semantic_type": "unknown", "stable_id": "u", "logical_key": "u", "confidence": "unknown"},
            ],
        }
        result = diff_manifests(old, new)
        self.assertEqual(result["counts"]["UNCHANGED"], 1)
        self.assertEqual(result["counts"]["ADDED"], 1)
        self.assertEqual(result["counts"]["REMOVED"], 1)
        self.assertEqual(result["counts"]["UNKNOWN"], 1)


if __name__ == "__main__":
    unittest.main()
