from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.rizline.catalog import CatalogEntry, CatalogSnapshot, parse_logical_key
from tools.rizline.extractor import build_selections
from tools.rizline.model import BundleRequirement, PayloadStatus
from tools.rizline.resolver import RuntimeCacheResolver


class LogicalKeyTests(unittest.TestCase):
    def test_known_key_families_and_variants(self) -> None:
        self.assertEqual(parse_logical_key("illustration.foo"), ("illustration", "foo", "normal", None))
        self.assertEqual(parse_logical_key("illustration.foo.HiRes"), ("illustration", "foo", "hires", None))
        self.assertEqual(parse_logical_key("seriesPoster.00001"), ("seriesPoster", "00001", "normal", None))
        self.assertEqual(parse_logical_key("seriesBanner.00001"), ("seriesBanner", "00001", "normal", None))
        self.assertEqual(parse_logical_key("avatar.npc.bayees"), ("avatar.npc", "bayees", "normal", None))
        self.assertEqual(parse_logical_key("rizcard.00030"), ("rizcard", "00030", "normal", None))


class ResolverTests(unittest.TestCase):
    def test_exact_runtime_cache_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "files"
            name = "a" * 32
            bundle_hash = "b" * 32
            payload = root / "UnityCache" / "Shared" / name / bundle_hash / "__data"
            payload.parent.mkdir(parents=True)
            payload.write_bytes(b"UnityFS\x00")
            requirement = BundleRequirement("dependency", name, bundle_hash, 8, None, "internal")
            resolved = RuntimeCacheResolver(root).resolve(requirement)
            self.assertEqual(resolved.payload_status, PayloadStatus.FOUND)
            self.assertEqual(resolved.match_status, "EXACT")
            self.assertEqual(resolved.size, 8)

    def test_missing_payload_is_not_an_exception(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            requirement = BundleRequirement("dependency", "a" * 32, "b" * 32, 8, None, "internal")
            resolved = RuntimeCacheResolver(Path(temporary)).resolve(requirement)
            self.assertEqual(resolved.payload_status, PayloadStatus.MISSING)
            self.assertEqual(resolved.match_status, "MISSING")


class FallbackTests(unittest.TestCase):
    def _snapshot(self, normal: BundleRequirement, hires: BundleRequirement) -> CatalogSnapshot:
        key_names = ("illustration.foo", "illustration.foo.HiRes", "bundle-normal", "bundle-hires")
        entries = (
            CatalogEntry(0, "asset-normal", "provider", 2, 0, -1, "illustration.foo", {"m_ClassName": "Sprite"}, ("illustration.foo",), None),
            CatalogEntry(1, "asset-hires", "provider", 3, 0, -1, "illustration.foo.HiRes", {"m_ClassName": "Sprite"}, ("illustration.foo.HiRes",), None),
            CatalogEntry(2, normal.internal_id, "bundle-provider", -1, 0, 0, "bundle-normal", {"m_ClassName": "AssetBundle"}, ("bundle-normal",), {"value": {"m_BundleName": normal.bundle_name, "m_Hash": normal.bundle_hash, "m_BundleSize": normal.bundle_size}}),
            CatalogEntry(3, hires.internal_id, "bundle-provider", -1, 0, 0, "bundle-hires", {"m_ClassName": "AssetBundle"}, ("bundle-hires",), {"value": {"m_BundleName": hires.bundle_name, "m_Hash": hires.bundle_hash, "m_BundleSize": hires.bundle_size}}),
        )
        return CatalogSnapshot(raw={"m_LocatorId": "test", "m_BuildResultHash": "hash"}, key_names=key_names, key_entries=((0,), (1,), (2,), (3,)), entries=entries)

    def test_hires_falls_back_to_normal_when_payload_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "files"
            normal_name, normal_hash = "a" * 32, "b" * 32
            hires_name, hires_hash = "c" * 32, "d" * 32
            normal_payload = root / "UnityCache" / "Shared" / normal_name / normal_hash / "__data"
            normal_payload.parent.mkdir(parents=True)
            normal_payload.write_bytes(b"UnityFS\x00")
            normal = BundleRequirement("bundle-normal", normal_name, normal_hash, 8, None, "normal")
            hires = BundleRequirement("bundle-hires", hires_name, hires_hash, 99, None, "hires")
            selections = build_selections(self._snapshot(normal, hires), RuntimeCacheResolver(root), keys=["illustration.foo"], prefer_hires=True)
            self.assertEqual(len(selections), 1)
            selection = selections[0]
            self.assertTrue(selection.variant_fallback)
            self.assertEqual(selection.preferred_variant, "hires")
            self.assertEqual(selection.resolved_variant, "normal")
            self.assertEqual(selection.fallback_reason, "payload_unavailable")
            self.assertEqual(selection.resolved_payload.payload_status, PayloadStatus.FOUND)


class ManifestShapeTests(unittest.TestCase):
    def test_json_serialization_preserves_nulls(self) -> None:
        payload = {"value": None, "nested": {"missing": None}}
        self.assertEqual(json.loads(json.dumps(payload)), payload)


if __name__ == "__main__":
    unittest.main()
