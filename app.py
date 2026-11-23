"""Notenscanner - lokaler Server.

Nimmt PDF- oder Bilddateien mit Noten entgegen, erkennt sie mit der
OMR-Engine "homr" und liefert MusicXML an die Oberflaeche im Browser.
Bearbeiten, Transponieren und Abspielen passieren komplett im Browser.
"""

from __future__ import annotations

import io
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from flask import Flask, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
JOBS_DIR = BASE / "data" / "jobs"

VEROVIO_FILE = STATIC / "lib" / "verovio-toolkit-wasm.js"
VEROVIO_URL = "https://cdn.jsdelivr.net/npm/verovio@6.4.1/dist/verovio-toolkit-wasm.js"

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}
XML_EXT = {".xml", ".musicxml"}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


# ---------------------------------------------------------------- Hilfen

def read_mxl(data: bytes) -> str:
    """Entpackt eine komprimierte MusicXML-Datei (.mxl)."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        root_file = None
        try:
            container = ET.fromstring(zf.read("META-INF/container.xml"))
            for el in container.iter():
                if el.tag.endswith("rootfile"):
                    root_file = el.get("full-path")
                    break
        except KeyError:
            pass
        if not root_file:
            candidates = [
                n for n in zf.namelist()
                if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF")
            ]
            if not candidates:
                raise ValueError("Die MXL-Datei enthält keine Noten.")
            root_file = candidates[0]
        return zf.read(root_file).decode("utf-8", errors="replace")


def count_pages(path: Path) -> int:
    if path.suffix.lower() != ".pdf":
        return 1
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        try:
            return len(pdf)
        finally:
            pdf.close()
    except Exception:
        return 1


def pdf_previews(path: Path) -> list[str]:
    """Rendert die Seiten einer PDF als kleine JPEG-Bilder fuer die Original-Ansicht."""
    import base64

    import pypdfium2 as pdfium

    out: list[str] = []
    pdf = pdfium.PdfDocument(str(path))
    try:
        for page in pdf:
            buf = io.BytesIO()
            page.render(scale=110 / 72).to_pil().convert("RGB").save(buf, "JPEG", quality=78)
            out.append("data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii"))
    finally:
        pdf.close()
    return out


def run_job(job_id: str, paths: list[Path]) -> None:
    job = jobs[job_id]
    for p in paths:
        if p.suffix.lower() == ".pdf":
            try:
                job["previews"][p.name] = pdf_previews(p)
            except Exception:  # noqa: BLE001
                pass
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    out = paths[0].parent / "ergebnis.musicxml"
    cmd = [sys.executable, str(BASE / "omr.py"), str(out), *[str(p) for p in paths]]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(paths[0].parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        job["proc"] = proc
        tail: list[str] = []
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            tail.append(line)
            del tail[:-25]
            if line.startswith("Finished "):
                job["done"] += 1
            if "ownload" in line:
                job["message"] = "Erkennungsmodelle werden geladen (nur beim ersten Mal) …"
            elif job["done"] < job["pages"]:
                job["message"] = f"Seite {job['done'] + 1} von {job['pages']} wird erkannt …"
            else:
                job["message"] = "Erkennung wird abgeschlossen …"
        code = proc.wait()
        if job["status"] == "cancelled":
            return
        if code != 0 or not out.exists():
            job["status"] = "error"
            job["error"] = (
                "Die Notenerkennung ist fehlgeschlagen. "
                "Ist das Bild scharf und sind die Notenlinien gut zu sehen?\n\n"
                + "\n".join(tail[-6:])
            )
            return
        job["xml"] = out.read_text(encoding="utf-8", errors="replace")
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = f"Interner Fehler: {exc}"
    finally:
        job.pop("proc", None)
        shutil.rmtree(paths[0].parent, ignore_errors=True)


# ---------------------------------------------------------------- Routen

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/<path:name>")
def static_files(name: str):
    return send_from_directory(STATIC, name)


@app.after_request
def no_cache(resp):
    if not request.path.startswith("/lib/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/import")
def api_import():
    files = [f for f in request.files.getlist("files") if f.filename]
    if not files:
        return jsonify(error="Keine Datei erhalten."), 400

    first_ext = Path(files[0].filename).suffix.lower()
    if first_ext in XML_EXT:
        return jsonify(xml=files[0].read().decode("utf-8", errors="replace"))
    if first_ext == ".mxl":
        try:
            return jsonify(xml=read_mxl(files[0].read()))
        except Exception as exc:  # noqa: BLE001
            return jsonify(error=f"MXL-Datei konnte nicht gelesen werden: {exc}"), 400

    for f in files:
        ext = Path(f.filename).suffix.lower()
        if ext != ".pdf" and ext not in IMAGE_EXT:
            return jsonify(
                error=f"Dateityp {ext or '?'} wird nicht unterstützt. "
                "Erlaubt sind PDF, PNG, JPG, BMP, TIFF, WEBP, MusicXML und MXL."
            ), 400

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i, f in enumerate(files):
        p = job_dir / f"seite_{i:03d}{Path(f.filename).suffix.lower()}"
        f.save(p)
        paths.append(p)

    pages = sum(count_pages(p) for p in paths)
    with jobs_lock:
        jobs[job_id] = {
            "status": "running",
            "message": "Notenerkennung wird gestartet …",
            "pages": pages,
            "done": 0,
            "started": time.time(),
            "previews": {},
            "names": [p.name for p in paths],
        }
    threading.Thread(target=run_job, args=(job_id, paths), daemon=True).start()
    return jsonify(job=job_id, pages=pages)


@app.get("/api/job/<job_id>")
def api_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return jsonify(error="Unbekannter Auftrag."), 404
    body = {
        "status": job["status"],
        "message": job.get("message", ""),
        "pages": job["pages"],
        "done": job["done"],
        "elapsed": int(time.time() - job["started"]),
    }
    if job["status"] == "done":
        body["xml"] = job["xml"]
        body["previews"] = [job["previews"].get(n) for n in job["names"]]
        jobs.pop(job_id, None)
    elif job["status"] == "error":
        body["error"] = job.get("error", "Unbekannter Fehler.")
        jobs.pop(job_id, None)
    return jsonify(body)


@app.post("/api/job/<job_id>/cancel")
def api_cancel(job_id: str):
    job = jobs.get(job_id)
    if job and job["status"] == "running":
        job["status"] = "cancelled"
        proc = job.get("proc")
        if proc:
            proc.kill()
        jobs.pop(job_id, None)
    return jsonify(ok=True)


# ---------------------------------------------------------------- Start

def ensure_verovio() -> None:
    """Laedt die Notensatz-Bibliothek nach, falls sie fehlt (z. B. nach dem Kopieren des Ordners)."""
    if VEROVIO_FILE.exists() and VEROVIO_FILE.stat().st_size > 1_000_000:
        return
    import urllib.request

    print("  Notenanzeige (Verovio) fehlt - wird einmalig heruntergeladen ...")
    VEROVIO_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = VEROVIO_FILE.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(VEROVIO_URL, tmp)
        tmp.replace(VEROVIO_FILE)
        print("  Fertig.")
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        print(f"  Download fehlgeschlagen ({exc}). Ist das Internet verbunden?")


def free_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 30):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


if __name__ == "__main__":
    shutil.rmtree(JOBS_DIR, ignore_errors=True)
    ensure_verovio()
    port = free_port()
    url = f"http://127.0.0.1:{port}/"
    print(f"\n  Notenscanner laeuft: {url}\n  (Dieses Fenster offen lassen. Beenden mit Strg+C.)\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
