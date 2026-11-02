"""Locate the page's puzzle pieces; never submit or retain a challenge."""
import base64
import json
import os
import sys

os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", "1048576")
import cv2
import numpy as np

cv2.setNumThreads(1)


def decode(value):
    if not isinstance(value, str) or len(value) > 1_500_000:
        return None
    if not value.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
        return None
    try:
        raw = base64.b64decode(value.split(",", 1)[1], validate=True)
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
    except Exception:
        return None
    if image is None or len(image.shape) != 3 or image.shape[2] not in (3, 4):
        return None
    if min(image.shape[:2]) < 32 or max(image.shape[:2]) > 1024:
        return None
    return image


def tight_mask(mask):
    ys, xs = np.where(mask)
    return mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1] if len(xs) else None


def normalized_mask(mask, preserve_aspect=False):
    cropped = tight_mask(mask)
    if cropped is None:
        return None
    if not preserve_aspect:
        return cv2.resize(cropped, (64, 64), interpolation=cv2.INTER_AREA) > .35
    height, width = cropped.shape
    scale = 64 / max(height, width)
    resized = cv2.resize(cropped, (max(1, round(width * scale)), max(1, round(height * scale))),
                         interpolation=cv2.INTER_AREA)
    centered = np.zeros((64, 64), np.float32)
    y, x = (64 - resized.shape[0]) // 2, (64 - resized.shape[1]) // 2
    centered[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return centered > .35


def locate_icons(challenge, background):
    template = decode(challenge.get("templateImage"))
    count = challenge.get("clickCount")
    if (type(count) is not int or not 2 <= count <= 6 or template is None or template.shape[2] != 4
            or [template.shape[1], template.shape[0]] != [challenge.get("templateImageWidth"),
                                                        challenge.get("templateImageHeight")]):
        return None
    prompt = (template[:, :, 3] > 128).astype(np.float32)
    # The prompt's equal cells hold transparent monochrome icons. Their
    # coloured counterparts have a black outline and may be rotated.
    hsv = cv2.cvtColor(background[:, :, :3], cv2.COLOR_BGR2HSV)
    candidates = []
    for hue in range(0, 180, 15):
        delta = np.abs(hsv[:, :, 0].astype(np.int16) - hue)
        delta = np.minimum(delta, 180 - delta)
        # Separate colours before joining disconnected parts of one icon.
        # Otherwise a saturated photograph can join the icon to its scenery.
        ink = ((hsv[:, :, 1] > 140) & (hsv[:, :, 2] > 155) & (delta <= 10)).astype(np.uint8)
        _, labels, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(ink, np.ones((9, 9), np.uint8)))
        for index, (x, y, width, height, _) in enumerate(stats[1:], 1):
            if not 20 <= width <= 150 or not 20 <= height <= 150:
                continue
            mask = (ink[y:y + height, x:x + width] * (labels[y:y + height, x:x + width] == index)).astype(np.float32)
            area = int(mask.sum())
            if area < 200:
                continue
            ys, xs = np.where(mask)
            center = (int(round(x + xs.mean())), int(round(y + ys.mean())))
            duplicate = next((i for i, (point, *_) in enumerate(candidates)
                              if np.hypot(point[0] - center[0], point[1] - center[1]) < 15), None)
            candidate = (center, normalized_mask(mask), area, normalized_mask(mask, preserve_aspect=True))
            if duplicate is None:
                candidates.append(candidate)
            elif candidates[duplicate][2] < area:
                candidates[duplicate] = candidate
    if not count <= len(candidates) <= 24:
        return None
    chosen = []
    for index in range(count):
        glyph = tight_mask(prompt[:, round(index * template.shape[1] / count):
                                  round((index + 1) * template.shape[1] / count)])
        if glyph is None or min(glyph.shape) < 8 or glyph.mean() > .95:
            return None
        square = np.pad(glyph, ((50, 50), (50, 50)))
        shapes = []
        for angle in range(-45, 46, 3):
            matrix = cv2.getRotationMatrix2D((square.shape[1] / 2, square.shape[0] / 2), angle, 1)
            rotated = cv2.warpAffine(square, matrix, (square.shape[1], square.shape[0]))
            shapes.append((normalized_mask(rotated), normalized_mask(rotated, preserve_aspect=True)))

        def similarities(preserve_aspect=False):
            scores = [0.] * len(candidates)
            for normalized in shapes:
                shape = normalized[1 if preserve_aspect else 0]
                for candidate, value in enumerate(candidates):
                    mask = value[3 if preserve_aspect else 1]
                    scores[candidate] = max(scores[candidate], float((shape & mask).sum() / (shape | mask).sum()))
            return scores

        scores = similarities()
        ranked = sorted(enumerate(scores), key=lambda item: -item[1])
        best, score = ranked[0]
        if score < .68:
            return None
        if score - ranked[1][1] < .09:
            # Stretching both axes can make distinct proportions look alike.
            # Resolve that ambiguity only with an independently distinct match
            # that also belongs to the original set of plausible silhouettes.
            proportional = sorted(enumerate(similarities(True)), key=lambda item: -item[1])
            candidate, confidence = proportional[0]
            if (confidence < .68 or confidence - proportional[1][1] < .09
                    or scores[candidate] < .68 or score - scores[candidate] >= .09):
                return None
            best = candidate
        if best in chosen:
            return None
        chosen.append(best)
    return {"points": [{"x": candidates[index][0][0], "y": candidates[index][0][1]} for index in chosen]}


