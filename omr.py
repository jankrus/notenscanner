"""Notenerkennung mit stückweiter Stimmenzuordnung.

homr erkennt die Noten. Aufgeteilt in Stimmen wird hier selbst, weil homr das
nur seitenweise macht und Seiten dann nach der Reihenfolge ihrer Notensysteme
zusammensetzt. Das geht schief, wenn sich die Anzahl der Notenzeilen ändert,
etwa Klavier allein -> Gesang + Klavier -> Chor (2 Zeilen) + Klavier.

Vorgehen:
  1. Jedes System jeder Seite einzeln erkennen und als kleine MusicXML erzeugen.
  2. Das System mit den meisten Notenzeilen legt die Stimmen des Stücks fest.
  3. Jede Notenzeile wird anhand von Schlüssel und Reihenfolge einer dieser
     Stimmen zugeordnet; fehlende Stimmen bekommen Pausen.

Aufruf: python omr.py AUSGABE.musicxml BILD_ODER_PDF [...]
"""

from __future__ import annotations

import copy
import itertools
import json
import os
import sys
import xml.etree.ElementTree as ET
from math import lcm

import onnxruntime as ort
from homr.main import ProcessingConfig, detect_staffs_in_image, download_weights
from homr.music_xml_generator import XmlGeneratorArguments, convert_ties, generate_xml
from homr.onnx_providers import cuda_available, rocm_available
from homr.pdf_utils import render_pdf_to_image
from homr.simple_logging import eprint
from homr.staff_parsing import _clean_up_voice, parse_staff_image
from homr.staff_regions import StaffRegions
from homr.system_repair import repair_systems
from homr.title_detection import download_ocr_weights
from homr.transformer.configs import Config
from homr.transformer.vocabulary import EncodedSymbol

import hairpins
import keycheck
import text_ocr

NOTE_ORDER = [
    "grace", "cue", "chord", "pitch", "unpitched", "rest", "duration", "tie", "instrument",
    "footnote", "level", "voice", "type", "dot", "accidental", "time-modification", "stem",
    "notehead", "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen",
]


# ---------------------------------------------------------------- Erkennung

def recognize_pages(images: list[str]) -> tuple[list[dict], str]:
    """Erkennt alle Seiten: je Seite die Systeme (MusicXML), Lage der Notenzeilen und Text."""
    gpu = cuda_available() or rocm_available()
    download_weights(gpu, gpu, False)
    download_ocr_weights()
    ort.set_default_logger_severity(3)

    config = ProcessingConfig(False, False, False, False, -1, gpu, gpu, False, True)
    tcfg = Config()
    tcfg.use_gpu_inference = gpu
    args = XmlGeneratorArguments()

    pages: list[dict] = []
    title = ""
    for page_no, image_path in enumerate(images):
        page = {"systems": [], "geoms": [], "words": [], "wedges": []}
        eprint("Processing " + image_path)
        try:
            multi, image, debug, title_future, _, to_input = detect_staffs_in_image(
                image_path, config
            )
            multi = repair_systems(debug, multi)
            regions = StaffRegions(multi)
            index = 0
            for row in multi:
                units = []
                geoms = []
                for staff in row.staffs:
                    symbols = parse_staff_image(debug, index, staff, image, regions, tcfg, to_input)
                    index += 1
                    if symbols:
                        units.append(_clean_up_voice([*symbols, EncodedSymbol("newline")]))
                        try:
                            geoms.append(text_ocr.staff_geometry(staff, to_input))
                        except Exception:  # noqa: BLE001
                            geoms.append([])
                if units:
                    page["systems"].append(generate_xml(args, units, ""))
                    page["geoms"].append(geoms)
            try:
                page["words"] = text_ocr.read_words(image_path)
            except Exception as exc:  # noqa: BLE001
                eprint(f"Texterkennung auf Seite {page_no + 1} fehlgeschlagen: {exc}")
            try:
                staffs = [g for geoms in page["geoms"] for unit in geoms for g in unit]
                page["wedges"] = hairpins.detect(image_path, staffs, page["words"])
            except Exception as exc:  # noqa: BLE001
                eprint(f"Gabel-Erkennung auf Seite {page_no + 1} fehlgeschlagen: {exc}")
            if page_no == 0:
                try:
                    title = title_future.result(60) or ""
                except Exception:  # noqa: BLE001
                    title = ""
            try:
                debug.clean_debug_files_from_previous_runs()
            except Exception:  # noqa: BLE001
                pass
        except Exception as exc:  # noqa: BLE001
            eprint(f"Seite {page_no + 1} konnte nicht erkannt werden: {exc}")
        pages.append(page)
        eprint("Finished " + image_path)
    if not any(p["systems"] for p in pages):
        raise RuntimeError("Auf keiner Seite wurden Noten gefunden.")
    return pages, title


