from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tools.rizline.asset_list import (
    AssetListResult,
    layout_metadata,
    song_metadata,
    static_card_metadata,
)
from tools.rizline.catalog import (
    CatalogSnapshot,
    load_apk_catalog,
    load_catalog_file,
    resolve_logical_key,
)
from tools.rizline.cli import DEFAULT_RESOURCE_BASE_URL, DEFAULT_RESOURCE_VERSION
from tools.rizline.model import BundleRequirement, GameVersion, ResolvedObject
from tools.rizline.publish import (
    _apply_high_confidence_series_pairing,
    _load_resume_rows,
    _reconcile_generated_files,
    _write_acquisition_manifest,
)
from tools.rizline.patch import (
    FetchedPatchMetadata,
    PatchChainIncomplete,
    PatchList,
    PatchMetadata,
    PatchMetadataError,
    PatchMetadataResolver,
)
from tools.rizline.remote import DirectAssetResolver
from tools.rizline.semantic import (
    classify_rizcard,
    filesystem_id,
    layout_variant_relation,
    selected_variant_keys,
    stable_asset_id,
)
from tools.rizline.unity_parser import ParsedBundle, ParsedImage, UnityBundleParser, choose_export_image


INTEGRATION_ENABLED = "--integration" in sys.argv
if INTEGRATION_ENABLED:
    sys.argv.remove("--integration")


def _patch_list(mapping: dict[str, str], status: str = "COMPLETE") -> PatchList:
    return PatchList(
        current_resource_version="v3",
        platform="Android",
        chain=[],
        file_to_version=mapping,
        base_version="v1",
        status=status,
        retrieved_at="2026-01-01T00:00:00+00:00",
    )


def _asset_list_result() -> AssetListResult:
    return AssetListResult(
        status="SUCCESS",
        object_name="Default",
        object_path_id=1,
        object_internal_id="asset-list",
        fields={
            "levels": [{
                "id": "level.main",
                "musicId": "music.main",
                "illustrationId": "illustration.main",
                "discName": "Main",
                "chartIds": ["chart.main"],
                "seriesIndex": 1,
            }],
            "discOLevels": [{
                "id": "level.disco",
                "musicId": "music.disco",
                "illustrationId": "illustration.disco",
                "discName": "DiscO",
                "chartIds": [],
                "seriesIndex": -1,
            }],
            "musics": [
                {"id": "music.main", "musicName": "Main Song", "artist": "Composer"},
                {"id": "music.disco", "musicName": "DiscO Song", "artist": "Artist"},
            ],
            "illustrations": [
                {"id": "illustration.main", "artist": "Painter"},
                {"id": "illustration.disco", "artist": "Painter 2"},
            ],
            "discs": [
                {"name": "Main", "shortName": "M"},
                {"name": "DiscO", "shortName": "D"},
            ],
            "layoutColors": [{
                "id": "layout.00001",
                "bgColor1": {"r": 0},
                "bgColor2": {"r": 1},
                "fgColor": {"r": 1},
            }],
        },
        static_cards={
            "staticCardsInfo": [{
                "cardId": "rizcard.character",
                "cardName": "Nami",
                "rizcard": {
                    "avatarId": "avatar.npc.nami",
                    "backgroundId": "background.a",
                    "layoutId": "layout.00001",
                    "bioId1": "bio.a",
                    "bioId2": "bio.b",
                },
            }],
        },
        resolved_series_posters={},
        notes=[],
    )