def locate_rotation(challenge, background):
    template = decode(challenge.get("templateImage"))
    if (template is None or template.shape[2] != 4 or template.shape[0] != background.shape[0]
            or [template.shape[1], template.shape[0]] != [challenge.get("templateImageWidth"),
                                                        challenge.get("templateImageHeight")]):
        return None
    ys, xs = np.where(template[:, :, 3] > 128)
    if not len(xs):
        return None
    width, height = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    radius = min(width, height) / 2
    if (not 20 <= radius < min(background.shape[:2]) / 2 - 8 or abs(width - height) > 3
            or abs((xs.min() + xs.max()) / 2 - template.shape[1] / 2) > 2
            or abs((ys.min() + ys.max()) / 2 - template.shape[0] / 2) > 2
            or not .9 < len(xs) / (np.pi * radius * radius) < 1.05):
        return None
    angles = np.arange(360) * np.pi / 180

    def ring(image, low, high):
        radii = np.arange(low, high, dtype=np.float32)[:, None]
        xx = (image.shape[1] / 2 + radii * np.cos(angles)).astype(np.float32)
        yy = (image.shape[0] / 2 + radii * np.sin(angles)).astype(np.float32)
        return cv2.remap(image[:, :, :3], xx, yy, cv2.INTER_LINEAR).astype(np.float32).mean(axis=0)

    # Compare the photograph on either side of the circular seam. Keep clear
    # of the coloured rim, and require two inner rings to agree independently.
    outside = ring(background, radius + 1, radius + 5)
    answers = []
    for fraction in (.88, .90):
        inside = ring(template, radius * fraction, radius * fraction + 4)
        costs = sorted((float(np.abs(np.roll(inside, angle, axis=0) - outside).mean()), angle)
                       for angle in range(360))
        best = costs[0]
        competitor = next(item for item in costs if min(abs(item[1] - best[1]), 360 - abs(item[1] - best[1])) > 15)
        if best[0] > 55 or competitor[0] < best[0] * 1.15 + 2:
            return None
        answers.append(best[1])
    difference = (answers[1] - answers[0] + 180) % 360 - 180
    if abs(difference) > 4:
        return None
    angle = (answers[0] + difference / 2) % 360
    return {"x": int(round(angle / 360 * background.shape[1])) % background.shape[1]}