def add_text(pages: list[dict]) -> list[ET.Element]:
    """Setzt Liedtext und Akkorde in die Systeme ein; liefert alle Systeme der Reihe nach."""
    systems: list[ET.Element] = []
    state = text_ocr.PageText()
    for page in pages:
        boxes = []
        for si, (root, geoms) in enumerate(zip(page["systems"], page["geoms"])):
            for pi, staffs in enumerate(geoms):
                for st, g in enumerate(staffs, start=1):
                    boxes.append(text_ocr.StaffBox(si, pi, st, g["top"], g["bottom"], g["left"], g["right"]))
        try:
            text_ocr.annotate_page(page["systems"], boxes, page["words"], state)
        except Exception as exc:  # noqa: BLE001
            eprint(f"Liedtext/Akkorde konnten nicht zugeordnet werden: {exc}")
        try:
            text_ocr.annotate_wedges(page["systems"], boxes, page.get("wedges", []), state)
        except Exception as exc:  # noqa: BLE001
            eprint(f"Gabeln konnten nicht zugeordnet werden: {exc}")
        systems.extend(page["systems"])
    eprint(f"Liedtext: {state.lyrics} Silben, Akkorde: {state.chords}, "
           f"Dynamik: {state.dynamics}, Anweisungen: {state.expressions}, Gabeln: {state.wedges}")
    return systems


# ---------------------------------------------------------------- Einlesen der Systeme

def ival(el: ET.Element | None, default: int = 0) -> int:
    try:
        return int(round(float(el.text))) if el is not None and el.text else default
    except ValueError:
        return default


class Unit:
    """Ein Part eines einzelnen Systems: eine Notenzeile oder ein Doppelsystem."""

    def __init__(self, part: ET.Element):
        self.measures = part.findall("measure")
        self.div = ival(part.find("measure/attributes/divisions"), 1) or 1
        self.nst = max(1, ival(part.find("measure/attributes/staves"), 1))
        signs: dict[int, str] = {}
        for clef in part.iter("clef"):
            signs.setdefault(int(clef.get("number", "1")), clef.findtext("sign", "G"))
        self.clefs = [signs.get(n, "G" if n == 1 else "F") for n in range(1, self.nst + 1)]


class System:
    def __init__(self, root: ET.Element):
        self.units = [Unit(p) for p in root.findall("part") if p.find("measure") is not None]
        self.count = max((len(u.measures) for u in self.units), default=0)

    @property
    def staves(self) -> list[tuple[int, int, str]]:
        return [(ui, s, u.clefs[s - 1]) for ui, u in enumerate(self.units) for s in range(1, u.nst + 1)]


def start_attrs(measure: ET.Element) -> list[ET.Element]:
    """Die <attributes> vor der ersten Note eines Takts."""
    out = []
    for el in measure:
        if el.tag == "note":
            break
        if el.tag == "attributes":
            out.append(el)
    return out


def find_start(measure: ET.Element | None, tag: str, number: int | None = None) -> ET.Element | None:
    if measure is None:
        return None
    for attrs in start_attrs(measure):
        for el in attrs.findall(tag):
            if number is None or int(el.get("number", "1")) == number:
                return el
    return None


# ---------------------------------------------------------------- Zuordnung

def assign(system: System, slots: list[tuple[int, int, str]], nparts: int) -> dict:
    """Ordnet jede Notenzeile des Systems einem Platz (Part, Zeile) des Stücks zu."""
    staves = system.staves
    best: tuple[int, tuple[int, ...]] | None = None
    for combo in itertools.combinations(range(len(slots)), len(staves)):
        score = 0
        for (_, _, clef), k in zip(staves, combo):
            if slots[k][2] == clef:
                score += 2
        for ui, unit in enumerate(system.units):
            ks = [k for (u, _, _), k in zip(staves, combo) if u == ui]
            parts = {slots[k][0] for k in ks}
            if len(parts) == 1:
                score += 1
            else:
                score -= 3
        if staves and slots[combo[-1]][0] == nparts - 1 and staves[-1][0] == len(system.units) - 1:
            score += 1
        if best is None or score > best[0]:
            best = (score, combo)
    assert best is not None
    return {(u, s): slots[k][:2] for (u, s, _), k in zip(staves, best[1])}


# ---------------------------------------------------------------- Zusammenbau

