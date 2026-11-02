"""Synthetic image checks; run with the optional TRAWL Python runtime."""
import base64
import importlib.util
import os
from pathlib import Path
import unittest

import cv2
import numpy as np

module = Path(os.environ.get('SWIFTX_SLIDER_MODULE', Path(__file__).with_name('swiftx-slider.py')))
spec = importlib.util.spec_from_file_location('swiftx_slider', module)
slider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slider)


def png(image):
    return 'data:image/png;base64,' + base64.b64encode(cv2.imencode('.png', image)[1]).decode()


def puzzle(positions=(150,)):
    height, width, tile_width = 180, 320, 64
    mask = np.zeros((height, tile_width), np.uint8)
    cv2.rectangle(mask, (12, 60), (52, 108), 255, -1)
    cv2.circle(mask, (12, 75), 8, 0, -1)
    cv2.circle(mask, (52, 90), 8, 255, -1)
    cv2.circle(mask, (34, 108), 8, 0, -1)
    tile = np.full((height, tile_width, 4), 120, np.uint8)
    tile[:, :, 3] = mask
    background = np.full((height, width, 3), 80, np.uint8)
    edge = mask - cv2.erode(mask, np.ones((3, 3), np.uint8))
    for x in positions:
        region = background[:, x:x + tile_width]
        region[mask > 0] = 20
        region[edge > 0] = 250
    return dict(type='SLIDER', backgroundImage=png(background), templateImage=png(tile),
                backgroundImageWidth=width, backgroundImageHeight=height,
                templateImageWidth=tile_width, templateImageHeight=height)


def icon_puzzle(duplicate=False):
    glyphs = []
    for index in range(3):
        glyph = np.zeros((60, 60), np.uint8)
        if index == 0:
            cv2.circle(glyph, (30, 30), 18, 255, -1)
        elif index == 1:
            cv2.fillPoly(glyph, [np.array([[30, 10], [10, 48], [50, 48]])], 255)
        else:
            cv2.rectangle(glyph, (24, 10), (36, 50), 255, -1)
            cv2.rectangle(glyph, (10, 24), (50, 36), 255, -1)
        glyphs.append(glyph)
    template = np.full((60, 180, 4), 60, np.uint8)
    template[:, :, 3] = np.concatenate(glyphs, axis=1)
    background = np.full((240, 480, 3), 40, np.uint8)
    positions = [(340, 120), (80, 70), (220, 170)]
    for index, (x, y) in enumerate(positions):
        mask = cv2.warpAffine(glyphs[index], cv2.getRotationMatrix2D((30, 30), 15 * index, 1), (60, 60))
        region = background[y - 30:y + 30, x - 30:x + 30]
        region[mask > 128] = [(255, 120, 0), (0, 210, 255), (230, 0, 230)][index]
    if duplicate:
        background[20:80, 250:310][glyphs[0] > 128] = (255, 120, 0)
    return dict(type='ICON_CLICK', backgroundImage=png(background), templateImage=png(template),
                backgroundImageWidth=480, backgroundImageHeight=240,
                templateImageWidth=180, templateImageHeight=60, clickCount=3), positions


def proportional_icons(duplicate=False):
    glyphs = []
    for axes in ((18, 18), (25, 12)):
        glyph = np.zeros((60, 60), np.uint8)
        cv2.ellipse(glyph, (30, 30), axes, 0, 0, 360, 255, -1)
        glyphs.append(glyph)
    template = np.full((60, 120, 4), 60, np.uint8)
    template[:, :, 3] = np.concatenate(glyphs, axis=1)
    background = np.full((240, 480, 3), 40, np.uint8)
    positions = [(100, 100), (320, 160)]
    for index, (x, y) in enumerate(positions):
        mask = cv2.warpAffine(glyphs[index], cv2.getRotationMatrix2D((30, 30), 24 * index, 1), (60, 60))
        background[y - 30:y + 30, x - 30:x + 30][mask > 128] = [(255, 120, 0), (0, 210, 255)][index]
    if duplicate:
        background[20:80, 250:310][glyphs[0] > 128] = (230, 0, 230)
    return dict(type='ICON_CLICK', backgroundImage=png(background), templateImage=png(template),
                backgroundImageWidth=480, backgroundImageHeight=240,
                templateImageWidth=120, templateImageHeight=60, clickCount=2), positions