def locate(challenge):
    if not isinstance(challenge, dict) or challenge.get("type") not in ("SLIDER", "CONCAT", "ICON_CLICK", "ROTATE"):
        return None
    background = decode(challenge.get("backgroundImage"))
    if background is None or [background.shape[1], background.shape[0]] != [
            challenge.get("backgroundImageWidth"), challenge.get("backgroundImageHeight")]:
        return None
    if challenge["type"] == "ICON_CLICK":
        return locate_icons(challenge, background)
    if challenge["type"] == "ROTATE":
        return locate_rotation(challenge, background)
    if challenge["type"] == "CONCAT":
        top = challenge.get("concatTopHeight")
        if not isinstance(top, int) or top < 8 or top > background.shape[0] - 8:
            return None
        # The page moves its upper strip cyclically to the right. The two
        # sides of a correct seam retain the photograph's colour continuity.
        above = background[top - 3:top, :, :3].astype(np.float32).mean(axis=0)
        below = background[top:top + 3, :, :3].astype(np.float32).mean(axis=0)
        costs = sorted((float(np.abs(np.roll(above, x, axis=0) - below).mean()), x)
                       for x in range(background.shape[1]))
        best = costs[0]
        other = next((item for item in costs if min(abs(item[1] - best[1]),
                     background.shape[1] - abs(item[1] - best[1])) > background.shape[1] / 20), None)
        if best[0] >= 25 or other is None or other[0] <= best[0] * 1.3 + 1:
            return None
        return {"x": best[1]}
    template = decode(challenge.get("templateImage"))
    if template is None or template.shape[2] != 4:
        return None
    height, width = background.shape[:2]
    if (template.shape[0] != height or template.shape[1] >= width
            or [width, height, template.shape[1], template.shape[0]] != [
                challenge.get("backgroundImageWidth"), challenge.get("backgroundImageHeight"),
                challenge.get("templateImageWidth"), challenge.get("templateImageHeight")]):
        return None
    opaque = (template[:, :, 3] > 220).astype(np.uint8)
    outline = opaque - cv2.erode(opaque, np.ones((3, 3), np.uint8))
    ys, xs = np.where(outline)
    if len(xs) < 100 or len(xs) > 2000 or ys.min() < 4 or ys.max() >= height - 4:
        return None
    gray = cv2.cvtColor(background, cv2.COLOR_BGRA2GRAY if background.shape[2] == 4 else cv2.COLOR_BGR2GRAY)
    # Dense photograph edges can look like the cutout at an unrelated position.
    # Prefer a unique texture match when the outline at that position agrees;
    # the strongest edge anywhere in the photo need not be the puzzle's edge.
    interior = cv2.erode(opaque, np.ones((7, 7), np.uint8))
    if interior.sum() >= 100:
        scores = cv2.matchTemplate(gray, cv2.cvtColor(template, cv2.COLOR_BGRA2GRAY),
                                   cv2.TM_CCOEFF_NORMED, mask=interior)
        scores = np.nan_to_num(scores, nan=-1, posinf=-1, neginf=-1)
        scores[:, :12] = -1
        _, score, _, location = cv2.minMaxLoc(scores)
        x = location[0]
        radius = max(1, int(template.shape[1] / 3))
        scores[:, max(0, x - radius):x + radius + 1] = -1
        distance = cv2.distanceTransform((cv2.Canny(gray, 40, 80) == 0).astype(np.uint8), cv2.DIST_L2, 3)
        contour = min(float(np.minimum(distance[ys + dy, xs + x], 5).mean()) for dy in range(-3, 4))
        if score >= .5 and score - float(scores.max()) > .12 and contour < 1.3:
            return {"x": x}
    matches = []
    low_peak = None
    for lower, upper, minimum_margin in ((120, 240, .3), (80, 160, .3), (40, 80, .5)):
        edges = cv2.Canny(gray, lower, upper)
        distance = cv2.distanceTransform((edges == 0).astype(np.uint8), cv2.DIST_L2, 3)
        candidates = []
        for dy in range(-3, 4):
            for x in range(12, width - template.shape[1]):
                cost = float(np.minimum(distance[ys + dy, xs + x], 5).mean())
                candidates.append((cost, x))
        if not candidates:
            return None
        candidates.sort()
        best = candidates[0]
        competitor = next((item for item in candidates if abs(item[1] - best[1]) > template.shape[1] / 3), None)
        # Distractors can share a fill. Require a distinct contour, and reject
        # edge scales that confidently disagree about its position.
        if best[0] < 1.3 and competitor is not None and competitor[0] - best[0] > minimum_margin:
            matches.append(best[1])
        if lower == 40:
            low_peak = best
    if matches:
        return {"x": int(round(sum(matches) / len(matches)))} if max(matches) - min(matches) <= 3 else None
    # A faded cutout can lose its strong outline while retaining photograph
    # texture. Accept that only when independent texture and edge peaks agree.
    interior = cv2.erode(opaque, np.ones((7, 7), np.uint8))
    if interior.sum() < 100:
        return None
    scores = cv2.matchTemplate(gray, cv2.cvtColor(template, cv2.COLOR_BGRA2GRAY),
                               cv2.TM_CCOEFF_NORMED, mask=interior)
    scores = np.nan_to_num(scores, nan=-1, posinf=-1, neginf=-1)
    scores[:, :12] = -1
    _, score, _, location = cv2.minMaxLoc(scores)
    x = location[0]
    radius = max(1, int(template.shape[1] / 3))
    scores[:, max(0, x - radius):x + radius + 1] = -1
    other = float(scores.max())
    return {"x": x} if (score >= .5 and score - other > .12 and low_peak is not None
                         and low_peak[0] < 1 and abs(low_peak[1] - x) <= 2) else None



if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(3_100_001)
        answer = locate(json.loads(raw)) if len(raw) <= 3_100_000 else None
    except Exception:
        answer = None
    print(json.dumps(answer))
