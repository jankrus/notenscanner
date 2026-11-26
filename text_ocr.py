"""Liedtext und Akkordsymbole per Texterkennung (OCR) einlesen.

Die Notenerkennung (homr) liest keinen Text. Hier wird jede Seite zusätzlich mit
RapidOCR gelesen. Die Textstücke werden über ihre Position den Notenzeilen zugeordnet:

  * Text, der dicht unter einer Notenzeile steht, ist Liedtext. Jede Silbe kommt an
    die Note der obersten Stimme dieser Zeile, die waagrecht am nächsten liegt.
  * Akkordsymbole (Am, D7, C/G …), die dicht über einer Notenzeile stehen, werden zu
    MusicXML-<harmony> an der Note bzw. Pause an dieser Stelle.

homr legt die Bildposition jeder Note als Kommentar "imgpos: x, y" in die Note.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

DYNAMICS = {"pppp", "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "ffff", "sf", "sfz", "sffz",
            "sfp", "fp", "fz", "rf", "rfz"}
# Ausdrucks- und Tempoanweisungen (italienisch und deutsch); Vergleich ohne Punkt, klein
EXPRESSIONS = {
    "rit", "ritard", "ritardando", "riten", "ritenuto", "rall", "rallentando", "accel", "accelerando",
    "a", "tempo", "primo", "i", "cresc", "crescendo", "decresc", "decrescendo", "dim", "diminuendo",
    "poco", "molto", "più", "piu", "meno", "sempre", "subito", "sub", "e", "al", "assai", "mosso",
    "legato", "dolce", "espressivo", "espr", "marcato", "cantabile", "morendo", "smorzando",
    "sostenuto", "tranquillo", "maestoso", "rubato", "fine", "d.c", "d.s", "dc", "ds", "coda",
    "langsam", "langsamer", "schneller", "ruhig", "ruhiger", "frei", "breit", "breiter",
    "zurückhaltend", "zurückhalten", "getragen", "fließend", "lebhaft", "bewegt", "zart", "kräftig",
    "leise", "laut", "lauter", "leiser", "wieder", "zeitmaß", "im", "wie", "anfang", "zum", "schluss",
}
# Einzelwörter, die allein keine Anweisung sind (nur zusammen mit anderen)
EXPRESSION_FILLERS = {"a", "e", "al", "i", "im", "wie", "zum", "poco", "molto", "più", "piu",
                      "meno", "sempre", "sub", "assai", "tempo", "primo", "wieder", "anfang", "schluss"}
CHORD_RE = re.compile(
    r"^\(?([A-H])([#b]?)((?:maj|min|dim|aug|sus|add|m|M|\+|°|ø|Δ)?(?:[#b]?[0-9]+)*(?:sus[24]?)?)"
    r"(?:/([A-H])([#b]?)[0-9]*)?\)?$"
)
KINDS = {
    "": "major", "m": "minor", "min": "minor", "7": "dominant", "maj7": "major-seventh",
    "M7": "major-seventh", "Δ": "major-seventh", "m7": "minor-seventh", "dim": "diminished",
    "°": "diminished", "dim7": "diminished-seventh", "°7": "diminished-seventh",
    "m7b5": "half-diminished", "ø": "half-diminished", "aug": "augmented", "+": "augmented",
    "sus": "suspended-fourth", "sus4": "suspended-fourth", "sus2": "suspended-second",
    "6": "major-sixth", "m6": "minor-sixth", "9": "dominant-ninth", "maj9": "major-ninth",
    "m9": "minor-ninth", "5": "power", "7sus4": "suspended-fourth",
}
NOTE_ORDER = [
    "grace", "cue", "chord", "pitch", "unpitched", "rest", "duration", "tie", "instrument",
    "footnote", "level", "voice", "type", "dot", "accidental", "time-modification", "stem",
    "notehead", "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen",
]
IMGPOS_RE = re.compile(r"imgpos:\s*(-?\d+),\s*(-?\d+)")

_engine = None


# ---------------------------------------------------------------- OCR

@dataclass
class Word:
    text: str
    left: float
    top: float
    right: float
    bottom: float
    score: float

    @property
    def cx(self) -> float:
        return (self.left + self.right) / 2

    @property
    def cy(self) -> float:
        return (self.top + self.bottom) / 2

    @property
    def height(self) -> float:
        return self.bottom - self.top


def _engine_instance():
    global _engine
    if _engine is None:
        from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

        _engine = RapidOCR(params={
            "Rec.lang_type": LangRec.LATIN,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.model_type": ModelType.MOBILE,
            "Global.use_cls": False,          # Notentext steht nie auf dem Kopf
            "Global.log_level": "error",
            "Global.max_side_len": 4000,
        })
    return _engine


def read_words(image_path: str) -> list[Word]:
    """Alle Wörter einer Seite mit Position (Koordinaten der Bilddatei)."""
    result = _engine_instance()(image_path, return_word_box=True)
    words: list[Word] = []
    if result is None or result.txts is None:
        return words
    lines = result.word_results or [None] * len(result.txts)
    for line_box, line_text, line_score, line_words in zip(result.boxes, result.txts, result.scores, lines):
        if line_words:
            for text, score, box in line_words:
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                words.append(Word(str(text), float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys)), float(score)))
        else:
            xs = [p[0] for p in line_box]
            ys = [p[1] for p in line_box]
            words.append(Word(str(line_text), float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys)), float(line_score)))
    return [w for w in words if w.text.strip()]


def word_to_json(w: Word) -> dict:
    return w.__dict__.copy()


def word_from_json(d: dict) -> Word:
    return Word(**d)


# ---------------------------------------------------------------- Geometrie

@dataclass
class StaffBox:
    system: int          # Index des Systems in der Liste aller Systeme
    part: int            # Index des Parts im System-XML
    staff: int           # Notenzeile innerhalb des Parts (1 oder 2)
    top: float
    bottom: float
    left: float
    right: float

    @property
    def unit(self) -> float:
        return max(4.0, (self.bottom - self.top) / 4)


def staff_geometry(staff, to_input) -> list[dict]:
    """Lage einer homr-Notenzeile (bei Doppelsystemen beide Zeilen) in Bildkoordinaten."""
    staffs = [staff]
    if getattr(staff, "is_grandstaff", False):
        split = staff.split()
        if split is not None:
            staffs = list(split)
    out = []
    for s in staffs:
        pts = []
        for p in s.grid:
            pts.append(to_input((p.x, p.y[0])))
            pts.append(to_input((p.x, p.y[-1])))
        xs = [float(q[0]) for q in pts]
        ys = [float(q[1]) for q in pts]
        out.append({"top": min(ys), "bottom": max(ys), "left": min(xs), "right": max(xs)})
    if getattr(staff, "is_grandstaff", False) and len(out) == 1:
        g = out[0]
        mid = (g["top"] + g["bottom"]) / 2
        out = [dict(g, bottom=mid - (mid - g["top"]) * 0.2), dict(g, top=mid + (g["bottom"] - mid) * 0.2)]
    return out


# ---------------------------------------------------------------- Hilfen für das XML

def imgpos(note: ET.Element) -> tuple[float, float] | None:
    for child in note:
        if child.tag is ET.Comment and child.text:
            m = IMGPOS_RE.search(child.text)
            if m:
                return float(m.group(1)), float(m.group(2))
    return None


def insert_ordered(note: ET.Element, el: ET.Element) -> None:
    idx = NOTE_ORDER.index(el.tag)
    for i, c in enumerate(note):
        if isinstance(c.tag, str) and c.tag in NOTE_ORDER and NOTE_ORDER.index(c.tag) > idx:
            note.insert(i, el)
            return
    note.append(el)


@dataclass
class Event:
    measure: ET.Element
    note: ET.Element          # Note bzw. Kopf eines Akkords
    x: float
    staff: int
    voice: str
    is_rest: bool
    tied_on: bool             # Fortsetzung eines Haltebogens


def events_of(part: ET.Element) -> list[Event]:
    out: list[Event] = []
    for measure in part.findall("measure"):
        for note in measure.findall("note"):
            if note.find("chord") is not None or note.find("grace") is not None:
                continue
            pos = imgpos(note)
            if pos is None:
                continue
            tied = any(t.get("type") == "stop" for t in note.findall("tie"))
            out.append(Event(measure, note, pos[0], int(note.findtext("staff", "1")),
                             note.findtext("voice", "1"), note.find("rest") is not None, tied))
    return out


# ---------------------------------------------------------------- Akkorde

def normalize_chord(text: str) -> str:
    """Übersetzt typische OCR-Fehler bei hochgestellten Vorzeichen zurück.

    Ein kleines hochgestelltes ♯ wird oft als ' oder " gelesen, ein ♮ als Backslash.
    Bei E und B ist ein Kreuz sehr unüblich, dort ist es meist ein Auflösungszeichen.
    """
    t = text.strip().replace("♯", "#").replace("♭", "b").replace("♮", "")
    t = t.replace("\\", "").replace("|", "")
    t = t.replace("Sus", "sus").replace("$us", "sus").replace("SUS", "sus")

    def fix(m: re.Match) -> str:
        root = m.group(1)
        return root if root in "EBH" else root + "#"

    return re.sub(r"([A-H])['\"’´`]+", fix, t)


def parse_chord(text: str) -> ET.Element | None:
    t = normalize_chord(text)
    m = CHORD_RE.match(t)
    if not m:
        return None
    root, alter, suffix, bass, bass_alter = m.groups()
    root = "B" if root == "H" else root
    harmony = ET.Element("harmony", placement="above")
    r = ET.SubElement(harmony, "root")
    ET.SubElement(r, "root-step").text = root
    if alter:
        ET.SubElement(r, "root-alter").text = "1" if alter == "#" else "-1"
    kind = ET.SubElement(harmony, "kind", text=suffix)
    kind.text = KINDS.get(suffix, "other")
    if bass:
        b = ET.SubElement(harmony, "bass")
        ET.SubElement(b, "bass-step").text = "B" if bass == "H" else bass
        if bass_alter:
            ET.SubElement(b, "bass-alter").text = "1" if bass_alter == "#" else "-1"
    return harmony


# ---------------------------------------------------------------- Liedtext

@dataclass
class Syllable:
    text: str
    left: float
    right: float
    hyphen_before: bool = False
    hyphen_after: bool = False
    extend: bool = False

    @property
    def cx(self) -> float:
        return (self.left + self.right) / 2


def syllables_of_row(words: list[Word]) -> list[Syllable]:
    """Zerlegt eine Textzeile in Silben ("Gna-de", "be - schrei -ben", "Kraft.___")."""
    out: list[Syllable] = []
    for w in sorted(words, key=lambda w: w.left):
        text = w.text.strip()
        if not text:
            continue
        if set(text) <= {"-", "–", "—"}:
            if out:
                out[-1].hyphen_after = True
            continue
        if set(text) <= {"_"}:
            if out:
                out[-1].extend = True
            continue
        if re.fullmatch(r"\d+\.", text):           # Strophennummer "1."
            continue
        trail_extend = text.endswith("_")
        text = text.rstrip("_")
        pieces = re.split(r"[-–—]", text)
        n = max(1, sum(len(p) for p in pieces))
        x = w.left
        width = w.right - w.left
        for i, piece in enumerate(pieces):
            share = width * (len(piece) / n if n else 1)
            if piece:
                syl = Syllable(piece, x, x + share)
                if i > 0:
                    syl.hyphen_before = True
                if i < len(pieces) - 1:
                    syl.hyphen_after = True
                if out and out[-1].hyphen_after:
                    syl.hyphen_before = True
                out.append(syl)
            elif i == 0 and out:
                out[-1].hyphen_after = True       # Wort beginnt mit "-"
            elif i > 0 and out:
                out[-1].hyphen_after = True       # Wort endet mit "-"
            x += share
        if trail_extend and out:
            out[-1].extend = True
    for a, b in zip(out, out[1:]):
        if a.hyphen_after:
            b.hyphen_before = True
        if b.hyphen_before:
            a.hyphen_after = True
    return out


def match_syllables(syllables: list[Syllable], events: list[Event]) -> list[tuple[Syllable, Event]]:
    """Verteilt die Silben einer Zeile so auf die Noten, dass die Abstände insgesamt
    am kleinsten sind (Reihenfolge bleibt erhalten, Noten dürfen frei bleiben = Melisma).

    Die Bildpositionen der Noten sind nur ungefähr; eine Gesamtzuordnung verkraftet
    einzelne Ausreißer viel besser als "nimm die nächste freie Note".
    """
    if not syllables or not events:
        return []
    spacing = (events[-1].x - events[0].x) / max(1, len(events) - 1) if len(events) > 1 else 100.0
    skip = 2.5 * max(spacing, 40.0)          # Kosten, eine Silbe nicht zuzuordnen
    n, m = len(syllables), len(events)
    inf = float("inf")
    # cost[i][k]: beste Kosten für die ersten i Silben mit den ersten k Noten
    cost = [[inf] * (m + 1) for _ in range(n + 1)]
    move = [[0] * (m + 1) for _ in range(n + 1)]   # 0 = Note frei, 1 = Silbe->Note, 2 = Silbe weg
    for k in range(m + 1):
        cost[0][k] = 0.0
    for i in range(1, n + 1):
        cost[i][0] = cost[i - 1][0] + skip
        move[i][0] = 2
        cx = syllables[i - 1].cx
        for k in range(1, m + 1):
            best, how = cost[i][k - 1], 0
            c = cost[i - 1][k - 1] + abs(events[k - 1].x - cx)
            if c < best:
                best, how = c, 1
            c = cost[i - 1][k] + skip
            if c < best:
                best, how = c, 2
            cost[i][k], move[i][k] = best, how
    pairs = []
    i, k = n, m
    while i > 0:
        how = move[i][k]
        if how == 1:
            pairs.append((syllables[i - 1], events[k - 1]))
            i, k = i - 1, k - 1
        elif how == 2 or k == 0:
            i -= 1
        else:
            k -= 1
    pairs.reverse()
    return pairs


def merge_chord_pieces(words: list[Word]) -> list[Word]:
    """Fügt direkt aneinanderstoßende Teile wieder zusammen ("B" + "m" -> "Bm")."""
    out: list[Word] = []
    for w in sorted(words, key=lambda w: w.left):
        if out:
            prev = out[-1]
            gap = w.left - prev.right
            same_row = abs(prev.cy - w.cy) < 0.6 * max(prev.height, w.height)
            if same_row and gap < 0.35 * max(prev.height, w.height) and                     parse_chord(prev.text + w.text) is not None:
                out[-1] = Word(prev.text + w.text, prev.left, min(prev.top, w.top), w.right,
                               max(prev.bottom, w.bottom), min(prev.score, w.score))
                continue
        out.append(w)
    return out


# ---------------------------------------------------------------- Zuordnung je Seite

def dynamic_name(text: str) -> str | None:
    # Dynamik steht immer in Kleinbuchstaben; "F" ist ein Akkord
    t = text.strip().replace("ƒ", "f").replace("𝆑", "f").replace("𝆏", "p").strip(".:;,!")
    if len(t) >= 2 and t.isupper():
        t = t.lower()                      # "PP", "MF": fett-kursive Dynamik als Großbuchstaben gelesen
    return t if t in DYNAMICS else None


def expression_key(text: str) -> str:
    return text.strip().lower().rstrip(".:;,!").replace("..", ".")


def is_expression_word(text: str) -> bool:
    return expression_key(text) in EXPRESSIONS


def merge_expressions(words: list[Word]) -> list[Word]:
    """Fasst nebeneinanderstehende Anweisungswörter zu einer Phrase zusammen ("poco rit.")."""
    out: list[Word] = []
    for w in sorted(words, key=lambda w: (round(w.cy / max(w.height, 1)), w.left)):
        if out and is_expression_word(w.text) and all(is_expression_word(p) for p in out[-1].text.split()):
            prev = out[-1]
            same_row = abs(prev.cy - w.cy) < 0.6 * max(prev.height, w.height)
            if same_row and -0.5 * max(prev.height, w.height) <= w.left - prev.right < 1.5 * max(prev.height, w.height):
                out[-1] = Word(prev.text + " " + w.text, prev.left, min(prev.top, w.top), w.right,
                               max(prev.bottom, w.bottom), min(prev.score, w.score))
                continue
        out.append(w)
    return out


PHRASES = {"a tempo", "tempo primo", "tempo i", "al fine", "wie am anfang", "im tempo", "a tempo primo"}


def is_expression(text: str) -> bool:
    parts = text.split()
    if " ".join(expression_key(p) for p in parts) in PHRASES:
        return True
    return bool(parts) and all(is_expression_word(p) for p in parts) and         not all(expression_key(p) in EXPRESSION_FILLERS for p in parts)


@dataclass
class PageText:
    lyrics: int = 0
    chords: int = 0
    dynamics: int = 0
    expressions: int = 0
    wedges: int = 0
    carry: dict = field(default_factory=dict)   # Silbentrennung über Systemgrenzen


def annotate_page(systems: list[ET.Element], boxes: list[StaffBox], words: list[Word],
                  state: PageText) -> None:
    """Fügt Liedtext und Akkorde einer Seite in die System-XMLs ein."""
    if not boxes:
        return
    boxes = sorted(boxes, key=lambda b: b.top)
    unit = sorted(b.unit for b in boxes)[len(boxes) // 2]
    page_left = min(b.left for b in boxes) - 4 * unit
    page_right = max(b.right for b in boxes) + 4 * unit

    lyric_words: dict[int, list[Word]] = {}      # Index der Notenzeile darüber -> Wörter
    chord_words: dict[int, list[Word]] = {}      # Index der Notenzeile darunter -> Wörter
    marks: list[tuple[int, str, Word, str]] = []  # (Notenzeile, Art, Wort, placement)
    # Bildpositionen aller Noten der Seite: ein Notenkopf mit Hals wird gern als "p" gelesen
    note_points = []
    for root in systems:
        for part in root.findall("part"):
            for note in part.iter("note"):
                pos = imgpos(note)
                if pos is not None:
                    note_points.append(pos)

    def covers_note(w: Word) -> bool:
        return any(w.left - 0.6 * unit <= x <= w.right + 0.6 * unit and
                   w.top - 0.8 * unit <= y <= w.bottom + 0.8 * unit for x, y in note_points)

    for w in merge_expressions(merge_chord_pieces(words)):
        if w.score < 0.5 or w.right < page_left or w.left > page_right:
            continue
        # Text innerhalb einer Notenzeile ist meist ein falsch gelesenes Notenzeichen
        if any(b.top - 0.5 * unit < w.cy < b.bottom + 0.5 * unit for b in boxes):
            continue
        text = w.text.strip()
        above = max((i for i, b in enumerate(boxes) if b.bottom <= w.cy), default=None,
                    key=lambda i: boxes[i].bottom)
        below = min((i for i, b in enumerate(boxes) if b.top >= w.cy), default=None,
                    key=lambda i: boxes[i].top)
        d_above = w.top - boxes[above].bottom if above is not None else float("inf")
        d_below = boxes[below].top - w.bottom if below is not None else float("inf")
        nearest = above if d_above <= d_below else below
        d_near = min(d_above, d_below)
        is_mark = (dynamic_name(text) and w.score >= 0.9) or (is_expression(text) and w.score >= 0.8)
        if nearest is not None and d_near < 5 * unit and is_mark and not covers_note(w):
            kind = "dynamic" if dynamic_name(text) else "words"
            placement = "below" if nearest == above else "above"
            marks.append((nearest, kind, w, placement))
            continue
        is_chord = parse_chord(text) is not None and w.score >= 0.8
        if is_chord and below is not None and (d_below <= d_above or above is None) and d_below < 6 * unit:
            chord_words.setdefault(below, []).append(w)
        elif above is not None and d_above < 7 * unit and re.search(r"[A-Za-zÄÖÜäöüß]", text) \
                and not dynamic_name(text) \
                and not re.fullmatch(r"-?\s*\d+\s*-?", text):
            lyric_words.setdefault(above, []).append(w)

    # ---- Dynamik und Ausdrucksanweisungen
    for idx, kind, w, placement in marks:
        box = boxes[idx]
        part = systems[box.system].findall("part")[box.part]
        events = events_of(part)
        if not events:
            continue
        anchor_x = w.left + min(w.right - w.left, 2 * unit) / 2
        ev = min(events, key=lambda e: abs(e.x - anchor_x))
        if abs(ev.x - anchor_x) > 6 * unit:
            continue
        if kind == "dynamic":
            name = dynamic_name(w.text)
            # nicht doppelt, wenn die Notenerkennung dasselbe Zeichen schon im Takt hat
            already = any(d.find("direction-type/dynamics/" + name) is not None and
                          d.findtext("staff", "1") == str(box.staff)
                          for d in ev.measure.findall("direction"))
            if already:
                continue
            direction = ET.Element("direction", placement=placement)
            dt = ET.SubElement(direction, "direction-type")
            ET.SubElement(ET.SubElement(dt, "dynamics"), name)
            state.dynamics += 1
        else:
            direction = ET.Element("direction", placement=placement)
            dt = ET.SubElement(direction, "direction-type")
            ET.SubElement(dt, "words", {"font-style": "italic"}).text = w.text.strip()
            state.expressions += 1
        ET.SubElement(direction, "staff").text = str(box.staff)
        children = list(ev.measure)
        ev.measure.insert(children.index(ev.note), direction)

    # ---- Akkorde
    for idx, ws in chord_words.items():
        box = boxes[idx]
        part = systems[box.system].findall("part")[box.part]
        events = events_of(part)
        if not events:
            continue
        used: set[int] = set()
        for w in sorted(ws, key=lambda w: w.left):
            harmony = parse_chord(w.text)
            anchor_x = w.left + min(w.right - w.left, 2 * unit) / 2
            # nächstgelegene Note/Pause, die noch keinen Akkord hat
            free = [e for e in events if id(e.note) not in used and abs(e.x - anchor_x) <= 6 * unit]
            if not free:
                continue
            ev = min(free, key=lambda e: abs(e.x - anchor_x))
            used.add(id(ev.note))
            ET.SubElement(harmony, "staff").text = str(box.staff)   # über dieser Zeile steht er
            children = list(ev.measure)
            ev.measure.insert(children.index(ev.note), harmony)
            state.chords += 1

    # ---- Liedtext: je Notenzeile in Zeilen (Strophen) gruppieren
    for idx, ws in lyric_words.items():
        box = boxes[idx]
        part = systems[box.system].findall("part")[box.part]
        all_events = [e for e in events_of(part) if e.staff == box.staff]
        if not all_events:
            continue
        top_voice = min(all_events, key=lambda e: (len(e.voice), e.voice)).voice
        events = [e for e in all_events if e.voice == top_voice and not e.is_rest and not e.tied_on]
        events.sort(key=lambda e: e.x)
        rows: list[list[Word]] = []
        for w in sorted(ws, key=lambda w: w.cy):
            if rows and abs(rows[-1][0].cy - w.cy) < 0.6 * max(w.height, rows[-1][0].height):
                rows[-1].append(w)
            else:
                rows.append([w])
        for number, row in enumerate(rows, start=1):
            syllables = syllables_of_row(row)
            key = (box.part, box.staff, number)
            if syllables and state.carry.get(key):
                syllables[0].hyphen_before = True
            for syl, ev in match_syllables(syllables, events):
                lyric = ET.Element("lyric", number=str(number))
                if syl.hyphen_before and syl.hyphen_after:
                    syllabic = "middle"
                elif syl.hyphen_after:
                    syllabic = "begin"
                elif syl.hyphen_before:
                    syllabic = "end"
                else:
                    syllabic = "single"
                ET.SubElement(lyric, "syllabic").text = syllabic
                ET.SubElement(lyric, "text").text = syl.text
                if syl.extend:
                    ET.SubElement(lyric, "extend")
                insert_ordered(ev.note, lyric)
                state.lyrics += 1
            if syllables:
                state.carry[key] = syllables[-1].hyphen_after


# ---------------------------------------------------------------- Gabeln

def _insert_after(measure: ET.Element, note: ET.Element, el: ET.Element) -> None:
    """Fügt el hinter einer Note (samt ihren Akkordtönen) ein."""
    children = list(measure)
    i = children.index(note) + 1
    while i < len(children) and children[i].tag == "note" and children[i].find("chord") is not None:
        i += 1
    measure.insert(i, el)


def annotate_wedges(systems: list[ET.Element], boxes: list[StaffBox], wedges: list[dict],
                    state: PageText) -> None:
    """Setzt erkannte Gabeln als <wedge> an die Noten, unter/über denen sie stehen."""
    if not boxes or not wedges:
        return
    boxes = sorted(boxes, key=lambda b: b.top)
    unit = sorted(b.unit for b in boxes)[len(boxes) // 2]
    for wd in wedges:
        cy = (wd["top"] + wd["bottom"]) / 2
        above = max((i for i, b in enumerate(boxes) if b.bottom <= cy), default=None,
                    key=lambda i: boxes[i].bottom)
        below = min((i for i, b in enumerate(boxes) if b.top >= cy), default=None,
                    key=lambda i: boxes[i].top)
        d_above = wd["top"] - boxes[above].bottom if above is not None else float("inf")
        d_below = boxes[below].top - wd["bottom"] if below is not None else float("inf")
        idx = above if d_above <= d_below else below
        if idx is None or min(d_above, d_below) > 6 * unit:
            continue
        box = boxes[idx]
        part = systems[box.system].findall("part")[box.part]
        events = sorted(events_of(part), key=lambda e: e.x)
        if not events:
            continue
        start = min(events, key=lambda e: abs(e.x - wd["left"]))
        before_end = [e for e in events if e.x <= wd["right"] + unit and e.x >= start.x]
        end = before_end[-1] if before_end else start
        if abs(start.x - wd["left"]) > 6 * unit:
            continue
        placement = "below" if idx == above else "above"
        number = str(box.staff)

        def direction(kind: str) -> ET.Element:
            d = ET.Element("direction", placement=placement)
            dt = ET.SubElement(d, "direction-type")
            ET.SubElement(dt, "wedge", type=kind, number=number)
            ET.SubElement(d, "staff").text = str(box.staff)
            return d

        children = list(start.measure)
        start.measure.insert(children.index(start.note), direction(wd["kind"]))
        _insert_after(end.measure, end.note, direction("stop"))
        state.wedges += 1


# ---------------------------------------------------------------- Einrichtung

def warmup() -> None:
    """Lädt die Texterkennungs-Modelle herunter (einmalig, bei der Einrichtung)."""
    import numpy as np
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (400, 120), "white")
    ImageDraw.Draw(img).text((20, 40), "Am D7 Wer kann", fill="black", font_size=36)
    _engine_instance()(np.array(img))


if __name__ == "__main__":
    import sys

    if "--init" in sys.argv:
        warmup()
        print("Texterkennung bereit.")
