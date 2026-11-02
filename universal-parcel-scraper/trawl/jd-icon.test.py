"""Synthetic checks for the optional offline JD icon worker."""

import base64
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location(
    "jd_icon", Path(__file__).with_name("jd-icon.py")
)
icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icon)


def png(image):
    return (
        "data:image/png;base64,"
        + base64.b64encode(cv2.imencode(".png", image)[1]).decode()
    )


def puzzle(angle=40, scale=1.3, duplicate=False, absent=False):
    yy, xx = np.mgrid[:170, :275]
    scene = np.stack(
        (170 + 10 * np.sin(xx / 20), 100 + 10 * np.cos(yy / 30), 40 + 0 * xx), axis=2
    ).astype(np.uint8)
    tip = np.full((36, 108, 3), (175, 105, 45), np.uint8)
    mask = np.zeros((36, 36), np.uint8)
    cv2.circle(mask, (18, 18), 13, 255, -1)
    glyph = np.full((36, 36, 3), (20, 190, 245), np.uint8)
    glyph[:, :16] = (25, 45, 230)
    cv2.rectangle(glyph, (20, 10), (24, 25), (35, 235, 70), -1)
    tip[:, 36:72][mask > 0] = glyph[mask > 0]
    matrix = cv2.getRotationMatrix2D((18, 18), angle, scale)
    matrix[:, 2] += 14
    transformed_mask = cv2.warpAffine(mask, matrix, (64, 64), flags=cv2.INTER_NEAREST)
    transformed = cv2.warpAffine(glyph, matrix, (64, 64))
    positions = [] if absent else [(170, 100)]
    if duplicate:
        positions.append((70, 55))
    for x, y in positions:
        scene[y - 32 : y + 32, x - 32 : x + 32][transformed_mask > 0] = transformed[
            transformed_mask > 0
        ]
    # A same-colour but differently shaped distractor must not win by colour.
    cv2.fillPoly(scene, [np.array([[40, 120], [25, 150], [55, 150]])], (20, 190, 245))
    return {"scene": png(scene), "tip": png(tip)}


class IconTests(unittest.TestCase):
    def test_rotated_scaled_icon_uses_one_consistent_pose(self):
        for angle, scale in [(40, 1.3), (120, 0.9), (270, 1.5)]:
            with self.subTest(angle=angle, scale=scale):
                result = icon.locate(puzzle(angle, scale))
                self.assertIsNotNone(result)
                self.assertAlmostEqual(result["x"], 170, delta=4)
                self.assertAlmostEqual(result["y"], 100, delta=4)

    def test_duplicate_and_missing_icons_are_ambiguous(self):
        self.assertIsNone(icon.locate(puzzle(duplicate=True)))
        self.assertIsNone(icon.locate(puzzle(absent=True)))

    def test_blank_prompt_does_not_guess(self):
        data = puzzle()
        data["tip"] = png(np.full((36, 108, 3), 100, np.uint8))
        self.assertIsNone(icon.locate(data))

    def test_unknown_geometry_and_oversized_input_are_rejected(self):
        data = puzzle()
        data["scene"] = png(np.zeros((171, 275, 3), np.uint8))
        with self.assertRaises(ValueError):
            icon.locate(data)
        with self.assertRaises(ValueError):
            icon.decode("data:image/png;base64," + "A" * 200001, (275, 170))

    def test_worker_protocol_returns_only_a_point_or_null(self):
        worker = str(Path(__file__).with_name("jd-icon.py"))
        for data in [json.dumps(puzzle()), "{"]:
            result = subprocess.run(
                [sys.executable, worker],
                input=data,
                text=True,
                capture_output=True,
                timeout=3,
                check=True,
            )
            value = json.loads(result.stdout)
            if data == "{":
                self.assertIsNone(value)
            else:
                self.assertEqual(set(value), {"x", "y"})
                self.assertAlmostEqual(value["x"], 170, delta=4)
                self.assertAlmostEqual(value["y"], 100, delta=4)

    def test_worker_says_only_why_it_declined(self):
        worker = str(Path(__file__).with_name("jd-icon.py"))
        resized = puzzle()
        resized["scene"] = png(np.zeros((171, 275, 3), np.uint8))
        blank = puzzle()
        blank["tip"] = png(np.full((36, 108, 3), 100, np.uint8))
        for data, expected in [
            (puzzle(duplicate=True), {"failure": "ambiguous"}),
            (resized, {"failure": "geometry"}),
            (blank, {"failure": "foreground", "foregroundPixels": 0}),
        ]:
            result = subprocess.run(
                [sys.executable, worker],
                input=json.dumps(data),
                text=True,
                capture_output=True,
                timeout=3,
                check=True,
            )
            self.assertEqual(json.loads(result.stdout), expected)

    def test_dense_prompt_records_only_rejected_foreground_count(self):
        data = puzzle()
        tip = np.full((36, 108, 3), (175, 105, 45), np.uint8)
        tip[:, 36:72] = (20, 190, 245)
        data["tip"] = png(tip)
        self.assertEqual(
            icon.reply(data), {"failure": "foreground", "foregroundPixels": 1296}
        )


if __name__ == "__main__":
    unittest.main()