def el_dur(el: ET.Element) -> int:
    return ival(el.find("duration"))


def set_child(note: ET.Element, tag: str, text: str) -> None:
    child = note.find(tag)
    if child is None:
        child = ET.Element(tag)
        idx = NOTE_ORDER.index(tag)
        pos = len(note)
        for i, c in enumerate(note):
            if c.tag in NOTE_ORDER and NOTE_ORDER.index(c.tag) > idx:
                pos = i
                break
        note.insert(pos, child)
    child.text = text


def measure_length(unit: Unit, k: int, scale: int) -> int:
    if k >= len(unit.measures):
        return 0
    pos = top = 0
    for el in unit.measures[k]:
        if el.tag == "backup":
            pos -= el_dur(el)
        elif el.tag == "forward":
            pos += el_dur(el)
        elif el.tag == "note" and el.find("chord") is None and el.find("grace") is None:
            pos += el_dur(el)
        top = max(top, pos)
    return top * scale


def staff_items(measure: ET.Element, staff_no: int, scale: int) -> list[list]:
    """Alle Ereignisse einer Notenzeile: [stimme, einsatz, dauer, [elemente]]."""
    pos = 0
    head_onset = head_dur = 0
    head_item: list | None = None
    items: list[list] = []
    seen_note = False
    for el in measure:
        tag = el.tag
        if tag == "backup":
            pos -= el_dur(el) * scale
        elif tag == "forward":
            pos += el_dur(el) * scale
        elif tag == "note":
            seen_note = True
            staff = ival(el.find("staff"), 1)
            dur = 0 if el.find("grace") is not None else el_dur(el) * scale
            if el.find("chord") is not None:
                if staff != staff_no:
                    continue
                if head_item is not None:
                    head_item[3].append(el)
                else:
                    head_item = [el.findtext("voice", "1"), head_onset, head_dur, [el]]
                    items.append(head_item)
                continue
            head_onset, head_dur = pos, dur
            if staff == staff_no:
                head_item = [el.findtext("voice", "1"), pos, dur, [el]]
                items.append(head_item)
            else:
                head_item = None
            pos += dur
        elif tag in ("direction", "harmony"):
            if ival(el.find("staff"), 1) == staff_no:
                items.append([None, pos, 0, [el]])
        elif tag == "attributes" and seen_note:
            clefs = [c for c in el.findall("clef") if int(c.get("number", "1")) == staff_no]
            if clefs:
                attrs = ET.Element("attributes")
                attrs.extend(clefs)
                items.append([None, pos, 0, [attrs]])
    return items


def sequence(stream: list[list], expected: int = 0) -> list[list]:
    """Ordnet die Ereignisse einer Stimme zeitlich.

    homr liefert in manchen Takten widersprüchliche Positionen (zwei Ereignisse einer
    Stimme gleichzeitig) oder Lücken, durch die eine Stimme über den Takt hinausläuft.
    Dann ist die Lesereihenfolge verlässlicher: die Ereignisse werden lückenlos
    hintereinander gesetzt.
    """
    if expected:
        # Pausen, die erst nach Taktende beginnen, sind Lesefehler
        stream = [it for it in stream if not (it[0] >= expected and all(
            e.tag == "note" and e.find("rest") is not None for e in it[2]))] or stream
    ordered = sorted(stream, key=lambda it: it[0])
    end = None
    gaps = False
    for onset, dur, _ in ordered:
        if dur <= 0:
            continue
        if end is not None and onset < end:
            break
        if end is not None and onset > end:
            gaps = True
        end = onset + dur
    else:
        if not (gaps and expected and end is not None and end > expected):
            return ordered
    timed = [it for it in stream if it[1] > 0]
    cur = min(it[0] for it in timed)
    out = []
    for onset, dur, els in stream:
        if dur > 0:
            out.append([cur, dur, els])
            cur += dur
        else:
            out.append([min(onset, cur), 0, els])
    return out


def timing(tag: str, dur: int) -> ET.Element:
    el = ET.Element(tag)
    ET.SubElement(el, "duration").text = str(dur)
    return el