class PatchMetadataTests(unittest.TestCase):
    def test_parser_and_cached_mapping_reject_unsafe_versions(self) -> None:
        with self.assertRaises(PatchMetadataError):
            PatchMetadata.parse("../escape\nAndroid/a.bundle\n")
        value = _patch_list({"Android/a.bundle": "v2"}).to_dict()
        value["file_to_version"] = {"Android/a.bundle": "../escape"}
        with self.assertRaises(PatchMetadataError):
            PatchList.from_dict(value)
        with self.assertRaises(PatchMetadataError):
            PatchMetadataResolver(
                "https://assets.example/versions",
                "../escape",
                "Android",
                Path("unused"),
            )

    def test_parser_preserves_declared_previous_and_paths(self) -> None:
        parsed = PatchMetadata.parse(
            "v2\nAndroid/a.bundle\niOS/a.bundle\n"
        )
        self.assertEqual(parsed.previous_resource_version, "v2")
        self.assertEqual(
            parsed.patched_filepaths,
            ("Android/a.bundle", "iOS/a.bundle"),
        )

    def test_parser_rejects_traversal_and_backslashes(self) -> None:
        for text in (
            "v2\n../a.bundle\n",
            "v2\nAndroid\\a.bundle\n",
            "  \n\t\n",
        ):
            with self.subTest(text=text):
                with self.assertRaises(PatchMetadataError):
                    PatchMetadata.parse(text)

    def test_declared_chain_newest_mapping_wins_and_cache_roundtrips(self) -> None:
        responses = {
            "v3": b"v2\nAndroid/a.bundle\nAndroid/shared.bundle\n",
            "v2": b"v1\nAndroid/b.bundle\nAndroid/shared.bundle\n",
        }
        calls: list[str] = []

        def fetch(url: str) -> FetchedPatchMetadata:
            version = url.rsplit("/", 2)[-2]
            calls.append(version)
            return (FetchedPatchMetadata(200, responses[version])
                    if version in responses else FetchedPatchMetadata(404, b""))

        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "patch_list.json"
            resolver = PatchMetadataResolver(
                "https://assets.example/versions",
                "v3",
                "Android",
                cache,
                fetch=fetch,
            )
            patch_list = resolver.build()
            self.assertEqual(calls, ["v3", "v2", "v1"])
            self.assertEqual(patch_list.status, "COMPLETE")
            self.assertEqual(
                patch_list.resource_version_for_platform("Android", "a.bundle"),
                "v3",
            )
            self.assertEqual(
                patch_list.resource_version_for_platform("Android", "b.bundle"),
                "v2",
            )
            self.assertEqual(
                patch_list.resource_version_for_platform("Android", "shared.bundle"),
                "v3",
            )
            self.assertEqual(
                resolver.build().source_metadata["cache_reused"],
                True,
            )

    def test_incomplete_chain_refuses_unmapped_files(self) -> None:
        with self.assertRaises(PatchChainIncomplete):
            _patch_list({}, status="PATCH_CHAIN_INCOMPLETE").resource_version_for_platform(
                "Android", "missing.bundle"
            )


class DirectResolverTests(unittest.TestCase):
    def _requirement(self, size: int = 8) -> BundleRequirement:
        return BundleRequirement(
            dependency_key="bundle-key",
            bundle_name="bundle-name",
            bundle_hash="a" * 32,
            bundle_size=size,
            crc=0,
            internal_id="https://host/" + "a" * 32 + ".bundle",
            provider="UnityEngine.AddressableAssets.ResourceProviders.AssetBundleProvider",
            server_filename="a" * 32 + ".bundle",
        )

    def test_url_uses_patch_mapping_platform_and_server_filename(self) -> None:
        filename = "a" * 32 + ".bundle"
        resolver = DirectAssetResolver(
            "https://assets.example/versions",
            _patch_list({"Android/" + filename: "v2"}),
            Path("unused"),
        )
        version, selected, url = resolver.construct_url(self._requirement())
        self.assertEqual((version, selected), ("v2", filename))
        self.assertEqual(
            url,
            f"https://assets.example/versions/v2/Android/{filename}",
        )

    def test_size_and_unity_header_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "payload.bundle"
            path.write_bytes(b"UnityFS\x00")
            valid, reason = DirectAssetResolver._verify(
                path, self._requirement(size=8)
            )
            self.assertTrue(valid, reason)
            valid, reason = DirectAssetResolver._verify(
                path, self._requirement(size=9)
            )
            self.assertFalse(valid)
            self.assertTrue(reason.startswith("SIZE_MISMATCH"))

    def test_mock_download_is_verified_and_manifest_serializable(self) -> None:
        filename = "a" * 32 + ".bundle"

        class MockResolver(DirectAssetResolver):
            def _download(self, url: str, target: Path) -> tuple[int, bool]:
                target.write_bytes(b"UnityFS\x00")
                return 200, False

        with tempfile.TemporaryDirectory() as temporary:
            resolver = MockResolver(
                "https://assets.example/versions",
                _patch_list({"Android/" + filename: "v2"}),
                Path(temporary),
            )
            record = resolver.acquire(self._requirement())
            self.assertEqual(record.verification_status, "VERIFIED")
            self.assertEqual(record.downloaded_size, 8)
            encoded = json.dumps(record.to_dict(), sort_keys=True)
            self.assertIn("REMOTE", encoded.upper())
            self.assertIn(filename, encoded)

    def test_tampered_bundle_cache_is_redownloaded(self) -> None:
        filename = "a" * 32 + ".bundle"

        class MockResolver(DirectAssetResolver):
            downloads = 0

            def _download(self, url: str, target: Path) -> tuple[int, bool]:
                self.downloads += 1
                target.write_bytes(b"UnityFS\x00a")
                return 200, False

        with tempfile.TemporaryDirectory() as temporary:
            resolver = MockResolver(
                "https://assets.example/versions",
                _patch_list({"Android/" + filename: "v2"}),
                Path(temporary),
            )
            requirement = self._requirement(size=9)
            first = resolver.acquire(requirement)
            self.assertEqual(first.verification_status, "VERIFIED")
            Path(first.cache_path).write_bytes(b"UnityFS\x00b")
            second = resolver.acquire(requirement)
            self.assertEqual(second.verification_status, "VERIFIED")
            self.assertEqual(resolver.downloads, 2)

    def test_tampered_catalog_cache_is_redownloaded(self) -> None:
        filename = "catalog_catalog.json"
        payload = {
            "m_KeyDataString": "",
            "m_BucketDataString": "",
            "m_EntryDataString": "",
            "m_ExtraDataString": "",
            "m_InternalIds": [],
            "m_ProviderIds": [],
        }

        class MockResolver(DirectAssetResolver):
            downloads = 0

            def _download(self, url: str, target: Path) -> tuple[int, bool]:
                self.downloads += 1
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(payload), encoding="utf-8")
                return 200, False

        with tempfile.TemporaryDirectory() as temporary:
            resolver = MockResolver(
                "https://assets.example/versions",
                _patch_list({"Android/" + filename: "v2"}),
                Path(temporary) / "bundle_cache",
            )
            first, evidence = resolver.acquire_catalog()
            self.assertIsNotNone(first, evidence)
            tampered = dict(payload)
            tampered["unexpected"] = True
            Path(first).write_text(json.dumps(tampered), encoding="utf-8")
            second, evidence = resolver.acquire_catalog()
            self.assertIsNotNone(second, evidence)
            self.assertEqual(resolver.downloads, 2)