class SliderTests(unittest.TestCase):
    def test_rotation_seam_and_uniform_ambiguity(self):
        height, width, radius = 360, 600, 90
        yy, xx = np.mgrid[:height, :width]
        angle = np.arctan2(yy - height / 2, xx - width / 2)
        original = np.stack((120 + 80 * np.sin(angle * 3 + .8), 120 + 80 * np.cos(angle * 2),
                             120 + 80 * np.sin(angle * 5)), axis=2).astype(np.uint8)
        mask = np.zeros((height, 200), np.uint8)
        cv2.circle(mask, (100, height // 2), radius, 255, -1)
        template = np.dstack((original[:, 200:400], mask))
        template = cv2.warpAffine(template, cv2.getRotationMatrix2D((100, height / 2), -120, 1), (200, height))
        background = original.copy()
        cv2.circle(background, (width // 2, height // 2), radius, (0, 0, 0), -1)
        data = dict(type='ROTATE', backgroundImage=png(background), templateImage=png(template),
                    backgroundImageWidth=width, backgroundImageHeight=height,
                    templateImageWidth=200, templateImageHeight=height)
        self.assertAlmostEqual(slider.locate(data)['x'], 400, delta=4)
        background[:] = 80
        template[:, :, :3] = 80
        data.update(backgroundImage=png(background), templateImage=png(template))
        self.assertIsNone(slider.locate(data))

    def test_ordered_rotated_icons(self):
        data, expected = icon_puzzle()
        actual = slider.locate(data)
        self.assertIsNotNone(actual)
        for point, (x, y) in zip(actual['points'], expected):
            self.assertAlmostEqual(point['x'], x, delta=4)
            self.assertAlmostEqual(point['y'], y, delta=5)

    def test_icon_ambiguity_and_shape_changes(self):
        data, _ = icon_puzzle(duplicate=True)
        self.assertIsNone(slider.locate(data))
        data, _ = icon_puzzle()
        for changed in (dict(data, clickCount=0), dict(data, clickCount=7),
                        dict(data, templateImageWidth=181), dict(data, backgroundImageWidth=479)):
            self.assertIsNone(slider.locate(changed))

    def test_icons_touching_a_differently_coloured_photograph(self):
        data, expected = icon_puzzle()
        background = slider.decode(data['backgroundImage'])
        # A saturated nearby shape joins the icon under a single saturation
        # mask. Its different hue must not become part of the icon's contour.
        cv2.rectangle(background, (365, 100), (470, 145), (0, 100, 190), -1)
        data['backgroundImage'] = png(background)
        actual = slider.locate(data)
        self.assertIsNotNone(actual)
        self.assertAlmostEqual(actual['points'][0]['x'], expected[0][0], delta=4)

    def test_icon_proportions_resolve_stretched_silhouette_ambiguity(self):
        data, expected = proportional_icons()
        actual = slider.locate(data)
        self.assertIsNotNone(actual)
        for point, (x, y) in zip(actual['points'], expected):
            self.assertAlmostEqual(point['x'], x, delta=4)
            self.assertAlmostEqual(point['y'], y, delta=4)

    def test_icon_proportions_still_reject_duplicate_shapes(self):
        data, _ = proportional_icons(duplicate=True)
        self.assertIsNone(slider.locate(data))

    def test_photograph_texture_disambiguates_a_faded_cutout(self):
        data = puzzle((150,))
        tile = slider.decode(data['templateImage'])
        rng = np.random.default_rng(9)
        original = rng.integers(30, 200, (180, 320, 3), dtype=np.uint8)
        mask = tile[:, :, 3] > 220
        tile[:, :, :3] = original[:, 150:214]
        background = original.copy()
        region = background[:, 150:214]
        region[mask] = (region[mask] * .65 + 55).astype(np.uint8)
        data.update(backgroundImage=png(background), templateImage=png(tile))
        self.assertAlmostEqual(slider.locate(data)['x'], 150, delta=1)

    def test_joined_image(self):
        width, height, top = 320, 180, 90
        x = np.arange(width)
        colour = np.stack((120 + 70 * np.sin(x / 13), 120 + 60 * np.cos(x / 9),
                           120 + 65 * np.sin(x / 17)), axis=1)
        background = np.clip(np.tile(colour, (height, 1, 1)), 0, 255).astype(np.uint8)
        background[:top] = np.roll(background[:top], -73, axis=1)
        data = dict(type='CONCAT', backgroundImage=png(background),
                    backgroundImageWidth=width, backgroundImageHeight=height, concatTopHeight=top)
        self.assertEqual(slider.locate(data), {'x': 73})
        data['backgroundImage'] = png(np.full((height, width, 3), 80, np.uint8))
        self.assertIsNone(slider.locate(data))

    def test_unique_contour(self):
        self.assertAlmostEqual(slider.locate(puzzle())['x'], 150, delta=1)
        data = puzzle()
        background = slider.decode(data['backgroundImage'])
        background[np.all(background == 250, axis=2)] = 115
        data['backgroundImage'] = png(background)
        self.assertAlmostEqual(slider.locate(data)['x'], 150, delta=1)

    def test_ambiguous_contours(self):
        self.assertIsNone(slider.locate(puzzle((40, 180))))

    def test_dimension_mismatch(self):
        data = puzzle()
        data['backgroundImageWidth'] += 1
        self.assertIsNone(slider.locate(data))

    def test_invalid_or_unsupported(self):
        for data in (None, {}, dict(puzzle(), type='ROTATE'), dict(puzzle(), backgroundImage='invalid')):
            self.assertIsNone(slider.locate(data))

    def test_no_puzzle_outline(self):
        data = puzzle()
        data['templateImage'] = png(np.full((180, 64, 4), 255, np.uint8))
        self.assertIsNone(slider.locate(data))


if __name__ == '__main__':
    unittest.main()
