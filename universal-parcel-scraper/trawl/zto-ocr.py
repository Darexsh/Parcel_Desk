"""Offline ordered-character matching for ZTO's Dingxiang popup."""
import base64
import io
import itertools
import json
import re
import sys

import onnxruntime

# ddddocr constructs its own sessions. Limit them before loading any models.
_session = onnxruntime.InferenceSession


def limited_session(*args, **kwargs):
    options = kwargs.get("sess_options") or onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    kwargs["sess_options"] = options
    return _session(*args, **kwargs)


onnxruntime.InferenceSession = limited_session

import cv2
import ddddocr
import numpy as np
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR


def solve(data):
    """Points in order, with how sure the match is, or the fixed label of what could not be read."""
    targets = data["targets"]
    if not isinstance(targets, str) or not re.fullmatch(r"[\u3400-\u9fff]{2,4}", targets):
        return {"failure": "targets"}
    image_bytes = base64.b64decode(data["image"], validate=True)
    if len(image_bytes) > 1_000_000:
        return {"failure": "image"}
    image = Image.open(io.BytesIO(image_bytes))
    if image.width > 600 or image.height > 400:
        return {"failure": "image"}
    image = image.convert("RGB")
    region = data["region"]
    x, y, w, h = [float(region[key]) for key in ("x", "y", "width", "height")]
    if not (0 <= x < x + w <= image.width + 1 and 0 <= y < y + h <= image.height + 1):
        return {"failure": "region"}
    detector = ddddocr.DdddOcr(det=True, ocr=False, show_ad=False)
    boxes = [b for b in detector.detection(image_bytes)
             if x <= b[0] < b[2] <= x + w and y <= b[1] < b[3] <= y + h]
    if not len(targets) <= len(boxes) <= 7:
        return {"failure": "boxes", "boxes": len(boxes)}
    ocr = ddddocr.DdddOcr(show_ad=False, beta=True)
    rapid = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    engine = ocr.ocr_engine
    charset = engine.charset_manager.get_charset()
    if any(c not in charset for c in targets):
        return {"failure": "charset", "boxes": len(boxes)}
    indices = [charset.index(c) for c in targets]
    input_name = engine.session.get_inputs()[0].name
    all_scores = []
    for box in boxes:
        crop = image.crop((max(0, box[0] - 3), max(0, box[1] - 3), box[2] + 3, box[3] + 3))
        a = np.array(crop).astype("int16")
        red, green, blue = a[:, :, 0], a[:, :, 1], a[:, :, 2]
        masks = [
            (a.min(2) > 130) & (a.max(2) - a.min(2) < 65),
            (green - red > 25) & (blue - red > 10) & (green > 140),
            (green - red > 15) & (green - blue > 15) & (green > 140),
            (red > 130) & (green > 110) & (blue < np.minimum(red, green) * 0.65),
        ]
        variants = [crop]
        for mask in masks:
            if mask.sum() >= 20:
                closed = cv2.morphologyEx(mask.astype("uint8") * 255, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
                variants.append(Image.fromarray(255 - closed).convert("RGB"))
        scores = {c: 0 for c in targets}
        images = []
        for variant in variants:
            for angle in range(0, 360, 30):
                rotated = variant.rotate(angle, expand=True, fillcolor="white")
                logits = engine.session.run(None, {input_name: engine._preprocess_image(rotated, False)})[0]
                ex = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
                probabilities = (ex / ex.sum(axis=-1, keepdims=True)).reshape(-1, len(charset))[:, indices]
                for j, char in enumerate(targets):
                    scores[char] = max(scores[char], float(probabilities[:, j].max()))
                images.append(np.array(ImageOps.expand(rotated, border=5, fill="white"))[:, :, ::-1])
        recognized, _ = rapid.text_rec(images)
        for text, confidence in recognized:
            if text and text in scores:
                scores[text] = max(scores[text], float(confidence))
        all_scores.append(scores)
    # Relative likelihood across different positions matters more than absolute
    # OCR confidence for rotated, outlined glyphs. The server verifies the order.
    ranked = sorted(((sum(np.log(max(all_scores[i][c], 1e-9)) for i, c in zip(p, targets)), p)
                     for p in itertools.permutations(range(len(boxes)), len(targets))),
                    key=lambda pair: pair[0], reverse=True)
    (best, order), runner_up = ranked[0], ranked[1][0]
    # Per character: the geometric mean probability of the chosen order, and how far
    # the next best order trails it. Logged beside the server's verdict to tune a threshold.
    return {"points": [{"x": (boxes[i][0] + boxes[i][2]) / 2, "y": (boxes[i][1] + boxes[i][3]) / 2} for i in order],
            "boxes": len(boxes), "confidence": round(float(np.exp(best / len(targets))), 3),
            "margin": round(float((best - runner_up) / len(targets)), 3)}


try:
    raw = sys.stdin.buffer.read(1_500_001)
    result = solve(json.loads(raw)) if len(raw) <= 1_500_000 else {"failure": "image"}
    print(json.dumps(result, separators=(",", ":")))
except Exception:
    print(json.dumps({"failure": "exception"}))
