"""Read the ordered characters in China Post's public verification prompt."""
import base64
import io
import json
import re
import sys

import onnxruntime

_session = onnxruntime.InferenceSession


def limited_session(*args, **kwargs):
    options = kwargs.get("sess_options") or onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    kwargs["sess_options"] = options
    return _session(*args, **kwargs)


onnxruntime.InferenceSession = limited_session

import ddddocr
import numpy as np
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR


def valid_targets(text, count=None):
    pattern = r"[\u3400-\u9fff]{2,4}" if count is None else r"[\u3400-\u9fff]{%d}" % count
    return isinstance(text, str) and re.fullmatch(pattern, text) is not None


def read_targets(encoded):
    image_bytes = base64.b64decode(encoded, validate=True)
    image = Image.open(io.BytesIO(image_bytes))
    if not (0 < image.width <= 400 and 0 < image.height <= 150):
        raise ValueError("Invalid prompt dimensions")
    ocr = ddddocr.DdddOcr(show_ad=False, beta=True)
    original = ocr.classification(image_bytes)

    # The prompt has square glyph cells inside a three-pixel outer border.
    # Keep the whole-line reader for a different layout instead of guessing cuts.
    cell = image.height - 6
    count = (image.width - 6) // cell if cell > 0 else 0
    if cell < 20 or image.width - 6 != count * cell or count not in (2, 3, 4):
        return original if valid_targets(original) else None

    # Glyphs are neutral grey; coloured interference lines otherwise merge or
    # change characters in the whole-line read. Recognize each cell separately.
    rgba = np.array(image.convert("RGBA"))
    rgb = rgba[:, :, :3].astype("int16")
    mask = (rgb.max(2) - rgb.min(2) < 35) & (rgb.min(2) > 35) & (rgba[:, :, 3] > 80)
    cleaned = Image.fromarray(np.where(mask, 0, 255).astype("uint8"))
    crops = [ImageOps.expand(cleaned.crop((3 + i * cell, 3, 3 + (i + 1) * cell, 3 + cell))
                             .convert("RGB"), border=8, fill="white") for i in range(count)]
    rapid = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    records, _ = rapid.text_rec([np.array(crop)[:, :, ::-1] for crop in crops])
    records = records or []
    targets = []
    for index, crop in enumerate(crops):
        text, confidence = records[index] if index < len(records) else ("", 0)
        if isinstance(text, str) and re.fullmatch(r"[\u3400-\u9fff]", text) and confidence >= 0.85:
            targets.append(text)
            continue
        buffer = io.BytesIO()
        crop.save(buffer, format="PNG")
        text = ocr.classification(buffer.getvalue())
        if isinstance(text, str) and re.fullmatch(r"[\u3400-\u9fff]", text):
            targets.append(text)
        elif valid_targets(original, count):
            targets.append(original[index])
        else:
            # A shorter read cannot describe every click the prompt requires.
            return None
    return "".join(targets)

try:
    raw = sys.stdin.buffer.read(100_001)
    if len(raw) > 100_000:
        raise ValueError("Prompt too large")
    targets = read_targets(json.loads(raw))
    print(json.dumps(targets if targets is not None else {"failure": "unreadable"}))
except Exception:
    print("null")
