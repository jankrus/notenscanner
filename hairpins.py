"""Crescendo- und Decrescendo-Gabeln im Notenbild finden.

Weder homr noch die Texterkennung kennen Gabeln. Sie werden hier direkt im Bild
gesucht: Notenzeilen und Text werden ausgeblendet, danach bleiben zusammenhängende
Striche übrig. Eine Gabel ist ein flacher, breiter Strichzug aus zwei Linien, deren
Abstand sich von einem Ende zum anderen gleichmäßig öffnet:

  * öffnet sie sich nach rechts  -> Crescendo   (<)
  * schließt sie sich nach rechts -> Decrescendo (>)

Bindebögen, Balken, Unterstriche im Liedtext und Notenhälse haben diese Form nicht.
"""

from __future__ import annotations

import re

import cv2
import numpy as np


def detect(image_path: str, staffs: list[dict], words: list = ()) -> list[dict]:
    """Liefert Gabeln als dict(kind, left, right, top, bottom) in Bildkoordinaten."""
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None or not staffs:
        return []
    unit = float(np.median([(s["bottom"] - s["top"]) / 4 for s in staffs]))
    if unit < 3:
        return []
    ink = (img < 150).astype(np.uint8)
    height, width = ink.shape

    # Notenzeilen (mit Noten darin) ausblenden
    for s in staffs:
        y0 = max(0, int(s["top"] - 0.6 * unit))
        y1 = min(height, int(s["bottom"] + 0.6 * unit) + 1)
        x0 = max(0, int(s["left"] - 3 * unit))
        x1 = min(width, int(s["right"] + 2 * unit) + 1)
        ink[y0:y1, x0:x1] = 0
    # Gelesenen Text ausblenden (nur echte Buchstaben/Ziffern, ein "<" könnte die Gabel selbst sein)
    for w in words:
        if re.search(r"[0-9A-Za-zÄÖÜäöüß]", getattr(w, "text", "")):
            ink[max(0, int(w.top)):int(w.bottom) + 1, max(0, int(w.left)):int(w.right) + 1] = 0

    # kleine Lücken (z. B. an der Spitze) schließen
    ink = cv2.dilate(ink, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)

    found = []
    for i in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[i])
        if not (3 * unit <= w <= 70 * unit and 0.6 * unit <= h <= 4 * unit and w >= 3 * h):
            continue
        if area > 0.4 * w * h:                    # zu "voll": Balken, Text, Notenköpfe
            continue
        comp = labels[y:y + h, x:x + w] == i
        step = max(1, w // 80)
        xs, spreads, middles = [], [], []
        two_runs = cols = 0
        for cx in range(0, w, step):
            ys = np.flatnonzero(comp[:, cx])
            if len(ys) == 0:
                continue
            cols += 1
            runs = 1 + int(np.count_nonzero(np.diff(ys) > 1))
            if runs == 2:
                two_runs += 1
            xs.append(cx)
            spreads.append(ys[-1] - ys[0])
            middles.append((ys[-1] + ys[0]) / 2)
        if cols < 10 or two_runs < 0.45 * cols:
            continue
        xs_a, sp = np.array(xs, float), np.array(spreads, float)
        if sp.std() < 1e-6:
            continue
        r = float(np.corrcoef(xs_a, sp)[0, 1])
        if abs(r) < 0.92:                         # Öffnung muss gleichmäßig wachsen/schrumpfen
            continue
        if sp.max() < 0.5 * unit or sp.min() > 0.45 * sp.max():
            continue
        if float(np.std(middles)) > 0.25 * h:     # Mittellinie muss waagrecht verlaufen
            continue
        found.append({
            "kind": "crescendo" if r > 0 else "diminuendo",
            "left": float(x), "right": float(x + w), "top": float(y), "bottom": float(y + h),
        })
    return found
