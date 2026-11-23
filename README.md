# Notenscanner

Noten als PDF oder Foto einlesen, korrigieren, transponieren und abspielen –
komplett auf dem eigenen Laptop.

## Herunterladen

Auf GitHub oben auf **Code → Download ZIP** klicken und das ZIP entpacken
(oder `git clone` verwenden). Voraussetzung: Windows und
[Python 3.11 oder neuer](https://www.python.org/downloads/)
(beim Installieren „Add python.exe to PATH“ ankreuzen).

## Starten

Doppelklick auf **`Notenscanner starten.bat`**.

- Beim allerersten Start richtet sich die App selbst ein (Python-Pakete und
  Erkennungsmodelle, rund 500 MB, einige Minuten, Internet nötig). Danach läuft
  alles offline.
- Die App öffnet sich im Browser unter `http://127.0.0.1:8765/`.
- Das schwarze Fenster offen lassen, solange die App benutzt wird.
  Schließen beendet die App.

Voraussetzung: Python 3.11 oder neuer (<https://www.python.org/downloads/>).

## Benutzen

1. **Öffnen …** – PDF, Foto/Scan (PNG, JPG, …) oder eine vorhandene
   MusicXML/MXL-Datei wählen. Mehrere Fotos auf einmal = mehrere Seiten.
2. Die erkannten Noten erscheinen rechts, das Original links zum Vergleichen.
   Rot hinterlegte Takte haben zu viele oder zu wenige Schläge – dort lohnt
   sich ein Blick zuerst.
3. Note anklicken und mit Tasten oder Knöpfen korrigieren (`?` zeigt alle
   Tastenkürzel).
4. **Transponieren**: Intervall wählen, dann *höher* oder *tiefer*.
5. **Abspielen** (Leertaste) startet ab der markierten Note.
6. **Speichern**: MusicXML (für MuseScore, Sibelius, Dorico …), MIDI oder
   Drucken/PDF.

7. **Akkorde und Liedtext korrigieren**: Note markieren, im Feld „Akkord“
   eintippen (z. B. *Am*, *Fis7*, *Hm*, *B*, *D/Fis*) und Enter drücken. Im
   Feld „Silbe“ den Text eintippen; Enter oder Leertaste springt zur nächsten
   Note. `schrei-` trennt zur nächsten Silbe, `Licht_` zeichnet eine
   Haltelinie, die Auswahl daneben wählt die Strophe.
8. **Stimmen einzeln hören**: „Stimmen ▾“ neben „Abspielen“ – Sopran, Alt,
   Tenor, Bass, Klavier rechts/links usw. stumm schalten, solo hören oder in
   der Lautstärke ändern; wirkt sofort, auch während des Abspielens. Wo eine
   Zeile einstimmig notiert ist (alle singen dieselbe Melodie), klingt sie für
   beide Stimmen dieser Zeile.

Der letzte Stand bleibt im Browser gespeichert und ist nach einem Neustart
wieder da.

## Tipps für gute Erkennung

- Am besten funktionieren saubere PDFs und gerade, scharfe Scans.
- Fotos: gleichmäßiges Licht, ganze Seite, möglichst senkrecht von oben.
- Erkannt werden Noten, Pausen, Schlüssel, Ton- und Taktart, Akkorde,
  Halte- und Bindebögen, außerdem **Liedtext** (mit Silbentrennung, mehrere
  Strophen untereinander) und **Akkordsymbole** (z. B. „Am“, „D7“, „C/G“).
  Akkordsymbole werden beim Transponieren mit umgerechnet.
- **Dynamik** (pp … ff, sfz, fp) und **Vortragszeichen** (Staccato, Akzent,
  Tenuto, Fermate) werden erkannt, ebenso Textanweisungen wie „cresc.“,
  „rit.“, „a tempo“, „dolce“ oder „langsamer“ und **Crescendo- und
  Decrescendo-Gabeln** (werden direkt im Bild gesucht, `hairpins.py`).
- Beim Abspielen wirken Dynamik (Lautstärke), Gabeln und „cresc.“/„dim.“
  (gleichmäßiges An-/Abschwellen bis zur nächsten Dynamik), Akzente, Staccato
  (kürzer) und Fermaten (länger gehalten). Fehlendes lässt sich in der Leiste
  „Ausdruck“ ergänzen; für eine Gabel die erste Note markieren, „Cresc. <“
  oder „Decresc. >“ drücken und die letzte Note anklicken.
- Akkorde werden standardmäßig deutsch geschrieben (H, B, Fis, Es). Oben in
  der Leiste lässt sich auf „Deutsch mit ♯/♭“ oder „International“ umstellen;
  gespeichert wird immer im MusicXML-Standard.
- Grenzen der Texterkennung: sehr kleine hochgestellte Zeichen (z. B. das ♯ in
  „F♯“ oder „G♯5“) gehen manchmal verloren; dann fehlt der Akkord oder das
  Vorzeichen. Fehlende Trennstriche im Liedtext werden nicht ergänzt.
- Wechselt die Zahl der Notenzeilen im Stück (z. B. Vorspiel nur Klavier, dann
  Gesang + Klavier, später Chor auf zwei Zeilen + Klavier), legt die App die
  Stimmen nach dem System mit den meisten Zeilen fest und ordnet jede Zeile
  über Schlüssel und Reihenfolge zu. Pausierende Stimmen bekommen Pausen und
  werden in der Anzeige ausgeblendet.
- Über einen Seiten- oder Zeilenumbruch geteilte Takte werden wieder zu einem
  Takt zusammengefügt.

## Technik

- Erkennung: [homr](https://github.com/liebharc/homr) (AGPL-3.0); die
  Zuordnung der Notenzeilen zu Stimmen über das ganze Stück macht `omr.py`.
- Liedtext und Akkorde: [RapidOCR](https://github.com/RapidAI/RapidOCR)
  (Apache-2.0), Zuordnung zu den Noten in `text_ocr.py`.
- Notensatz: [Verovio](https://www.verovio.org) (LGPL-3.0)
- Die Python-Umgebung liegt unter `%LOCALAPPDATA%\Notenscanner`. Zum
  vollständigen Entfernen diesen Ordner und den Programmordner löschen.

## Lizenz

Dieses Projekt steht unter der [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0), da es die ebenfalls AGPL-lizenzierte Notenerkennung homr nutzt.

Mitgeliefert wird `static/lib/verovio-toolkit-wasm.js` von
[Verovio](https://github.com/rism-digital/verovio) unter der LGPL-3.0.

Hinweis zu den Erkennungsmodellen von homr: Sie wurden teilweise mit Datensätzen
trainiert, die nur nicht-kommerziell genutzt werden dürfen (siehe
[homr License FAQ](https://github.com/liebharc/homr/blob/main/LICENSE_FAQ.md)).
Für eine kommerzielle Nutzung bitte vorher selbst prüfen.