class SemanticPolicyTests(unittest.TestCase):
    def test_stable_ids_and_filesystem_ids(self) -> None:
        self.assertEqual(
            stable_asset_id("seriesPoster", "00001"),
            "rizline:series:00001:poster",
        )
        self.assertEqual(
            stable_asset_id("seriesBanner", "00001"),
            "rizline:series:00001:banner",
        )
        self.assertEqual(
            filesystem_id("rizline:series:00001:poster"),
            "rizline-series-00001-poster",
        )
        self.assertNotEqual(
            filesystem_id("rizline:illustration:天地開闢.kuro.0"),
            filesystem_id("rizline:illustration:水槽に沈む街.kuro.0"),
        )


    def test_variant_policy_prefers_hires_but_keeps_both_layouts(self) -> None:
        illustration = {
            "asset_family": "illustration",
            "variants": [
                {"variant": "normal", "logical_key": "illustration.a"},
                {"variant": "hires", "logical_key": "illustration.a.HiRes"},
            ],
        }
        layout = {
            "asset_family": "layout",
            "variants": [
                {"variant": "normal", "logical_key": "layout.a"},
                {"variant": "hires", "logical_key": "layout.a.HiRes"},
            ],
        }
        self.assertEqual(
            selected_variant_keys(illustration),
            ["illustration.a.HiRes"],
        )
        self.assertEqual(
            selected_variant_keys(layout),
            ["layout.a", "layout.a.HiRes"],
        )

    def test_layout_relation_distinguishes_scale_and_variation(self) -> None:
        normal = Image.new("RGBA", (16, 16), "red")
        hires = Image.new("RGBA", (32, 32), "red")
        same = layout_variant_relation(normal, hires, "0", "0")
        self.assertEqual(same["relation"], "SAME_VISUAL_HIGHER_RES")
        variation = layout_variant_relation(
            normal, Image.new("RGBA", (32, 32), "blue"), "0", "ffffffffffffffff"
        )
        self.assertEqual(variation["relation"], "VISUAL_VARIATION")

    def test_rizcard_classification_uses_static_card_config(self) -> None:
        cards = static_card_metadata(_asset_list_result())
        self.assertEqual(
            classify_rizcard("rizcard.character", cards),
            ("CHARACTER_RIZCARD", "COMPOSITE"),
        )
        self.assertEqual(
            classify_rizcard("rizcard.Static00001", cards),
            ("STATIC_CARD_ART", "STATIC_ONLY"),
        )
        self.assertEqual(
            classify_rizcard("rizcard.Static00001", cards, "UnityEngine.GameObject"),
            ("PARTIAL_COMPOSITE", "COMPOSITE"),
        )

        self.assertEqual(
            classify_rizcard("rizcard.Default", cards),
            ("RIZCARD_TEMPLATE", "COMPOSITE"),
        )


    def test_primary_only_export_never_falls_back_to_sibling(self) -> None:
        def metadata(path_id: int) -> ResolvedObject:
            return ResolvedObject(
                resolved_object_type="Sprite",
                object_name=f"sprite-{path_id}",
                object_path_id=path_id,
                width=8,
                height=8,
                texture_format="RGBA32",
                has_alpha="yes",
                mipmap_count=1,
                sprite_rect=None,
                sprite_pivot=None,
                sprite_full_texture=None,
                texture_source_path_id=None,
                sprite_atlas_path_id=None,
                decoded_sha256=None,
                phash=None,
            )

        parsed = ParsedBundle(
            unity_version="2021",
            object_counts={"Sprite": 2},
            images=[
                ParsedImage(metadata(1), Image.new("RGBA", (8, 8)), is_primary=False),
                ParsedImage(metadata(2), None, is_primary=True),
            ],
        )
        self.assertIsNotNone(choose_export_image(parsed))
        self.assertIsNone(choose_export_image(parsed, require_primary=True))

    def test_reconciliation_removes_only_unreferenced_generated_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            current = output / "canonical" / "current.png"
            stale = output / "canonical" / "stale.png"
            preview = output / "previews" / "current.webp"
            for path in (current, stale, preview):
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (2, 2)).save(path)
            removed = _reconcile_generated_files(
                output,
                [{
                    "canonical_path": "canonical/current.png",
                    "preview_path": "previews/current.webp",
                }],
                [],
            )
            self.assertEqual(removed, ["canonical/stale.png"])
            self.assertTrue(current.is_file())
            self.assertTrue(preview.is_file())

    def test_series_pairing_requires_exact_primary_object_names(self) -> None:
        poster = {
            "asset_family": "seriesPoster",
            "semantic_id": "00001",
            "canonical_assets": [{"object": {"object_name": "00001"}}],
            "metadata": {},
        }
        banner = {
            "asset_family": "seriesBanner",
            "semantic_id": "00001",
            "canonical_assets": [{"object": {"object_name": "00001"}}],
            "metadata": {},
        }
        self.assertEqual(
            _apply_high_confidence_series_pairing([poster, banner]), 1,
        )
        self.assertEqual(poster["series_id"], banner["series_id"])
        self.assertEqual(
            poster["series_pairing_evidence"]["confidence"], "HIGH",
        )
        mismatch = {
            "asset_family": "seriesBanner",
            "semantic_id": "00002",
            "canonical_assets": [{"object": {"object_name": "Different"}}],
            "metadata": {},
        }
        matching_poster = {**poster, "semantic_id": "00002"}
        self.assertEqual(
            _apply_high_confidence_series_pairing([matching_poster, mismatch]), 0,
        )

