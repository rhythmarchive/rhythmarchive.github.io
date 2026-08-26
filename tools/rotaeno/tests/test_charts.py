import unittest

from tools.rotaeno.charts import _pointer_path_id, chart_difficulty, chart_metadata, chart_song_hint, format_rating


class ChartMetadataTests(unittest.TestCase):
    def test_standard_chart_projects_class_rating_and_charter(self) -> None:
        tree = {
            "m_Name": "demo-song [IV]",
            "levelId": 3,
            "v2InnerDifficulty": 12.899999618530273,
            "overrideSongInfo": {"charterName": {"_constantString": "Chart Team"}},
        }
        self.assertEqual(chart_song_hint(tree), "demo-song")
        self.assertEqual(chart_difficulty(tree), "IV")
        self.assertEqual(format_rating(tree["v2InnerDifficulty"]), "12.9")
        self.assertEqual(
            chart_metadata(tree),
            {"difficulty": "IV", "level": "12.9", "artist": "Chart Team", "available": True, "status": "available"},
        )

    def test_alpha_suffix_is_preserved_for_filtering(self) -> None:
        tree = {"m_Name": "demo-song [IV_Alpha]", "levelId": 200, "v2InnerDifficulty": 13.4}
        self.assertEqual(chart_difficulty(tree), "IV_Alpha")
        self.assertEqual(chart_metadata(tree), {"difficulty": "IV_Alpha", "level": "13.4", "available": True, "status": "available"})

    def test_cross_bundle_pointers_are_not_resolved_as_local_objects(self) -> None:
        self.assertEqual(_pointer_path_id({"m_PathID": 42, "m_FileID": 0}), 42)
        self.assertIsNone(_pointer_path_id({"m_PathID": 42, "m_FileID": 1}))
        self.assertIsNone(format_rating(float("nan")))
        self.assertIsNone(format_rating(float("inf")))

    def test_level_id_fallback_supports_missing_name_suffix(self) -> None:
        self.assertEqual(chart_difficulty({"levelId": 0}), "I")
        self.assertEqual(chart_difficulty({"levelId": 1}), "II")
        self.assertEqual(chart_difficulty({"levelId": 2}), "III")
        self.assertEqual(chart_difficulty({"levelId": 3}), "IV")
        self.assertIsNone(chart_difficulty({"levelId": 100}))


if __name__ == "__main__":
    unittest.main()
