"""Locate a single JD verification icon without retaining image data."""

import base64
import io
import json
import sys

import cv2
import numpy as np
from PIL import Image

cv2.setNumThreads(1)


def decode(value, size):
    if (
        not isinstance(value, str)
        or not value.startswith("data:image/")
        or len(value) > 200000
    ):
        raise ValueError("image")
    data = base64.b64decode(value.split(",", 1)[1], validate=True)
    with Image.open(io.BytesIO(data)) as header:
        if header.size != size or header.format not in ("PNG", "JPEG"):
            raise ValueError("geometry")
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image")
    return image


def solve(payload):
    scene, tip = decode(payload["scene"], (275, 170)), decode(payload["tip"], (108, 36))
    if scene.shape[:2] != (170, 275) or tip.shape[:2] != (36, 108):
        return {"failure": "geometry", "acceptedPlan": False}
    cv2.setRNGSeed(7)
    mask = np.zeros(tip.shape[:2], np.uint8)
    bg = np.zeros((1, 65), np.float64)
    fg = np.zeros((1, 65), np.float64)
    cv2.grabCut(tip, mask, (34, 0, 40, 36), bg, fg, 6, cv2.GC_INIT_WITH_RECT)
    fore = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    count = int(fore.sum())
    out = {
        "matcher": "segmented-shape",
        "foregroundPixels": count,
        "acceptedPlan": False,
    }
    if count < 60 or count > 900:
        return dict(out, failure="foreground")
    lab = cv2.cvtColor(tip, cv2.COLOR_BGR2LAB).astype(np.float32)
    sl = cv2.cvtColor(scene, cv2.COLOR_BGR2LAB).astype(np.float32)
    colors = lab[fore > 0]
    _, _, centers = cv2.kmeans(
        colors,
        8,
        None,
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.1),
        3,
        cv2.KMEANS_PP_CENTERS,
    )
    distances = np.min(
        np.linalg.norm(sl[:, :, None, :] - centers[None, None, :, :], axis=3), axis=2
    )
    scene_mask = (distances < 25).astype(np.float32)
    glyph = fore[:, 36:72].astype(np.float32)
    # Shape IoU compares foreground and surrounding negative space. Search all
    # rotations; centre-aligned transforms are independent of candidate choices.
    proposals = []
    for scale in np.arange(0.7, 1.61, 0.1):
        for angle in range(0, 360, 10):
            size = int(np.ceil(52 * scale))
            matrix = cv2.getRotationMatrix2D((18, 18), angle, scale)
            matrix[:, 2] += (size - 36) / 2
            template = cv2.warpAffine(
                glyph, matrix, (size, size), flags=cv2.INTER_NEAREST
            )
            area = float(template.sum())
            if area < 30:
                continue
            overlap = cv2.matchTemplate(scene_mask, template, cv2.TM_CCORR)
            sums = cv2.matchTemplate(scene_mask, np.ones_like(template), cv2.TM_CCORR)
            score = overlap / np.maximum(1, area + sums - overlap)
            for _ in range(3):
                _, best, _, pos = cv2.minMaxLoc(score)
                x, y = pos
                proposals.append(
                    {
                        "iou": float(best),
                        "x": x + size / 2,
                        "y": y + size / 2,
                        "size": size,
                        "angle": angle,
                        "scale": float(scale),
                        "matrix": matrix,
                        "left": x,
                        "top": y,
                    }
                )
                cv2.circle(score, pos, 20, -1, -1)
    proposals.sort(key=lambda p: p["iou"], reverse=True)
    if not proposals:
        return dict(out, failure="matching")
    ys, xs = np.where(glyph > 0)

    def agreement_for(proposal):
        coordinates = np.column_stack((xs, ys, np.ones(len(xs)))) @ proposal["matrix"].T
        dest = np.rint(
            coordinates + np.array([proposal["left"], proposal["top"]])
        ).astype(int)
        valid = (
            (dest[:, 0] >= 0)
            & (dest[:, 0] < 275)
            & (dest[:, 1] >= 0)
            & (dest[:, 1] < 170)
        )
        if not valid.all():
            return 0.0
        delta = np.linalg.norm(lab[ys, xs + 36] - sl[dest[:, 1], dest[:, 0]], axis=1)
        return float((delta < 35).mean())

    # A round silhouette can maximize IoU at the wrong orientation. Require
    # shape AND colour to agree in the same pose, without relaxing either gate.
    first = proposals[0]
    original_agreement = agreement_for(first)
    best = next(
        (p for p in proposals if p["iou"] >= 0.62 and agreement_for(p) >= 0.75), first
    )
    agreement = agreement_for(best)
    second = next(
        (p for p in proposals if np.hypot(p["x"] - best["x"], p["y"] - best["y"]) > 30),
        None,
    )
    margin = best["iou"] - (second["iou"] if second else 0)
    accepted = best["iou"] >= 0.62 and margin >= 0.12 and agreement >= 0.75
    out["bestShapeColorAgreement"] = round(original_agreement, 3)
    out["jointPose"] = best is not first
    out.update(
        iou=round(best["iou"], 3),
        competitor=round(second["iou"], 3) if second else None,
        margin=round(margin, 3),
        colorAgreement=round(agreement, 3),
        scale=round(best["scale"], 2),
        acceptedPlan=bool(accepted),
    )
    if accepted:
        out.update(x=best["x"], y=best["y"])
    else:
        out["failure"] = "ambiguous"
    return out


def locate(payload):
    result = solve(payload)
    return (
        {key: result[key] for key in ("x", "y")} if result.get("acceptedPlan") else None
    )


def reply(payload):
    """A point, or only why the matcher declined: a prompt or scene in another layout,
    an unreadable image, no icon in the prompt, no pose, or no clear winner."""
    try:
        result = solve(payload)
    except ValueError as error:
        return {"failure": "geometry" if str(error) == "geometry" else "image"}
    if result.get("acceptedPlan"):
        return {key: result[key] for key in ("x", "y")}
    failure = result.get("failure", "ambiguous")
    return {
        "failure": failure,
        **({"foregroundPixels": result["foregroundPixels"]} if failure == "foreground" else {}),
    }


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(500_001)
        if len(raw) > 500_000:
            raise ValueError("Image input too large")
        print(json.dumps(reply(json.loads(raw))))
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OSError,
        cv2.error,
        Image.DecompressionBombError,
    ):
        print("null")
