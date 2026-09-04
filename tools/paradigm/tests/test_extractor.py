import unittest

from tools.paradigm.extractor import AVATAR, BACKGROUND, PACK_COVER, classify_texture


class ClassifyTextureTests(unittest.TestCase):
    def test_avatar_requires_named_square_texture(self):
        self.assertEqual(classify_texture("Para新头像", 256, 256), AVATAR)
        self.assertIsNone(classify_texture("头像框", 256, 256))
        self.assertIsNone(classify_texture("Para新头像", 512, 512))

    def test_pack_cover_uses_the_shop_banner_dimensions(self):
        self.assertEqual(classify_texture("COP2026曲包横幅", 1639, 268), PACK_COVER)
        self.assertIsNone(classify_texture("曲包FC牌子", 1000, 180))

    def test_background_excludes_named_ui_fragments(self):
        self.assertEqual(classify_texture("Menu背景", 2048, 1229), BACKGROUND)
        self.assertIsNone(classify_texture("背景风暴元素", 1024, 1024))
        self.assertIsNone(classify_texture("Background", 32, 32))


if __name__ == "__main__":
    unittest.main()
