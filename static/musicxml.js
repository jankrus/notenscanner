/* MusicXML-Modell: Einlesen, Bearbeiten, Transponieren.
   Arbeitet direkt auf dem XML-Dokument (score-partwise). */
'use strict';

const MX = (() => {
  const XMLNS = 'http://www.w3.org/XML/1998/namespace';
  const STEPS = 'CDEFGAB';
  const NAT = [0, 2, 4, 5, 7, 9, 11];
  const TYPES = { whole: 1, half: 2, quarter: 4, eighth: 8, '16th': 16, '32nd': 32, '64th': 64 };
  const TYPE_NAMES = {
    whole: 'Ganze', half: 'Halbe', quarter: 'Viertel', eighth: 'Achtel',
    '16th': 'Sechzehntel', '32nd': 'Zweiunddreißigstel', '64th': 'Vierundsechzigstel', breve: 'Brevis',
  };
  const NOTE_ORDER = ['grace', 'cue', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie',
    'instrument', 'footnote', 'level', 'voice', 'type', 'dot', 'accidental', 'time-modification',
    'stem', 'notehead', 'notehead-text', 'staff', 'beam', 'notations', 'lyric', 'play', 'listen'];
  const ATTR_ORDER = ['footnote', 'level', 'divisions', 'key', 'time', 'staves', 'part-symbol',
    'instruments', 'clef', 'staff-details', 'transpose', 'directive', 'measure-style'];
  const ACC_NAMES = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };
  const ID_RE = /^nsn(\d+)$/;
  const BASE_DIV = 96;

  let idCounter = 0;

  // ------------------------------------------------------------ DOM-Hilfen
  const mod = (a, n) => ((a % n) + n) % n;
  const kid = (el, name) => { for (const c of el.children) if (c.tagName === name) return c; return null; };
  const kids = (el, name) => Array.from(el.children).filter(c => c.tagName === name);
  const kidText = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : null; };
  const mk = (doc, name, text) => { const e = doc.createElement(name); if (text != null) e.textContent = String(text); return e; };
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = (a, b) => a / gcd(a, b) * b;

  function insertOrdered(parent, el, order) {
    const idx = order.indexOf(el.tagName);
    for (const c of parent.children) {
      const ci = order.indexOf(c.tagName);
      if (ci > idx) { parent.insertBefore(el, c); return el; }
    }
    parent.appendChild(el);
    return el;
  }
  function setKidText(note, name, text) {
    let k = kid(note, name);
    if (!k) k = insertOrdered(note, mk(note.ownerDocument, name), NOTE_ORDER);
    k.textContent = String(text);
    return k;
  }
  const removeKids = (el, ...names) => { for (const n of names) kids(el, n).forEach(k => k.remove()); };

  // ------------------------------------------------------------ Einlesen
  function parse(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Die Datei ist kein gültiges MusicXML.');
    const root = doc.documentElement;
    if (root.tagName === 'score-timewise') throw new Error('MusicXML im Format „score-timewise“ wird nicht unterstützt.');
    if (root.tagName !== 'score-partwise') throw new Error('Die Datei enthält keine MusicXML-Partitur.');
    if (!doc.querySelector('part > measure')) throw new Error('In der Datei wurden keine Takte gefunden.');
    normalizeDivisions(doc);
    for (const m of doc.querySelectorAll('part > measure')) linearizeMeasure(doc, m);
    if (/homr|Notenscanner/i.test(doc.querySelector('identification software')?.textContent || '')) {
      mergeSplitMeasures(doc);
    }
    assignIds(doc);
    // Die Notenerkennung liefert weder Versetzungszeichen noch Balken - beides hier ergänzen.
    if (!doc.querySelector('note > accidental')) recomputeAccidentals(doc);
    if (!doc.querySelector('note > beam')) for (const m of doc.querySelectorAll('part > measure')) rebeam(doc, m);
    return doc;
  }

  function assignIds(doc) {
    const notes = doc.querySelectorAll('note');
    for (const n of notes) {
      const m = ID_RE.exec(n.getAttribute('id') || '');
      if (m) idCounter = Math.max(idCounter, +m[1]);
    }
    for (const n of notes) if (!ID_RE.test(n.getAttribute('id') || '')) setId(n);
  }
  function setId(note) {
    const id = 'nsn' + (++idCounter);
    note.setAttribute('id', id);
    note.setAttributeNS(XMLNS, 'xml:id', id);
    return id;
  }

  function serialize(doc, strip) {
    let d = doc;
    if (strip) {
      d = doc.cloneNode(true);
      for (const n of d.querySelectorAll('note')) {
        n.removeAttribute('id');
        n.removeAttributeNS(XMLNS, 'id');
      }
      // interne Bildpositionen der Erkennung nicht mit exportieren
      const walker = d.createTreeWalker(d, NodeFilter.SHOW_COMMENT);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach(c => c.remove());
    }
    let s = new XMLSerializer().serializeToString(d);
    if (!s.startsWith('<?xml')) s = '<?xml version="1.0" encoding="UTF-8"?>\n' + s;
    return s;
  }

  /** Bringt alle Dauern auf eine einheitliche, fein genug teilbare Auflösung. */
  function normalizeDivisions(doc) {
    let target = BASE_DIV;
    for (const d of doc.querySelectorAll('attributes > divisions')) {
      const v = parseInt(d.textContent, 10);
      if (v > 0) target = lcm(target, v);
    }
    for (const part of doc.querySelectorAll('part')) {
      let cur = 1;
      for (const measure of kids(part, 'measure')) {
        for (const el of measure.children) {
          if (el.tagName === 'attributes') {
            const d = kid(el, 'divisions');
            if (d) { cur = parseInt(d.textContent, 10) || 1; d.textContent = String(target); }
            continue;
          }
          if (cur === target) continue;
          const f = target / cur;
          for (const x of el.querySelectorAll('duration, offset')) {
            const v = parseFloat(x.textContent);
            if (!isNaN(v)) x.textContent = String(Math.round(v * f));
          }
        }
      }
      const first = kid(part, 'measure');
      if (first && !first.querySelector('attributes > divisions')) {
        let attrs = kid(first, 'attributes');
        if (!attrs) { attrs = mk(doc, 'attributes'); first.insertBefore(attrs, first.firstChild); }
        insertOrdered(attrs, mk(doc, 'divisions', target), ATTR_ORDER);
      }
    }
    doc._div = target;
  }
  /** Ordnet einen Takt stimmenweise: erst Stimme 1 komplett, dann <backup>, dann Stimme 2 usw.
      (Die Notenerkennung liefert die Stimmen zeitlich verschachtelt.) */
  function linearizeMeasure(doc, measure) {
    const els = Array.from(measure.children);
    if (!els.some(e => e.tagName === 'backup' || e.tagName === 'forward')) return;
    let pos = 0, lastStart = 0, order = 0, seenNote = false, lastItem = null, pending = [];
    const lead = [], voices = new Map();
    for (const el of els) {
      const tag = el.tagName;
      if (tag === 'backup') { pos = Math.max(0, pos - (parseInt(kidText(el, 'duration'), 10) || 0)); continue; }
      if (tag === 'forward') { pos += parseInt(kidText(el, 'duration'), 10) || 0; continue; }
      if (tag !== 'note') { (seenNote ? pending : lead).push(el); continue; }
      seenNote = true;
      if (kid(el, 'chord') && lastItem) { lastItem.els.push(...pending, el); pending = []; continue; }
      const vk = kidText(el, 'voice') || '1';
      if (!voices.has(vk)) voices.set(vk, { key: vk, staff: parseInt(kidText(el, 'staff') || '1', 10), items: [] });
      const dur = kid(el, 'grace') ? 0 : parseInt(kidText(el, 'duration') || '0', 10) || 0;
      lastItem = { onset: pos, idx: order++, els: [...pending, el], dur };
      pending = [];
      voices.get(vk).items.push(lastItem);
      lastStart = pos;
      pos += dur;
    }
    const list = Array.from(voices.values()).sort((a, b) =>
      a.staff - b.staff || (parseInt(a.key, 10) || 0) - (parseInt(b.key, 10) || 0) || a.key.localeCompare(b.key));
    const timing = (name, d) => { const e = mk(doc, name); e.appendChild(mk(doc, 'duration', d)); return e; };
    const out = [...lead];
    list.forEach((v, vi) => {
      let cur = 0;
      v.items.sort((a, b) => a.onset - b.onset || a.idx - b.idx);
      for (const it of v.items) {
        if (it.onset > cur) out.push(timing('forward', it.onset - cur));
        else if (it.onset < cur) out.push(timing('backup', cur - it.onset));
        out.push(...it.els);
        cur = it.onset + it.dur;
      }
      if (vi < list.length - 1 && cur > 0) out.push(timing('backup', cur));
    });
    out.push(...pending);
    measure.replaceChildren(...out);
  }

  const div = doc => doc._div || parseInt(doc.querySelector('attributes > divisions').textContent, 10);

  // ------------------------------------------------------------ Kontext
  /** Liefert je Takt die zu Taktbeginn geltende Tonart und Taktart. */
  /** Fügt Takte zusammen, die durch einen Zeilen- oder Seitenumbruch geteilt wurden
      (z. B. 2 Schläge am Seitenende + 1 Schlag auf der nächsten Seite im 3/4-Takt). */
  function mergeSplitMeasures(doc) {
    const parts = Array.from(doc.querySelectorAll('part'));
    const lists = parts.map(p => kids(p, 'measure'));
    const n = Math.min(...lists.map(l => l.length));
    if (n < 3) return;
    const ctx = context(doc);
    const expected = m => { const i = ctx.get(m); return i ? i.beats * div(doc) * 4 / i.beatType : 0; };
    // An Wiederholungszeichen bleibt die Teilung bewusst bestehen.
    const repeatAt = (m, loc) => kids(m, 'barline').some(b =>
      (b.getAttribute('location') || 'right') === loc && (kid(b, 'repeat') || kid(b, 'ending')));
    let merged = 0;
    for (let i = n - 2; i >= 1; i--) {
      // Geteilt ist ein Takt, wenn der Anschluss in allen Stimmen kurz ist und sich in
      // mindestens einer Stimme genau zu einem vollen Takt ergänzt. (Eine falsch erkannte
      // Extranote in einer anderen Stimme soll das nicht verhindern - sie bleibt markiert.)
      let split = 0, ok = true;
      const e = expected(lists[0][i]);
      for (const l of lists) {
        const a = l[i], b = l[i + 1];
        if (!e || expected(a) !== e || repeatAt(a, 'right') || repeatAt(b, 'left')) { ok = false; break; }
        const sa = staffLengths(a), sb = staffLengths(b);
        for (const [staff, A] of sa) {
          const B = sb.get(staff);
          if (A.restOnly || !B || B.restOnly) continue;
          if (B.len >= e || A.len > e || A.len + B.len < e) { ok = false; break; }
          if (A.len < e && A.len + B.len === e) split = split || A.len;
        }
        if (!ok) break;
      }
      if (!ok || !split) continue;
      for (const l of lists) {
        // Platzhalter-Pausen (ausgeblendete Notenzeilen) auf die echte Länge kürzen
        fitMeasureRests(doc, l[i], split);
        fitMeasureRests(doc, l[i + 1], e - split);
        appendMeasure(doc, l[i], l[i + 1]);
      }
      merged++;
    }
    if (!merged) return;
    for (const p of parts) kids(p, 'measure').forEach((m, i) => m.setAttribute('number', String(i + 1)));
  }

  /** Je Notenzeile: Länge und ob sie nur aus einer Ganztaktpause besteht. */
  function staffLengths(measure) {
    const out = new Map();
    let pos = 0;
    for (const el of measure.children) {
      if (el.tagName === 'backup') pos -= durOf(el);
      else if (el.tagName === 'forward') pos += durOf(el);
      else if (el.tagName === 'note') {
        const st = kidText(el, 'staff') || '1';
        const info = out.get(st) || { len: 0, restOnly: true };
        if (!(isRest(el) && kid(el, 'rest').getAttribute('measure') === 'yes')) info.restOnly = false;
        if (!isChordMember(el) && !isGrace(el)) pos += durOf(el);
        info.len = Math.max(info.len, pos);
        out.set(st, info);
      }
    }
    return out;
  }

  function fitMeasureRests(doc, measure, len) {
    const lengths = staffLengths(measure);
    for (const note of kids(measure, 'note')) {
      const st = kidText(note, 'staff') || '1';
      if (!lengths.get(st).restOnly || !isRest(note)) continue;
      const delta = len - durOf(note);
      setKidText(note, 'duration', len);
      adjustBackup(note, delta);
    }
  }

  function measureCursor(measure) {
    let pos = 0;
    for (const el of measure.children) {
      if (el.tagName === 'backup') pos -= durOf(el);
      else if (el.tagName === 'forward') pos += durOf(el);
      else if (el.tagName === 'note' && !isChordMember(el) && !isGrace(el)) pos += durOf(el);
    }
    return pos;
  }

  function appendMeasure(doc, a, b) {
    const timing = (name, d) => { const e = mk(doc, name); e.appendChild(mk(doc, 'duration', d)); return e; };
    const la = measureLength(a), cur = measureCursor(a);
    for (const r of [...a.querySelectorAll('note > rest[measure]'), ...b.querySelectorAll('note > rest[measure]')]) {
      r.removeAttribute('measure');
      const note = r.parentElement;
      if (!kidText(note, 'type')) {
        const t = typeFromDuration(doc, durOf(note));
        if (t) applyValue(doc, note, t.type, t.dots);
      }
    }
    for (const bl of kids(a, 'barline')) if ((bl.getAttribute('location') || 'right') === 'right') bl.remove();
    if (cur > 0) a.appendChild(timing('backup', cur));
    if (la > 0) a.appendChild(timing('forward', la));
    for (const el of Array.from(b.children)) {
      if (el.tagName === 'print') continue;
      if (el.tagName === 'barline' && (el.getAttribute('location') || 'right') === 'left') continue;
      if (el.tagName === 'attributes') {
        // gleiche Schlüssel, Tonart und Taktart wie bisher nicht wiederholen
        for (const c of Array.from(el.children)) {
          if (['divisions', 'staves', 'part-symbol'].includes(c.tagName)) { c.remove(); continue; }
          const sel = c.tagName === 'clef' ? `clef[number="${c.getAttribute('number') || '1'}"], clef:not([number])` : c.tagName;
          const prev = Array.from(a.parentElement.querySelectorAll('attributes > ' + c.tagName))
            .filter(x => x.closest('measure') !== b && x.matches(sel)).pop();
          if (prev && prev.textContent.replace(/\s/g, '') === c.textContent.replace(/\s/g, '')) c.remove();
        }
        if (!el.children.length) continue;
      }
      a.appendChild(el);
    }
    b.remove();
    linearizeMeasure(doc, a);
  }

  function context(doc) {
    const map = new Map();
    for (const part of doc.querySelectorAll('part')) {
      let fifths = 0, beats = 4, beatType = 4;
      const measures = kids(part, 'measure');
      measures.forEach((measure, index) => {
        for (const el of measure.children) {
          if (el.tagName === 'note') break;
          if (el.tagName === 'attributes') ({ fifths, beats, beatType } = readAttrs(el, fifths, beats, beatType));
        }
        map.set(measure, { fifths, beats, beatType, index, count: measures.length, part });
        for (const el of kids(measure, 'attributes')) ({ fifths, beats, beatType } = readAttrs(el, fifths, beats, beatType));
      });
    }
    return map;
  }
  function readAttrs(a, fifths, beats, beatType) {
    const k = kid(a, 'key');
    if (k && kidText(k, 'fifths') != null) fifths = parseInt(kidText(k, 'fifths'), 10) || 0;
    const t = kid(a, 'time');
    if (t) {
      const b = parseInt(kidText(t, 'beats'), 10), bt = parseInt(kidText(t, 'beat-type'), 10);
      if (b > 0 && bt > 0) { beats = b; beatType = bt; }
    }
    return { fifths, beats, beatType };
  }
  const infoFor = (doc, note) => context(doc).get(note.parentElement) || { fifths: 0, beats: 4, beatType: 4, index: 0, count: 1 };

  function keyAlter(fifths, step) {
    const sharps = [3, 0, 4, 1, 5, 2, 6], flats = [6, 2, 5, 1, 4, 0, 3];
    if (fifths > 0 && sharps.indexOf(step) < fifths) return 1;
    if (fifths < 0 && flats.indexOf(step) < -fifths) return -1;
    return 0;
  }
  function mainKey(doc) {
    const f = doc.querySelector('attributes > key > fifths');
    return f ? parseInt(f.textContent, 10) || 0 : 0;
  }
  function mainTime(doc) {
    const t = doc.querySelector('attributes > time');
    return t ? `${kidText(t, 'beats')}/${kidText(t, 'beat-type')}` : '';
  }

  // ------------------------------------------------------------ Noten
  const isRest = n => !!kid(n, 'rest');
  const isGrace = n => !!kid(n, 'grace');
  const isChordMember = n => !!kid(n, 'chord');
  const durOf = el => parseInt(kidText(el, 'duration') || '0', 10) || 0;
  const dotsOf = n => kids(n, 'dot').length;
  const voiceKey = n => (kidText(n, 'voice') || '1') + '/' + (kidText(n, 'staff') || '1');
  const hasTie = (n, type) => kids(n, 'tie').some(t => t.getAttribute('type') === type);

  function getPitch(note) {
    const p = kid(note, 'pitch');
    if (!p) return null;
    return {
      step: STEPS.indexOf(kidText(p, 'step')),
      alter: Math.round(parseFloat(kidText(p, 'alter') || '0')) || 0,
      octave: parseInt(kidText(p, 'octave'), 10),
    };
  }
  function setPitch(note, p) {
    const doc = note.ownerDocument;
    let el = kid(note, 'pitch');
    if (!el) {
      removeKids(note, 'rest', 'unpitched');
      el = insertOrdered(note, mk(doc, 'pitch'), NOTE_ORDER);
    }
    el.textContent = '';
    el.appendChild(mk(doc, 'step', STEPS[p.step]));
    if (p.alter) el.appendChild(mk(doc, 'alter', p.alter));
    el.appendChild(mk(doc, 'octave', p.octave));
  }
  const midi = p => (p.octave + 1) * 12 + NAT[p.step] + p.alter;

  function chordGroup(note) {
    let head = note;
    while (isChordMember(head)) {
      const p = head.previousElementSibling;
      if (!p || p.tagName !== 'note') break;
      head = p;
    }
    const g = [head];
    let n = head.nextElementSibling;
    while (n && n.tagName === 'note' && isChordMember(n)) { g.push(n); n = n.nextElementSibling; }
    return g;
  }

  function calcDuration(doc, note, type, dots) {
    let d = div(doc) * 4 / TYPES[type] * (2 - Math.pow(2, -dots));
    const tm = kid(note, 'time-modification');
    if (tm) {
      const a = parseInt(kidText(tm, 'actual-notes'), 10), n = parseInt(kidText(tm, 'normal-notes'), 10);
      if (a > 0 && n > 0) d = d * n / a;
    }
    return Math.max(1, Math.round(d));
  }
  function typeFromDuration(doc, dur) {
    for (const dots of [0, 1, 2]) {
      for (const t of Object.keys(TYPES)) {
        if (Math.round(div(doc) * 4 / TYPES[t] * (2 - Math.pow(2, -dots))) === dur) return { type: t, dots };
      }
    }
    return null;
  }
  /** Sorgt dafür, dass eine Note einen ausgeschriebenen Notenwert hat (z. B. Ganztaktpausen). */
  function ensureType(doc, note) {
    if (kidText(note, 'type') && TYPES[kidText(note, 'type')]) return;
    const t = typeFromDuration(doc, durOf(note)) || { type: 'quarter', dots: 0 };
    applyValue(doc, note, t.type, t.dots);
  }
  function applyValue(doc, note, type, dots) {
    const rest = kid(note, 'rest');
    if (rest) rest.removeAttribute('measure');
    setKidText(note, 'type', type);
    removeKids(note, 'dot');
    for (let i = 0; i < dots; i++) insertOrdered(note, mk(doc, 'dot'), NOTE_ORDER);
    if (!isGrace(note)) setKidText(note, 'duration', calcDuration(doc, note, type, dots));
  }

  /** Passt das nächste <backup> an, damit die folgenden Stimmen an ihrem Platz bleiben. */
  function adjustBackup(el, delta) {
    if (!delta) return;
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.tagName !== 'backup') continue;
      const d = kid(n, 'duration');
      const v = (parseInt(d.textContent, 10) || 0) + delta;
      if (v <= 0) n.remove(); else d.textContent = String(v);
      return;
    }
  }

  // ------------------------------------------------------------ Balken
  function rebeam(doc, measure) {
    const info = context(doc).get(measure) || { beats: 4, beatType: 4 };
    let beatLen = div(doc) * 4 / info.beatType;
    if (info.beatType === 8 && info.beats % 3 === 0) beatLen *= 3;
    let pos = 0;
    const voices = new Map();
    for (const el of measure.children) {
      if (el.tagName === 'backup') pos -= durOf(el);
      else if (el.tagName === 'forward') pos += durOf(el);
      else if (el.tagName === 'note') {
        if (isGrace(el)) continue;
        removeKids(el, 'beam');
        if (isChordMember(el)) continue;
        const key = voiceKey(el);
        if (!voices.has(key)) voices.set(key, []);
        const t = TYPES[kidText(el, 'type')] || 0;
        voices.get(key).push({ el, beat: Math.floor(pos / beatLen + 1e-9), ok: !isRest(el) && t >= 8 });
        pos += durOf(el);
      }
    }
    const flush = run => {
      if (run.length < 2) return;
      run.forEach((r, i) => {
        const b = mk(doc, 'beam', i === 0 ? 'begin' : i === run.length - 1 ? 'end' : 'continue');
        b.setAttribute('number', '1');
        insertOrdered(r.el, b, NOTE_ORDER);
      });
    };
    for (const list of voices.values()) {
      let run = [];
      for (const item of list) {
        if (!item.ok || (run.length && run[0].beat !== item.beat)) { flush(run); run = []; }
        if (item.ok) run.push(item);
      }
      flush(run);
    }
  }

  // ------------------------------------------------------------ Versetzungszeichen
  function recomputeAccidentals(doc, onlyMeasure) {
    for (const part of doc.querySelectorAll('part')) {
      let fifths = 0;
      for (const measure of kids(part, 'measure')) {
        const active = !onlyMeasure || measure === onlyMeasure;
        const state = new Map();
        for (const el of measure.children) {
          if (el.tagName === 'attributes') {
            const k = kid(el, 'key');
            if (k && kidText(k, 'fifths') != null) fifths = parseInt(kidText(k, 'fifths'), 10) || 0;
          } else if (el.tagName === 'note' && active) {
            const p = getPitch(el);
            if (!p || p.step < 0) continue;
            const key = (kidText(el, 'staff') || '1') + '|' + p.step + '|' + p.octave;
            const cur = state.has(key) ? state.get(key) : keyAlter(fifths, p.step);
            removeKids(el, 'accidental');
            if (p.alter !== cur && !hasTie(el, 'stop') && ACC_NAMES[p.alter]) {
              insertOrdered(el, mk(doc, 'accidental', ACC_NAMES[p.alter]), NOTE_ORDER);
            }
            state.set(key, p.alter);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ Transponieren
  const INTERVALS = [[0, 0], [1, 1], [1, 2], [2, 3], [2, 4], [3, 5], [3, 6], [4, 7], [5, 8], [5, 9], [6, 10], [6, 11], [7, 12]];

  function transposePitch(p, d, c) {
    let n = p.octave * 7 + p.step + d;
    const chroma = midi(p) + c;
    const build = () => {
      const step = mod(n, 7), octave = Math.floor(n / 7);
      return { step, octave, alter: chroma - ((octave + 1) * 12 + NAT[step]) };
    };
    let r = build();
    while (r.alter > 2) { n += 1; r = build(); }
    while (r.alter < -2) { n -= 1; r = build(); }
    return r;
  }

  /** Transponiert das ganze Stück um die angegebene Zahl von Halbtönen. Gibt die neue Tonart zurück. */
  function transpose(doc, semitones) {
    const sign = Math.sign(semitones);
    let rest = Math.abs(semitones), octaves = 0;
    while (rest > 12) { rest -= 12; octaves++; }
    let d = sign * (INTERVALS[rest][0] + 7 * octaves);
    const c = semitones;
    const k = mainKey(doc);
    let f = 7 * c - 12 * d;
    if (Math.abs(k + f) > 6) {
      const up = Math.abs(k + f - 12), down = Math.abs(k + f + 12);
      if (up < Math.abs(k + f) && up <= down) { d += 1; f -= 12; }
      else if (down < Math.abs(k + f)) { d -= 1; f += 12; }
    }
    for (const note of doc.querySelectorAll('note')) {
      const p = getPitch(note);
      if (!p || p.step < 0) continue;
      setPitch(note, transposePitch(p, d, c));
      removeKids(note, 'stem');
    }
    for (const el of doc.querySelectorAll('key > fifths')) {
      let v = (parseInt(el.textContent, 10) || 0) + f;
      if (v > 7) v -= 12;
      if (v < -7) v += 12;
      el.textContent = String(v);
    }
    for (const [tag, stepName, alterName] of [['root', 'root-step', 'root-alter'], ['bass', 'bass-step', 'bass-alter']]) {
      for (const el of doc.querySelectorAll('harmony > ' + tag)) {
        const s = kid(el, stepName);
        if (!s) continue;
        const step = STEPS.indexOf(s.textContent.trim());
        if (step < 0) continue;
        const a = kid(el, alterName);
        const alter = a ? Math.round(parseFloat(a.textContent)) || 0 : 0;
        const ns = mod(step + d, 7);
        const na = mod(NAT[step] + alter + c - NAT[ns] + 6, 12) - 6;
        s.textContent = STEPS[ns];
        if (a) a.textContent = String(na);
        else if (na) s.after(mk(doc, alterName, na));
      }
    }
    recomputeAccidentals(doc);
    return mainKey(doc);
  }

  // ------------------------------------------------------------ Tonart / Taktart
  function ensureAttributes(doc, part) {
    const first = kid(part, 'measure');
    let a = kid(first, 'attributes');
    if (!a) { a = mk(doc, 'attributes'); first.insertBefore(a, first.firstChild); }
    return a;
  }

  /** Setzt die Vorzeichnung. Noten ohne eigenes Versetzungszeichen folgen der neuen Tonart. */
  function setKey(doc, fifths) {
    for (const part of doc.querySelectorAll('part')) {
      for (const measure of kids(part, 'measure')) {
        const state = new Map();
        for (const note of kids(measure, 'note')) {
          const p = getPitch(note);
          if (!p || p.step < 0) continue;
          const key = (kidText(note, 'staff') || '1') + '|' + p.step + '|' + p.octave;
          if (kid(note, 'accidental') || hasTie(note, 'stop')) { state.set(key, p.alter); continue; }
          const alter = state.has(key) ? state.get(key) : keyAlter(fifths, p.step);
          if (alter !== p.alter) setPitch(note, { ...p, alter });
        }
      }
      const keys = part.querySelectorAll('attributes > key');
      if (keys.length) {
        for (const k of keys) {
          const f = kid(k, 'fifths');
          if (f) f.textContent = String(fifths); else k.insertBefore(mk(doc, 'fifths', fifths), k.firstChild);
        }
      } else {
        const k = mk(doc, 'key');
        k.appendChild(mk(doc, 'fifths', fifths));
        insertOrdered(ensureAttributes(doc, part), k, ATTR_ORDER);
      }
    }
    recomputeAccidentals(doc);
  }

  function setTime(doc, beats, beatType) {
    for (const part of doc.querySelectorAll('part')) {
      const times = part.querySelectorAll('attributes > time');
      const fill = t => {
        t.removeAttribute('symbol');
        t.textContent = '';
        t.appendChild(mk(doc, 'beats', beats));
        t.appendChild(mk(doc, 'beat-type', beatType));
      };
      if (times.length) times.forEach(fill);
      else { const t = mk(doc, 'time'); fill(t); insertOrdered(ensureAttributes(doc, part), t, ATTR_ORDER); }
    }
    for (const m of doc.querySelectorAll('part > measure')) rebeam(doc, m);
  }

  // ------------------------------------------------------------ Taktprüfung
  function measureLength(measure) {
    let pos = 0, max = 0, any = false;
    for (const el of measure.children) {
      if (el.tagName === 'backup') pos -= durOf(el);
      else if (el.tagName === 'forward') pos += durOf(el);
      else if (el.tagName === 'note' && !isChordMember(el) && !isGrace(el)) { pos += durOf(el); any = true; }
      if (pos > max) max = pos;
    }
    return any ? max : null;
  }
  function measureFill(doc, measure, ctx) {
    const info = (ctx || context(doc)).get(measure);
    if (!info) return null;
    const len = measureLength(measure);
    if (len == null) return null;
    const expected = info.beats * div(doc) * 4 / info.beatType;
    const beat = div(doc) * 4 / info.beatType;
    const edge = info.index === 0 || info.index === info.count - 1;
    // Ein geteilter Takt (z. B. an einem Doppelstrich) ergänzt sich mit dem Nachbartakt zu einem vollen.
    const pair = n => { const l = n && n.tagName === 'measure' ? measureLength(n) : null; return l != null && l + len === expected; };
    const split = len < expected && (pair(measure.previousElementSibling) || pair(measure.nextElementSibling));
    const ok = len === expected || measure.getAttribute('implicit') === 'yes' || (edge && len < expected) || split;
    return { ok, beats: Math.round(len / beat * 100) / 100, expected: info.beats, beatType: info.beatType };
  }
  /** Liefert je fehlerhaftem Takt die id einer enthaltenen Note (zum Auffinden in der Grafik). */
  function badMeasures(doc) {
    const ctx = context(doc), out = [];
    for (const measure of doc.querySelectorAll('part > measure')) {
      const f = measureFill(doc, measure, ctx);
      if (f && !f.ok) {
        const n = measure.querySelector('note[id]');
        if (n) out.push(n.getAttribute('id'));
      }
    }
    return out;
  }

  // ------------------------------------------------------------ Bearbeiten
  const byId = (doc, id) => (id ? doc.querySelector(`note[id="${id}"]`) : null);

  function afterPitchChange(doc, note) {
    for (const n of chordGroup(note)) removeKids(n, 'stem');
    recomputeAccidentals(doc, note.parentElement);
  }

  function referencePitch(note) {
    const all = Array.from(note.closest('part').querySelectorAll('note'));
    const staff = kidText(note, 'staff') || '1';
    const i = all.indexOf(note);
    for (let j = i - 1; j >= 0; j--) if (getPitch(all[j]) && (kidText(all[j], 'staff') || '1') === staff) return getPitch(all[j]);
    for (let j = i + 1; j < all.length; j++) if (getPitch(all[j]) && (kidText(all[j], 'staff') || '1') === staff) return getPitch(all[j]);
    return staff === '2' ? { step: 1, alter: 0, octave: 3 } : { step: 6, alter: 0, octave: 4 };
  }

  function restToNote(doc, note, pitch) {
    ensureType(doc, note);
    setPitch(note, pitch);
  }

  function movePitch(doc, note, steps) {
    if (isRest(note)) {
      const ref = referencePitch(note);
      restToNote(doc, note, { ...ref, alter: keyAlter(infoFor(doc, note).fifths, ref.step) });
    } else {
      const p = getPitch(note);
      if (!p || p.step < 0) return false;
      const n = p.octave * 7 + p.step + steps;
      const step = mod(n, 7);
      setPitch(note, { step, octave: Math.floor(n / 7), alter: keyAlter(infoFor(doc, note).fifths, step) });
    }
    afterPitchChange(doc, note);
    rebeam(doc, note.parentElement);
  }
  function moveOctave(doc, note, dir) {
    const p = getPitch(note);
    if (!p || p.step < 0) return false;
    setPitch(note, { ...p, octave: Math.max(0, Math.min(9, p.octave + dir)) });
    afterPitchChange(doc, note);
  }
  function alterPitch(doc, note, delta) {
    const p = getPitch(note);
    if (!p || p.step < 0) return false;
    const alter = delta === 0 ? 0 : Math.max(-2, Math.min(2, p.alter + delta));
    if (alter === p.alter) return false;
    setPitch(note, { ...p, alter });
    afterPitchChange(doc, note);
  }
  function setStep(doc, note, step, forcedAlter) {
    const ref = getPitch(note) || referencePitch(note);
    const alter = forcedAlter != null ? forcedAlter : keyAlter(infoFor(doc, note).fifths, step);
    let best = null;
    for (const octave of [ref.octave - 1, ref.octave, ref.octave + 1]) {
      const dist = Math.abs(octave * 7 + step - (ref.octave * 7 + ref.step));
      if (!best || dist < best.dist) best = { dist, octave };
    }
    if (isRest(note)) restToNote(doc, note, { step, alter, octave: best.octave });
    else setPitch(note, { step, alter, octave: best.octave });
    afterPitchChange(doc, note);
    rebeam(doc, note.parentElement);
  }

  function setValue(doc, note, type, toggleDot) {
    const group = chordGroup(note), head = group[0];
    ensureType(doc, head);
    const curType = kidText(head, 'type'), curDots = dotsOf(head);
    const newType = type || curType;
    const newDots = toggleDot ? (curDots ? 0 : 1) : (type ? 0 : curDots);
    if (!TYPES[newType] || (newType === curType && newDots === curDots)) return false;
    const before = durOf(head);
    for (const n of group) applyValue(doc, n, newType, newDots);
    adjustBackup(group[group.length - 1], durOf(head) - before);
    rebeam(doc, head.parentElement);
  }

  function stripForClone(n) {
    removeKids(n, 'chord', 'grace', 'cue', 'tie', 'accidental', 'stem', 'beam', 'notations', 'lyric', 'notehead');
  }

  function insertAfter(doc, note) {
    const group = chordGroup(note), head = group[0], last = group[group.length - 1];
    ensureType(doc, head);
    const clone = head.cloneNode(true);
    stripForClone(clone);
    if (isRest(clone)) {
      const ref = referencePitch(head);
      setPitch(clone, { ...ref, alter: keyAlter(infoFor(doc, head).fifths, ref.step) });
    }
    if (!kid(clone, 'duration')) setKidText(clone, 'duration', calcDuration(doc, clone, kidText(clone, 'type'), dotsOf(clone)));
    const id = setId(clone);
    last.after(clone);
    adjustBackup(clone, durOf(clone));
    recomputeAccidentals(doc, clone.parentElement);
    rebeam(doc, clone.parentElement);
    return id;
  }

  function addChordTone(doc, note) {
    if (isRest(note) || !getPitch(note)) return false;
    const group = chordGroup(note), last = group[group.length - 1];
    const clone = note.cloneNode(true);
    stripForClone(clone);
    insertOrdered(clone, mk(doc, 'chord'), NOTE_ORDER);
    const top = group.map(getPitch).filter(Boolean).sort((a, b) => midi(b) - midi(a))[0];
    const n = top.octave * 7 + top.step + 2, step = mod(n, 7);
    setPitch(clone, { step, octave: Math.floor(n / 7), alter: keyAlter(infoFor(doc, note).fifths, step) });
    const id = setId(clone);
    last.after(clone);
    for (const g of chordGroup(clone)) removeKids(g, 'stem');
    recomputeAccidentals(doc, clone.parentElement);
    return id;
  }

  function neighbourId(note, dir) {
    const all = Array.from(note.closest('part').querySelectorAll('note'));
    const staff = kidText(note, 'staff') || '1';
    for (let i = all.indexOf(note) + dir; i >= 0 && i < all.length; i += dir) {
      if ((kidText(all[i], 'staff') || '1') === staff) return all[i].getAttribute('id');
    }
    return null;
  }

  function toRest(doc, note) {
    if (isRest(note)) return false;
    const group = chordGroup(note), head = group[0];
    for (const n of group) if (n !== head) n.remove();
    const id = head.getAttribute('id');
    removeKids(head, 'pitch', 'unpitched', 'chord', 'tie', 'accidental', 'stem', 'beam', 'notations', 'lyric', 'notehead');
    insertOrdered(head, mk(doc, 'rest'), NOTE_ORDER);
    recomputeAccidentals(doc, head.parentElement);
    rebeam(doc, head.parentElement);
    return id;
  }

  function deleteNote(doc, note, hard) {
    const group = chordGroup(note);
    const measure = note.parentElement;
    if (group.length > 1) {
      const other = group[group.indexOf(note) === 0 ? 1 : group.indexOf(note) - 1];
      if (note === group[0]) {
        removeKids(group[1], 'chord');
        for (const b of kids(note, 'beam')) insertOrdered(group[1], b, NOTE_ORDER);
      }
      note.remove();
      recomputeAccidentals(doc, measure);
      return other.getAttribute('id');
    }
    if (!isRest(note) && !hard) return toRest(doc, note);
    const next = neighbourId(note, 1) || neighbourId(note, -1);
    if (!isGrace(note)) adjustBackup(note, -durOf(note));
    note.remove();
    recomputeAccidentals(doc, measure);
    rebeam(doc, measure);
    return next || '';
  }

  function setTieMark(doc, note, type, on) {
    for (const t of kids(note, 'tie')) if (t.getAttribute('type') === type) t.remove();
    const nots = kid(note, 'notations');
    if (nots) {
      for (const t of kids(nots, 'tied')) if (t.getAttribute('type') === type) t.remove();
      if (!nots.children.length) nots.remove();
    }
    if (!on) return;
    const tie = mk(doc, 'tie'); tie.setAttribute('type', type);
    insertOrdered(note, tie, NOTE_ORDER);
    let n = kid(note, 'notations');
    if (!n) n = insertOrdered(note, mk(doc, 'notations'), NOTE_ORDER);
    const tied = mk(doc, 'tied'); tied.setAttribute('type', type);
    n.insertBefore(tied, n.firstChild);
  }

  function toggleTie(doc, note) {
    const p = getPitch(note);
    if (!p || p.step < 0) return false;
    const all = Array.from(note.closest('part').querySelectorAll('note'));
    const vk = voiceKey(note);
    const start = all.indexOf(chordGroup(note).slice(-1)[0]) + 1;
    let target = null, groups = 0;
    for (let i = start; i < all.length && groups < 2; i++) {
      const n = all[i];
      if (voiceKey(n) !== vk || isGrace(n)) continue;
      if (!isChordMember(n)) groups++;
      if (groups > 1) break;
      const q = getPitch(n);
      if (q && q.step === p.step && q.octave === p.octave && q.alter === p.alter) { target = n; break; }
    }
    const on = !hasTie(note, 'start');
    if (on && !target) return false;
    setTieMark(doc, note, 'start', on);
    if (target) {
      setTieMark(doc, target, 'stop', on);
      recomputeAccidentals(doc, target.parentElement);
    }
  }

  // ------------------------------------------------------------ Beschreibung
  function pitchName(p) {
    const base = ['c', 'd', 'e', 'f', 'g', 'a', 'h'][p.step];
    let name;
    if (p.alter === 0) name = base;
    else if (p.alter > 0) name = base + 'is'.repeat(p.alter);
    else if (p.step === 6) name = p.alter === -1 ? 'b' : 'heses';
    else if (p.step === 2 || p.step === 5) name = base + 's' + 'es'.repeat(-p.alter - 1);
    else name = base + 'es'.repeat(-p.alter);
    if (p.octave >= 3) return name + '′'.repeat(p.octave - 3);
    return name.charAt(0).toUpperCase() + name.slice(1) + ','.repeat(2 - p.octave);
  }
  function describe(doc, note) {
    const measure = note.parentElement;
    const parts = [`Takt ${measure.getAttribute('number') || '?'}`];
    const type = kidText(note, 'type');
    let value = TYPE_NAMES[type] || '';
    if (dotsOf(note)) value = 'punktierte ' + value;
    if (kid(note, 'time-modification')) value += ' (Triole)';
    if (isRest(note)) parts.push((value || 'Ganztakt') + '-Pause');
    else {
      const p = getPitch(note);
      parts.push(value + (isGrace(note) ? ' (Vorschlag)' : ''));
      if (p && p.step >= 0) parts.push(pitchName(p));
    }
    return { parts, fill: measureFill(doc, measure) };
  }

  const KEY_MAJOR = ['Ces', 'Ges', 'Des', 'As', 'Es', 'B', 'F', 'C', 'G', 'D', 'A', 'E', 'H', 'Fis', 'Cis'];
  const KEY_MINOR = ['as', 'es', 'b', 'f', 'c', 'g', 'd', 'a', 'e', 'h', 'fis', 'cis', 'gis', 'dis', 'ais'];
  function keyName(fifths) {
    const f = Math.max(-7, Math.min(7, fifths));
    const sig = f === 0 ? 'keine Vorzeichen' : `${Math.abs(f)} ${f > 0 ? '♯' : '♭'}`;
    return `${KEY_MAJOR[f + 7]}-Dur / ${KEY_MINOR[f + 7]}-Moll (${sig})`;
  }

  // ------------------------------------------------------------ Akkordnamen
  const KIND_SUFFIX = {
    major: '', minor: 'm', augmented: '+', diminished: 'dim', dominant: '7', 'major-seventh': 'maj7',
    'minor-seventh': 'm7', 'diminished-seventh': 'dim7', 'augmented-seventh': '+7',
    'half-diminished': 'm7♭5', 'major-minor': 'm(maj7)', 'major-sixth': '6', 'minor-sixth': 'm6',
    'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9', 'dominant-11th': '11',
    'dominant-13th': '13', 'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5',
    other: '', none: '',
  };
  const CHORD_STYLES = {
    de: 'Deutsch (H, B, Fis, Es)',
    'de-sym': 'Deutsch (H, B, F♯, E♭)',
    en: 'International (B, B♭, F♯)',
  };

  /** Name eines Tons in der gewählten Akkordschreibweise. */
  function chordNote(step, alter, style) {
    const sym = a => (a > 0 ? '♯'.repeat(a) : '♭'.repeat(-a));
    if (style === 'en') return step + sym(alter);
    if (step === 'B') {
      if (alter === 0) return 'H';
      if (alter === -1) return 'B';
      if (style === 'de') return alter > 0 ? 'H' + 'is'.repeat(alter) : 'Heses';
      return alter > 0 ? 'H' + sym(alter) : 'B♭';
    }
    if (style === 'de-sym') return step + sym(alter);
    if (alter > 0) return step + 'is'.repeat(alter);
    if (alter < 0) {
      if (step === 'E' || step === 'A') return step + 's' + 'es'.repeat(-alter - 1);
      return step + 'es'.repeat(-alter);
    }
    return step;
  }

  function chordLabel(h, style) {
    const step = h.querySelector('root > root-step')?.textContent.trim();
    if (!step) return null;
    const alter = Math.round(parseFloat(h.querySelector('root > root-alter')?.textContent || '0')) || 0;
    const kind = h.querySelector('kind');
    let suffix = kind && kind.hasAttribute('text') ? kind.getAttribute('text') : (KIND_SUFFIX[kind?.textContent.trim()] ?? '');
    if (style !== 'en') suffix = suffix.replace(/#/g, '♯').replace(/(\d)b/g, '$1♭');
    const bstep = h.querySelector('bass > bass-step')?.textContent.trim();
    const balter = Math.round(parseFloat(h.querySelector('bass > bass-alter')?.textContent || '0')) || 0;
    return { root: chordNote(step, alter, style), suffix: suffix + (bstep ? '/' + chordNote(bstep, balter, style) : '') };
  }

  /** MusicXML nur für die Anzeige: Akkorde in der gewünschten Schreibweise. */
  function serializeForDisplay(doc, style) {
    const d = doc.cloneNode(true);
    for (const h of d.querySelectorAll('harmony')) {
      const label = chordLabel(h, style);
      if (!label) continue;
      const root = h.querySelector('root');
      root.textContent = '';
      const rs = d.createElement('root-step');
      rs.textContent = 'C';
      rs.setAttribute('text', label.root);
      root.appendChild(rs);
      let kind = h.querySelector('kind');
      if (!kind) { kind = d.createElement('kind'); root.after(kind); }
      kind.textContent = 'none';
      kind.setAttribute('text', label.suffix);
      h.querySelector('bass')?.remove();
    }
    return serialize(d);
  }

  // ------------------------------------------------------------ Dynamik und Vortragszeichen
  function hasMark(note, name) {
    const head = chordGroup(note)[0];
    const nots = kid(head, 'notations');
    if (!nots) return false;
    if (name === 'fermata') return !!kid(nots, 'fermata');
    const arts = kid(nots, 'articulations');
    return !!(arts && kid(arts, name));
  }

  function toggleMark(doc, note, name) {
    const head = chordGroup(note)[0];
    let nots = kid(head, 'notations');
    if (hasMark(note, name)) {
      if (name === 'fermata') kid(nots, 'fermata').remove();
      else {
        const arts = kid(nots, 'articulations');
        kid(arts, name).remove();
        if (!arts.children.length) arts.remove();
      }
      if (!nots.children.length) nots.remove();
      return;
    }
    if (!nots) nots = insertOrdered(head, mk(doc, 'notations'), NOTE_ORDER);
    if (name === 'fermata') {
      const f = mk(doc, 'fermata');
      f.setAttribute('type', 'upright');
      nots.appendChild(f);
    } else {
      let arts = kid(nots, 'articulations');
      if (!arts) arts = nots.appendChild(mk(doc, 'articulations'));
      arts.appendChild(mk(doc, name));
    }
  }

  /** Dynamik-Anweisungen direkt vor einer Note (bzw. vor dem Akkord, zu dem sie gehört). */
  function dynamicsBefore(note) {
    const head = chordGroup(note)[0];
    const out = [];
    for (let el = head.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.tagName === 'note' || el.tagName === 'backup' || el.tagName === 'forward') break;
      if (el.tagName === 'direction' && el.querySelector('direction-type > dynamics')) out.push(el);
    }
    return out;
  }
  function getDynamic(note) {
    const d = dynamicsBefore(note)[0];
    const el = d && d.querySelector('direction-type > dynamics > *');
    return el ? el.tagName : '';
  }
  function setDynamic(doc, note, name) {
    const head = chordGroup(note)[0];
    const old = dynamicsBefore(note);
    if (!old.length && !name) return false;
    old.forEach(d => d.remove());
    if (!name) return;
    const dir = mk(doc, 'direction');
    dir.setAttribute('placement', 'below');
    const dt = dir.appendChild(mk(doc, 'direction-type'));
    dt.appendChild(mk(doc, 'dynamics')).appendChild(mk(doc, name));
    dir.appendChild(mk(doc, 'staff', kidText(head, 'staff') || '1'));
    head.before(dir);
  }

  /** Für die Wiedergabe: Lautstärke jeder Note aus der zuletzt gültigen Dynamik ihrer Notenzeile. */
  const DYN_LEVEL = { pppp: 0.25, ppp: 0.32, pp: 0.4, p: 0.52, mp: 0.64, mf: 0.76, f: 0.9, ff: 1.0, fff: 1.08, ffff: 1.15 };
  const DYN_ACCENT = new Set(['sf', 'sfz', 'sffz', 'fz', 'rf', 'rfz', 'sfp', 'fp']);
  /** Für die Wiedergabe: Lautstärke jeder Note aus Dynamik, Gabeln und "cresc."/"dim.". */
  function dynamicLevels(doc) {
    const out = new Map();
    for (const part of doc.querySelectorAll('part')) {
      // 1. je Notenzeile die Ereignisse in Lesereihenfolge sammeln
      const seqs = new Map();
      const seqOf = st => { if (!seqs.has(st)) seqs.set(st, []); return seqs.get(st); };
      let lastHead = null;
      for (const measure of kids(part, 'measure')) {
        for (const el of measure.children) {
          if (el.tagName === 'direction') {
            const st = kidText(el, 'staff') || '1';
            const d = el.querySelector('direction-type > dynamics > *');
            if (d && DYN_LEVEL[d.tagName] != null) seqOf(st).push({ t: 'dyn', v: DYN_LEVEL[d.tagName] });
            else if (d && DYN_ACCENT.has(d.tagName)) seqOf(st).push({ t: 'acc' });
            const w = el.querySelector('direction-type > wedge');
            if (w) {
              const type = w.getAttribute('type');
              if (type === 'crescendo' || type === 'diminuendo') seqOf(st).push({ t: 'start', up: type === 'crescendo', stop: 'wedge' });
              else if (type === 'stop') seqOf(st).push({ t: 'stop' });
            }
            const words = el.querySelector('direction-type > words')?.textContent.trim().toLowerCase() || '';
            if (/^(poco a poco |poco |sempre |molto )?cresc/.test(words)) seqOf(st).push({ t: 'start', up: true, stop: 'dyn' });
            else if (/^(poco a poco |poco |sempre |molto )?(dim|decresc)/.test(words)) seqOf(st).push({ t: 'start', up: false, stop: 'dyn' });
          } else if (el.tagName === 'note' && el.getAttribute('id')) {
            if (isChordMember(el) && lastHead) { lastHead.members.push(el.getAttribute('id')); continue; }
            lastHead = { t: 'note', id: el.getAttribute('id'), members: [], rest: isRest(el) };
            seqOf(kidText(el, 'staff') || '1').push(lastHead);
          }
        }
      }
      // 2. Lautstärken berechnen, Verläufe linear verteilen
      for (const seq of seqs.values()) {
        let level = 0.76, accent = false;
        const set = (n, v) => { out.set(n.id, v); for (const m of n.members) out.set(m, v); };
        for (let i = 0; i < seq.length; i++) {
          const e = seq[i];
          if (e.t === 'dyn') level = e.v;
          else if (e.t === 'acc') accent = true;
          else if (e.t === 'note') {
            set(e, accent && !e.rest ? Math.min(1.2, level * 1.35) : level);
            if (!e.rest) accent = false;
          } else if (e.t === 'start') {
            const notes = [];
            let k = i + 1, target = null;
            for (; k < seq.length; k++) {
              const x = seq[k];
              if (x.t === 'note') {
                notes.push(x);
                if (e.stop === 'dyn' && notes.length >= 12) break;   // "cresc." ohne Ziel: höchstens 12 Noten
              } else if (x.t === 'stop' && e.stop === 'wedge') break;
              else if (x.t === 'dyn') { target = x.v; break; }
              else if (x.t === 'start') { k--; break; }
            }
            if (target == null) {
              // Ziel: eine direkt folgende Dynamik, sonst eine Stufe lauter/leiser
              for (let m = k + 1, seen = 0; m < seq.length && seen < 3; m++) {
                if (seq[m].t === 'dyn') { target = seq[m].v; break; }
                if (seq[m].t === 'note') seen++;
              }
            }
            if (target == null) target = Math.max(0.3, Math.min(1.1, level + (e.up ? 0.2 : -0.2)));
            const heads = notes.filter(n => !n.rest);
            heads.forEach((n, idx) => set(n, level + (target - level) * (idx + 1) / heads.length));
            for (const n of notes) if (n.rest) set(n, level);
            level = target;
            i = k < seq.length && seq[k].t === 'dyn' ? k - 1 : k;
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ Akkorde eingeben
  const KIND_OF_SUFFIX = {
    '': 'major', m: 'minor', min: 'minor', '7': 'dominant', maj7: 'major-seventh', M7: 'major-seventh',
    j7: 'major-seventh', 'Δ': 'major-seventh', m7: 'minor-seventh', dim: 'diminished', '°': 'diminished',
    dim7: 'diminished-seventh', '°7': 'diminished-seventh', m7b5: 'half-diminished', 'ø': 'half-diminished',
    aug: 'augmented', '+': 'augmented', sus: 'suspended-fourth', sus4: 'suspended-fourth',
    sus2: 'suspended-second', '6': 'major-sixth', m6: 'minor-sixth', '9': 'dominant-ninth',
    maj9: 'major-ninth', m9: 'minor-ninth', '5': 'power',
  };
  const ACC = { is: 1, isis: 2, es: -1, eses: -2, s: -1, '#': 1, '♯': 1, '##': 2, b: -1, '♭': -1, bb: -2 };

  /** Liest einen Ton am Anfang eines Akkordnamens (deutsch: H, B, Fis, Es; international: B, Bb, F#). */
  function parseChordNote(t, style) {
    const m = /^([A-Ha-h])(isis|eses|is|es|s(?!us)|##|bb|#|♯|b(?!5)|♭)?/.exec(t);
    if (!m) return null;
    const lower = m[1] !== m[1].toUpperCase();
    const letter = m[1].toUpperCase();
    let acc = m[2] || '';
    if (acc === 's' && letter !== 'A' && letter !== 'E') return null;      // nur "As" und "Es"
    let step = letter, alter = 0;
    if (letter === 'H') step = 'B';
    else if (letter === 'B' && style !== 'en') {                            // deutsches B = B♭
      alter = -1;
      if (acc === 'b' || acc === '♭') acc = '';                             // "Bb" meint dasselbe
    }
    alter += ACC[acc] || 0;
    return { step, alter, rest: t.slice(m[0].length), lower };
  }

  /** Akkordname -> {root, suffix, bass}; null = leer, undefined = nicht verstanden. */
  function parseChordText(text, style) {
    let t = String(text || '').trim().replace(/\s+/g, '').replace(/^\((.*)\)$/, '$1');
    if (!t) return null;
    let bass = null;
    const slash = t.indexOf('/');
    if (slash > 0) {
      bass = parseChordNote(t.slice(slash + 1), style);
      if (!bass || bass.rest.replace(/^\d+$/, '') !== '') return undefined;
      t = t.slice(0, slash);
    }
    const root = parseChordNote(t, style);
    if (!root) return undefined;
    let suffix = root.rest.replace(/♯/g, '#').replace(/♭/g, 'b');
    if (root.lower && !/^m(?!aj)/.test(suffix)) suffix = 'm' + suffix;      // kleingeschrieben = Moll
    if (suffix.length > 12 || !/^[0-9a-zA-Z#+°øΔ()]*$/.test(suffix)) return undefined;
    return { root, suffix, bass };
  }

  function harmonyBefore(note) {
    const head = chordGroup(note)[0];
    for (let el = head.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.tagName === 'note' || el.tagName === 'backup' || el.tagName === 'forward') break;
      if (el.tagName === 'harmony') return el;
    }
    return null;
  }
  function harmonyText(note, style) {
    const h = harmonyBefore(note);
    const l = h && chordLabel(h, style);
    return l ? l.root + l.suffix : '';
  }
  function setHarmony(doc, note, text, style) {
    const head = chordGroup(note)[0];
    const parsed = parseChordText(text, style);
    if (parsed === undefined) return false;
    const old = harmonyBefore(head);
    if (!parsed && !old) return false;
    if (old) old.remove();
    if (!parsed) return;
    const h = mk(doc, 'harmony');
    h.setAttribute('placement', 'above');
    const root = h.appendChild(mk(doc, 'root'));
    root.appendChild(mk(doc, 'root-step', parsed.root.step));
    if (parsed.root.alter) root.appendChild(mk(doc, 'root-alter', parsed.root.alter));
    const kind = h.appendChild(mk(doc, 'kind', KIND_OF_SUFFIX[parsed.suffix] || 'other'));
    kind.setAttribute('text', parsed.suffix);
    if (parsed.bass) {
      const b = h.appendChild(mk(doc, 'bass'));
      b.appendChild(mk(doc, 'bass-step', parsed.bass.step));
      if (parsed.bass.alter) b.appendChild(mk(doc, 'bass-alter', parsed.bass.alter));
    }
    h.appendChild(mk(doc, 'staff', kidText(head, 'staff') || '1'));
    head.before(h);
  }

  // ------------------------------------------------------------ Liedtext eingeben
  function lyricOf(note, number) {
    const head = chordGroup(note)[0];
    return kids(head, 'lyric').find(l => (l.getAttribute('number') || '1') === String(number)) || null;
  }
  const continues = l => { const s = l && kidText(l, 'syllabic'); return s === 'begin' || s === 'middle'; };
  function lyricText(note, number) {
    const l = lyricOf(note, number);
    if (!l) return '';
    return (kidText(l, 'text') || '') + (continues(l) ? '-' : '') + (kid(l, 'extend') ? '_' : '');
  }
  /** Alle Noten derselben Stimme (gleiche Zeile und Stimme), in Lesereihenfolge. */
  function voiceHeads(note) {
    const head = chordGroup(note)[0];
    const st = kidText(head, 'staff') || '1', v = kidText(head, 'voice') || '1';
    return Array.from(head.closest('part').querySelectorAll('note')).filter(n =>
      !isChordMember(n) && !isGrace(n) && (kidText(n, 'staff') || '1') === st && (kidText(n, 'voice') || '1') === v);
  }
  function lyricNeighbour(note, number, dir) {
    const list = voiceHeads(note);
    for (let i = list.indexOf(chordGroup(note)[0]) + dir; i >= 0 && i < list.length; i += dir) {
      if (lyricOf(list[i], number)) return list[i];
    }
    return null;
  }
  /** Nächste singbare Note derselben Stimme (keine Pause, kein Haltebogen-Ende). */
  function nextSingable(note, dir = 1) {
    const list = voiceHeads(note);
    for (let i = list.indexOf(chordGroup(note)[0]) + dir; i >= 0 && i < list.length; i += dir) {
      if (!isRest(list[i]) && !hasTie(list[i], 'stop')) return list[i];
    }
    return null;
  }
  function fixFollower(doc, note, number, hyphenBefore) {
    const next = lyricNeighbour(note, number, 1);
    if (!next) return;
    const l = lyricOf(next, number);
    const after = continues(l);
    const syl = hyphenBefore ? (after ? 'middle' : 'end') : (after ? 'begin' : 'single');
    let s = kid(l, 'syllabic');
    if (!s) s = l.insertBefore(mk(doc, 'syllabic'), l.firstChild);
    s.textContent = syl;
  }
  /** Setzt die Silbe einer Note. "schrei-" = getrennt, "Licht_" = Haltelinie, "" = löschen. */
  function setLyric(doc, note, number, raw) {
    const head = chordGroup(note)[0];
    const old = lyricOf(head, number);
    const prev = lyricNeighbour(head, number, -1);
    const cont = continues(prev && lyricOf(prev, number));
    let t = String(raw || '').trim();
    if (!t) {
      if (!old) return false;
      old.remove();
      fixFollower(doc, head, number, cont);
      return;
    }
    const extend = /_+$/.test(t);
    t = t.replace(/_+$/, '');
    const after = /-$/.test(t);
    t = t.replace(/-+$/, '').replace(/^-+/, '');
    if (!t) return false;
    const syl = cont ? (after ? 'middle' : 'end') : (after ? 'begin' : 'single');
    const l = old || insertOrdered(head, mk(doc, 'lyric'), NOTE_ORDER);
    l.setAttribute('number', String(number));
    l.textContent = '';
    l.appendChild(mk(doc, 'syllabic', syl));
    l.appendChild(mk(doc, 'text', t));
    if (extend) l.appendChild(mk(doc, 'extend'));
    fixFollower(doc, head, number, after);
  }

  // ------------------------------------------------------------ Stimmen für das Mischpult
  /** Spuren des Stücks: Sopran/Alt/Tenor/Bass, Klavier rechts/links, Gesang … */
  function tracks(doc) {
    const out = [];
    const parts = Array.from(doc.querySelectorAll('part'));
    const names = new Map(Array.from(doc.querySelectorAll('score-part')).map(sp =>
      [sp.getAttribute('id'), (kidText(sp, 'part-name') || '').trim()]));
    parts.forEach((part, pi) => {
      const id = part.getAttribute('id');
      const name = names.get(id) || `Stimme ${pi + 1}`;
      const combos = new Map();
      for (const n of part.querySelectorAll('note')) {
        if (!kid(n, 'pitch')) continue;
        const st = kidText(n, 'staff') || '1';
        if (!combos.has(st)) combos.set(st, new Set());
        combos.get(st).add(kidText(n, 'voice') || '1');
      }
      const staves = Array.from(combos.keys()).sort();
      if (/klavier|piano|orgel|organ|keyboard|begleitung/i.test(name) || !staves.length) {
        if (staves.length > 1) staves.forEach((st, i) => out.push({ key: `${id}|${st}`, label: `${name} ${i === 0 ? 'rechts' : 'links'}` }));
        else out.push({ key: id, label: name });
        return;
      }
      const list = [];
      for (const st of staves) {
        Array.from(combos.get(st)).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
          .forEach(v => list.push({ st, v }));
      }
      if (list.length === 1) { out.push({ key: id, label: name }); return; }
      let labels;
      if (list.length === 4 && staves.length === 2) labels = ['Sopran', 'Alt', 'Tenor', 'Bass'];
      else if (list.length === 2 && staves.length === 2) labels = ['obere Zeile', 'untere Zeile'];
      else if (list.length === 2) labels = ['Oberstimme', 'Unterstimme'];
      else labels = list.map((_, i) => `Stimme ${i + 1}`);
      const prefix = parts.length > 1 && !(list.length === 4 && staves.length === 2) ? name + ': ' : '';
      list.forEach((x, i) => out.push({ key: `${id}|${x.st}|${x.v}`, label: prefix + labels[i], staff: x.st }));
    });
    return out;
  }

  /** Spuren, zu denen eine Note klingt. Singen Stimmen einer Zeile im Takt unisono
      (nur eine Stimme notiert), gehört die Note zu allen Stimmen dieser Zeile. */
  function trackKeysOf(el, list) {
    const part = el.closest('part').getAttribute('id');
    const st = kidText(el, 'staff') || '1', v = kidText(el, 'voice') || '1';
    const keys = new Set(list.map(t => t.key));
    if (keys.has(`${part}|${st}|${v}`)) {
      const sameStaff = list.filter(t => t.key.startsWith(`${part}|${st}|`));
      const voicesHere = new Set();
      for (const n of el.parentElement.querySelectorAll('note')) {
        if (kid(n, 'pitch') && (kidText(n, 'staff') || '1') === st) voicesHere.add(kidText(n, 'voice') || '1');
      }
      if (voicesHere.size === 1 && sameStaff.length > 1) return sameStaff.map(t => t.key);
      return [`${part}|${st}|${v}`];
    }
    if (keys.has(`${part}|${st}`)) return [`${part}|${st}`];
    return [part];
  }

  // ------------------------------------------------------------ Gabeln bearbeiten
  function wedgeAt(note) {
    const head = chordGroup(note)[0];
    for (let el = head.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.tagName === 'note' || el.tagName === 'backup' || el.tagName === 'forward') break;
      const w = el.tagName === 'direction' && el.querySelector('direction-type > wedge');
      if (w && w.getAttribute('type') !== 'stop') return { dir: el, type: w.getAttribute('type'), number: w.getAttribute('number') || '1' };
    }
    return null;
  }

  function removeWedge(doc, note) {
    const start = wedgeAt(note);
    if (!start) return false;
    const part = start.dir.closest('part');
    const all = Array.from(part.querySelectorAll('direction'));
    const stop = all.slice(all.indexOf(start.dir) + 1).find(d => {
      const w = d.querySelector('direction-type > wedge');
      return w && w.getAttribute('type') === 'stop' && (w.getAttribute('number') || '1') === start.number;
    });
    start.dir.remove();
    if (stop) stop.remove();
  }

  function setWedge(doc, a, b, type) {
    if (a.closest('part') !== b.closest('part')) return false;
    let first = chordGroup(a)[0], last = chordGroup(b);
    if (first.compareDocumentPosition(last[0]) & Node.DOCUMENT_POSITION_PRECEDING) {
      first = chordGroup(b)[0]; last = chordGroup(a);
    }
    removeWedge(doc, first);
    const staff = kidText(first, 'staff') || '1';
    const dir = kind => {
      const d = mk(doc, 'direction');
      d.setAttribute('placement', 'below');
      const w = d.appendChild(mk(doc, 'direction-type')).appendChild(mk(doc, 'wedge'));
      w.setAttribute('type', kind);
      w.setAttribute('number', staff);
      d.appendChild(mk(doc, 'staff', staff));
      return d;
    };
    first.before(dir(type));
    last[last.length - 1].after(dir('stop'));
  }

  return {
    CHORD_STYLES, serializeForDisplay, hasMark, toggleMark, getDynamic, setDynamic, dynamicLevels,
    wedgeAt, removeWedge, setWedge, parseChordText, harmonyText, setHarmony,
    lyricText, setLyric, nextSingable, tracks, trackKeysOf,
    parse, serialize, byId, getPitch, midi, isRest, hasTie, chordGroup, context, mainKey, mainTime,
    transpose, setKey, setTime, badMeasures, describe, keyName, neighbourId,
    movePitch, moveOctave, alterPitch, setStep, setValue, insertAfter, addChordTone,
    toRest, deleteNote, toggleTie,
  };
})();
