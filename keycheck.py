"""Plausibilitätsprüfung der erkannten Tonart anhand der Akkordsymbole.

homr liest die Vorzeichnung manchmal falsch, besonders bei unscharfen Vorlagen
(z. B. 6 ♯ statt 1 ♭). Weil homr die Tonhöhen aus der Vorzeichnung ableitet, sind
dann alle betroffenen Noten falsch (Fis statt F …). Die Akkordsymbole liest die
Texterkennung dagegen unabhängig davon. Passen sie deutlich besser zu einer anderen
Tonart, wird die Vorzeichnung korrigiert: Die Noten bleiben auf ihren Linien, nur die
von der Vorzeichnung stammenden Vorzeichen werden angepasst. Echte Versetzungszeichen
(Töne, die von der alten Vorzeichnung abweichen) bleiben erhalten.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

STEP_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
SHARP_ORDER = "FCGDAEB"
FLAT_ORDER = "BEADGCF"
# Stufen einer Dur-Tonleiter (Halbtöne über dem Grundton) -> erwartetes Tongeschlecht
DEGREE_QUALITY = {0: "major", 2: "minor", 4: "minor", 5: "major", 7: "major", 9: "minor", 11: "dim"}
MINOR_KINDS = {"minor", "minor-seventh", "minor-sixth", "minor-ninth", "minor-11th", "minor-13th", "major-minor"}
DIM_KINDS = {"diminished", "diminished-seventh", "half-diminished"}


def key_alter(fifths: int, step: str) -> int:
    if fifths > 0 and step in SHARP_ORDER[:fifths]:
        return 1
    if fifths < 0 and step in FLAT_ORDER[:-fifths]:
        return -1
    return 0


def _int(el: ET.Element | None, default: int = 0) -> int:
    try:
        return int(round(float(el.text))) if el is not None and el.text else default
    except ValueError:
        return default


def single_fit(pc: int, quality: str, fifths: int) -> float:
    degree = (pc - (7 * fifths) % 12) % 12
    expected = DEGREE_QUALITY.get(degree)
    if expected is None:
        return 0.0
    if expected == quality or (expected == "dim" and quality == "minor"):
        return 1.0
    return 0.5                    # leitereigener Grundton, anderes Tongeschlecht (z. B. Zwischendominante)


def chord_fit(chords: list, fifths: int) -> float:
    """Wie gut passen die Akkorde zur Dur-Tonart (bzw. ihrer Paralleltonart)?

    Die Texterkennung verliert gern kleine hochgestellte Vorzeichen (B♭ -> B). Ein Akkord
    ohne Vorzeichen darf deshalb das Vorzeichen haben, das die Tonart seinem Grundton gibt –
    jede solche Annahme kostet aber etwas. Eine falsch gelesene Vorzeichnung braucht viele
    dieser Annahmen und verliert so gegen die richtige.
    """
    if not chords:
        return 0.0
    score = lost = 0.0
    for pc, quality, plain, step in chords:
        fit = single_fit(pc, quality, fifths)
        if plain and key_alter(fifths, step):
            adjusted = single_fit((pc + key_alter(fifths, step)) % 12, quality, fifths)
            if adjusted > fit:
                fit = adjusted
                lost += 1
        score += fit
    return score / len(chords) - 0.4 * lost / len(chords)


def _chord_of(h: ET.Element) -> tuple[int, str, bool, str] | None:
    step = h.findtext("root/root-step")
    if not step or step.strip() not in STEP_PC:
        return None
    alter = _int(h.find("root/root-alter"))
    pc = (STEP_PC[step.strip()] + alter) % 12
    kind = (h.findtext("kind") or "major").strip()
    quality = "minor" if kind in MINOR_KINDS else "dim" if kind in DIM_KINDS else "major"
    return pc, quality, alter == 0, step.strip()


def _fix_chord_roots(harmonies: list[ET.Element], fifths: int, log) -> None:
    """Akkorde, deren Vorzeichen offensichtlich verloren ging (B statt B♭ in F-Dur), ergänzen."""
    for h in harmonies:
        c = _chord_of(h)
        if not c or not c[2] or single_fit(c[0], c[1], fifths) > 0:
            continue
        root = h.find("root")
        step = c[3]
        for delta in (key_alter(fifths, step),):
            if delta and single_fit((c[0] + delta) % 12, c[1], fifths) == 1.0:
                alter = ET.Element("root-alter")
                alter.text = str(delta)
                root.insert(list(root).index(root.find("root-step")) + 1, alter)
                log(f"Akkord ergänzt: {step} -> {step}{'#' if delta > 0 else 'b'}")
                break


def correct_keys(score: ET.Element, log=print) -> int:
    """Korrigiert unplausible Vorzeichnungen; liefert die Zahl der korrigierten Abschnitte."""
    parts = score.findall("part")
    if not parts:
        return 0
    measures = [p.findall("measure") for p in parts]
    count = min(len(m) for m in measures)

    # Abschnitte mit gleicher Vorzeichnung (Tonartwechsel stehen in allen Parts im selben Takt)
    starts, keys, current = [], [], None
    for i in range(count):
        el = None
        for p in measures:
            el = p[i].find("attributes/key/fifths")
            if el is not None:
                break
        if el is not None and _int(el) != current:
            current = _int(el)
            starts.append(i)
            keys.append(current)
    if not starts:
        return 0
    bounds = list(zip(starts, starts[1:] + [count], keys))

    fixed = 0
    for start, end, old in bounds:
        chords, harmonies = [], []
        for p in measures:
            for m in p[start:end]:
                for h in m.findall("harmony"):
                    c = _chord_of(h)
                    if c:
                        chords.append(c)
                        harmonies.append(h)
        if len(chords) < 3:
            continue
        old_fit = chord_fit(chords, old)
        best = max(range(-7, 8), key=lambda f: (chord_fit(chords, f), -abs(f - old)))
        best_fit = chord_fit(chords, best)
        if best == old or best_fit < 0.6 or best_fit - old_fit < 0.12:
            _fix_chord_roots(harmonies, old, log)
            continue
        log(f"Tonart korrigiert (Takte {start + 1}–{end}): {old:+d} -> {best:+d} Vorzeichen "
            f"(Akkorde passen zu {old_fit:.0%} bzw. {best_fit:.0%})")
        for p in measures:
            for m in p[start:end]:
                for k in m.findall("attributes/key/fifths"):
                    k.text = str(best)
                for note in m.findall("note"):
                    pitch = note.find("pitch")
                    if pitch is None:
                        continue
                    step = (pitch.findtext("step") or "").strip()
                    if step not in STEP_PC:
                        continue
                    alter_el = pitch.find("alter")
                    alter = _int(alter_el)
                    if alter != key_alter(old, step):
                        continue          # echtes Versetzungszeichen -> behalten
                    new = key_alter(best, step)
                    if new == alter:
                        continue
                    if new == 0:
                        if alter_el is not None:
                            pitch.remove(alter_el)
                    else:
                        if alter_el is None:
                            alter_el = ET.Element("alter")
                            pitch.insert(list(pitch).index(pitch.find("step")) + 1, alter_el)
                        alter_el.text = str(new)
                    for acc in note.findall("accidental"):
                        note.remove(acc)
        _fix_chord_roots(harmonies, best, log)
        fixed += 1
    return fixed