class AssetListMappingTests(unittest.TestCase):
    def test_song_mapping_includes_regular_and_disco_levels(self) -> None:
        songs = song_metadata(_asset_list_result())
        self.assertEqual(songs["illustration.main"]["song_title"], "Main Song")
        self.assertEqual(songs["illustration.disco"]["song_title"], "DiscO Song")
        self.assertEqual(songs["illustration.main"]["illustrator"], "Painter")

    def test_layout_and_static_card_fields_are_preserved(self) -> None:
        result = _asset_list_result()
        layouts = layout_metadata(result)
        cards = static_card_metadata(result)
        self.assertEqual(layouts["layout.00001"]["layout_id"], "layout.00001")
        self.assertEqual(cards["rizcard.character"]["character_name"], "Nami")
        self.assertEqual(
            cards["rizcard.character"]["avatar_key"], "avatar.npc.nami"
        )


class AcquisitionManifestResumeTests(unittest.TestCase):
    def test_checkpoint_does_not_replace_complete_manifest(self) -> None:
        version = GameVersion(
            game="Rizline",
            package_name="com.example",
            version_name="2.7.0",
            version_code="82",
            apk_sha256="apk-sha",
            catalog_sha256="embedded-sha",
            catalog_build_hash="build",
        )
        snapshot = CatalogSnapshot(
            raw={"m_BuildResultHash": "build"},
            key_names=(),
            key_entries=(),
            entries=(),
        )
        catalog_evidence = {"sha256": "remote-sha"}

        def row(asset_id: str) -> dict[str, object]:
            return {
                "asset_id": asset_id,
                "logical_key": f"illustration.{asset_id}",
                "requested_variant": "normal",
                "catalog_build_hash": "build",
                "acquisition_status": "SUCCESS",
                "parse_status": "SUCCESS",
                "variant_fallback": None,
            }

        complete_rows = [row("one"), row("two")]
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            manifest_path = output / "manifests" / "acquisition_manifest.json"
            checkpoint_path = (
                output / "manifests" / "acquisition_manifest.checkpoint.json"
            )
            _write_acquisition_manifest(
                output,
                version,
                _patch_list({}),
                catalog_evidence,
                {},
                complete_rows,
                checkpoint=False,
            )
            _write_acquisition_manifest(
                output,
                version,
                _patch_list({}),
                catalog_evidence,
                {},
                [row("one")],
                checkpoint=True,
            )

            complete = json.loads(manifest_path.read_text(encoding="utf-8"))
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertFalse(complete["checkpoint"])
            self.assertEqual(len(complete["records"]), 2)
            self.assertTrue(checkpoint["checkpoint"])
            self.assertEqual(len(checkpoint["records"]), 1)
            self.assertEqual(
                len(_load_resume_rows(output, version, snapshot, catalog_evidence)),
                2,
            )

            _write_acquisition_manifest(
                output,
                version,
                _patch_list({}),
                catalog_evidence,
                {},
                complete_rows,
                checkpoint=False,
            )
            self.assertFalse(checkpoint_path.exists())