def build_score(systems: list[System], title: str) -> ET.Element:
    layout = max(systems, key=lambda s: len(s.staves))
    parts = [(u.nst, list(u.clefs)) for u in layout.units]
    slots = [(p, s, clefs[s - 1]) for p, (nst, clefs) in enumerate(parts) for s in range(1, nst + 1)]
    divisions = 1
    for system in systems:
        for unit in system.units:
            divisions = lcm(divisions, unit.div)

    out_parts = [ET.Element("part", id=f"P{p + 1}") for p in range(len(parts))]
    state = [{"key": None, "time": None, "clef": {}} for _ in parts]
    number = 0
    signature = (0, 0)  # zuletzt gültige Taktart (Schläge, Notenwert)

    for system in systems:
        mapping = assign(system, slots, len(parts))
        by_part: dict[int, dict[int, tuple[int, int]]] = {}
        for (u, s), (p, t) in mapping.items():
            by_part.setdefault(p, {})[t] = (u, s)

        for k in range(system.count):
            number += 1
            # Taktlänge, Tonart, Taktart und Taktstriche gelten für das ganze System
            length = 0
            key = time = None
            barlines: dict[str, ET.Element] = {}
            for unit in system.units:
                scale = divisions // unit.div
                length = max(length, measure_length(unit, k, scale))
                m = unit.measures[k] if k < len(unit.measures) else None
                key = key if key is not None else find_start(m, "key")
                time = time if time is not None else find_start(m, "time")
                if m is not None:
                    for bl in m.findall("barline"):
                        barlines.setdefault(bl.get("location", "right"), bl)
            if time is not None:
                beats, beat_type = ival(time.find("beats")), ival(time.find("beat-type"))
                if beats and beat_type:
                    signature = (beats, beat_type)
            expected = signature[0] * divisions * 4 // signature[1] if signature[1] else 0
            if expected and length > expected:
                length = expected  # Platzhalter-Pausen nicht von Lesefehlern verlängern lassen
            if not length:
                length = divisions * 4

            for p, (nst, slot_clefs) in enumerate(parts):
                st = state[p]
                measure = ET.SubElement(out_parts[p], "measure", number=str(number))
                attrs = ET.Element("attributes")
                if number == 1:
                    ET.SubElement(attrs, "divisions").text = str(divisions)
                key_s = ET.tostring(key) if key is not None else None
                if key is not None and key_s != st["key"]:
                    attrs.append(key)
                    key = ET.fromstring(key_s)
                    st["key"] = key_s
                time_s = ET.tostring(time) if time is not None else None
                if time is not None and time_s != st["time"]:
                    attrs.append(time)
                    time = ET.fromstring(time_s)
                    st["time"] = time_s
                if number == 1 and nst > 1:
                    ET.SubElement(attrs, "staves").text = str(nst)
                sources = by_part.get(p, {})
                for t in range(1, nst + 1):
                    src = sources.get(t)
                    clef = None
                    if src is not None:
                        u, s = src
                        unit = system.units[u]
                        m = unit.measures[k] if k < len(unit.measures) else None
                        clef = find_start(m, "clef", s)
                        if clef is None and k == 0:
                            clef = ET.Element("clef")
                            ET.SubElement(clef, "sign").text = unit.clefs[s - 1]
                            ET.SubElement(clef, "line").text = "2" if unit.clefs[s - 1] == "G" else "4"
                    elif t not in st["clef"]:
                        clef = ET.Element("clef")
                        ET.SubElement(clef, "sign").text = slot_clefs[t - 1]
                        ET.SubElement(clef, "line").text = "2" if slot_clefs[t - 1] == "G" else "4"
                    if clef is None:
                        continue
                    sign_line = (clef.findtext("sign", "G"), clef.findtext("line", ""))
                    if st["clef"].get(t) != sign_line:
                        new = ET.SubElement(attrs, "clef", number=str(t))
                        ET.SubElement(new, "sign").text = sign_line[0]
                        if sign_line[1]:
                            ET.SubElement(new, "line").text = sign_line[1]
                        st["clef"][t] = sign_line
                if len(attrs):
                    measure.append(attrs)
                if "left" in barlines:
                    measure.append(ET.fromstring(ET.tostring(barlines["left"])))

                streams = []
                for t in range(1, nst + 1):
                    src = sources.get(t)
                    items = []
                    if src is not None:
                        u, s = src
                        unit = system.units[u]
                        if k < len(unit.measures):
                            items = staff_items(unit.measures[k], s, divisions // unit.div)
                    voices = sorted({it[0] for it in items if it[0] is not None},
                                    key=lambda v: (len(v), v))
                    if not voices:
                        rest = ET.Element("note")
                        ET.SubElement(rest, "rest", measure="yes")
                        ET.SubElement(rest, "duration").text = str(length)
                        ET.SubElement(rest, "voice").text = str((t - 1) * 4 + 1)
                        ET.SubElement(rest, "staff").text = str(t)
                        streams.append([[0, length, [rest]]] + [[it[1], 0, [copy.deepcopy(e) for e in it[3]]] for it in items])
                        continue
                    for vi, v in enumerate(voices):
                        new_voice = str((t - 1) * 4 + min(vi, 3) + 1)
                        stream = []
                        for it in items:
                            if it[0] is None and vi != 0:
                                continue
                            if it[0] is not None and it[0] != v:
                                continue
                            els = [copy.deepcopy(el) for el in it[3]]
                            lead = els[0].find("chord") if els[0].tag == "note" else None
                            if lead is not None:
                                els[0].remove(lead)  # erster Ton eines Ereignisses ist kein Akkord-Nachzügler
                            for el in els:
                                if el.tag == "note":
                                    dur = el.find("duration")
                                    if dur is not None:
                                        dur.text = str(ival(dur) * (divisions // system.units[src[0]].div))
                                    set_child(el, "voice", new_voice)
                                    set_child(el, "staff", str(t))
                                elif el.tag in ("direction", "harmony"):
                                    staff = el.find("staff")
                                    if staff is not None:
                                        staff.text = str(t)
                                elif el.tag == "attributes":
                                    for c in el.findall("clef"):
                                        c.set("number", str(t))
                            stream.append([it[1], it[2], els])
                        streams.append(sequence(stream, expected))

                for si, stream in enumerate(streams):
                    cur = 0
                    for onset, dur, els in stream:
                        if onset > cur:
                            measure.append(timing("forward", onset - cur))
                        elif onset < cur:
                            measure.append(timing("backup", cur - onset))
                        measure.extend(els)
                        cur = onset + dur
                    if si < len(streams) - 1 and cur > 0:
                        measure.append(timing("backup", cur))
                if "right" in barlines:
                    measure.append(ET.fromstring(ET.tostring(barlines["right"])))

    for part in out_parts:
        convert_ties(part)

    root = ET.Element("score-partwise", version="4.0")
    work = ET.SubElement(root, "work")
    ET.SubElement(work, "work-title").text = title or ""
    ident = ET.SubElement(root, "identification")
    enc = ET.SubElement(ident, "encoding")
    ET.SubElement(enc, "software").text = "Notenscanner (homr)"
    part_list = ET.SubElement(root, "part-list")
    for p, (nst, _) in enumerate(parts):
        if nst > 1 and p == len(parts) - 1:
            name = "Klavier"
        elif nst > 1:
            name = "Chor"
        else:
            name = "Gesang" if len(parts) > 1 else "Stimme"
        sp = ET.SubElement(part_list, "score-part", id=f"P{p + 1}")
        ET.SubElement(sp, "part-name").text = name
    for part in out_parts:
        root.append(part)
    return root


# ---------------------------------------------------------------- Start

def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    out_path = sys.argv[1]
    dump = os.environ.get("NOTENSCANNER_DUMP")
    if sys.argv[2] == "--from-dump":
        # Entwicklerhilfe: nur neu zusammenbauen, ohne erneute Erkennung
        with open(os.path.join(sys.argv[3], "pages.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        parser = lambda: ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))  # noqa: E731
        pages = [{
            "systems": [ET.fromstring(x, parser=parser()) for x in p["systems"]],
            "geoms": p["geoms"],
            "words": [text_ocr.word_from_json(w) for w in p["words"]],
            "wedges": p.get("wedges", []),
        } for p in data["pages"]]
        title = data["title"]
    else:
        images: list[str] = []
        for path in sys.argv[2:]:
            if path.lower().endswith(".pdf"):
                images += render_pdf_to_image(path)
            else:
                images.append(path)
        pages, title = recognize_pages(images)
        if dump:
            os.makedirs(dump, exist_ok=True)
            with open(os.path.join(dump, "pages.json"), "w", encoding="utf-8") as fh:
                json.dump({"title": title, "pages": [{
                    "systems": [ET.tostring(r, encoding="unicode") for r in p["systems"]],
                    "geoms": p["geoms"],
                    "words": [text_ocr.word_to_json(w) for w in p["words"]],
                    "wedges": p.get("wedges", []),
                } for p in pages]}, fh)
    root_systems = add_text(pages)
    systems = [s for s in (System(r) for r in root_systems) if s.units and s.count]
    score = build_score(systems, title)
    try:
        keycheck.correct_keys(score, log=eprint)
    except Exception as exc:  # noqa: BLE001
        eprint(f"Tonart-Prüfung fehlgeschlagen: {exc}")
    ET.ElementTree(score).write(out_path, encoding="UTF-8", xml_declaration=True)
    eprint("Saved the generated musicxml at " + out_path)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        eprint(f"Fehler: {exc}")
        sys.exit(1)