@unittest.skipUnless(
    INTEGRATION_ENABLED,
    "remote Life is PIANO integration requires explicit --integration",
)
class LifeIsPianoIntegrationTests(unittest.TestCase):
    def test_remote_hires_bundle_decodes(self) -> None:
        apk = Path("apk") / "律动轨迹_2.7.0.apk"
        output = Path("temp") / "rizline_publish_prep"
        self.assertTrue(apk.is_file(), f"APK missing: {apk}")
        version, _embedded_catalog = load_apk_catalog(apk)
        patch_list = PatchMetadataResolver(
            DEFAULT_RESOURCE_BASE_URL,
            DEFAULT_RESOURCE_VERSION,
            "Android",
            output / "cache" / "patch_list.json",
        ).build()
        resolver = DirectAssetResolver(
            DEFAULT_RESOURCE_BASE_URL,
            patch_list,
            output / "bundle_cache",
        )
        catalog_path, catalog_evidence = resolver.acquire_catalog()
        self.assertIsNotNone(catalog_path, catalog_evidence)
        catalog = load_catalog_file(
            catalog_path, catalog_role="integration/remote-canonical"
        )
        results = {}
        for logical_key, expected_size in (
            ("illustration.LifeisPIANO.Junk.0", (512, 512)),
            ("illustration.LifeisPIANO.Junk.0.HiRes", (2048, 2048)),
        ):
            resolution = resolve_logical_key(catalog, logical_key)
            self.assertIsNotNone(resolution)
            self.assertIsNotNone(resolution.asset.bundle)
            remote = resolver.acquire(resolution.asset.bundle)
            self.assertEqual(
                remote.verification_status, "VERIFIED", remote.error
            )
            parsed = UnityBundleParser().parse(
                Path(remote.cache_path), resolution.asset.object_internal_ids
            )
            image = choose_export_image(parsed, require_primary=True)
            self.assertIsNotNone(image)
            self.assertTrue(image.is_primary)
            self.assertIn(
                image.metadata.object_path_id,
                parsed.primary_path_ids,
            )
            results[logical_key] = (
                (image.metadata.width, image.metadata.height),
                remote.selected_resource_version,
            )
            self.assertEqual(results[logical_key][0], expected_size)
        self.assertEqual(
            results["illustration.LifeisPIANO.Junk.0.HiRes"][1],
            "v135_2_7_0_94115e2aaeP",
        )
        self.assertEqual(version.version_name, "2.7.0")


if __name__ == "__main__":
    unittest.main()
