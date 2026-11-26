/* Notenscanner - Oberfläche: Laden, Anzeigen, Bearbeiten, Abspielen. */
'use strict';

const $ = id => document.getElementById(id);
const PAGE_W = 840;                 // Bildschirmbreite einer A4-Seite bei 100 %
const STORE_KEY = 'notenscanner.v1';

let tk = null;                      // Verovio
let doc = null;                     // MusicXML-Dokument
let fileName = 'noten';
let selId = null;
const mix = new Map();             // Stimmen-Mischpult: Spur -> { mute, solo, vol }
let quiet = false;                 // beim Wiederherstellen keine Fehlermeldungen zeigen
let wedgePick = null;              // { type, from }: Gabel wird gerade gesetzt, Ende wird angeklickt
let undoStack = [], redoStack = [];
let zoom = 1;
let playData = null;                // { timeline, endMs, baseTempo, startOf }
let playRaf = 0, tlIdx = 0;
let currentJob = null;
const player = new Player();

// ------------------------------------------------------------------ Start

// Die Notensatz-Bibliothek (WebAssembly) braucht einen Moment; wir warten, bis sie bereit ist.
const verovioStart = Date.now();
(function initVerovio() {
  let t;
  try { t = new verovio.toolkit(); t.getVersion(); }
  catch (e) {
    if (typeof verovio === 'undefined' || Date.now() - verovioStart > 30000) {
      notify('Die Notenanzeige konnte nicht geladen werden.\n\n'
        +'Bitte die App beenden (schwarzes Fenster schließen) und „Notenscanner starten.bat“ erneut öffnen – '
        + 'dabei wird die fehlende Datei automatisch nachgeladen (Internet nötig).');
      return;
    }
    setTimeout(initVerovio, 60);
    return;
  }
  tk = t;
  tk.setOptions({
    pageWidth: 2100, pageHeight: 2970, scale: 100,
    pageMarginTop: 120, pageMarginBottom: 120, pageMarginLeft: 120, pageMarginRight: 120,
    svgViewBox: true, breaks: 'auto', footer: 'none', header: 'auto',
    spacingSystem: 14, justifyVertically: false,
  });
  restore();
})();

function restore() {
  quiet = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.xml && !loadXml(saved.xml, saved.name || 'noten', true)) {
      localStorage.removeItem(STORE_KEY);    // nicht darstellbarer alter Stand: verwerfen
    }
  } catch (e) { /* kein gespeicherter Stand */ }
  quiet = false;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ xml: MX.serialize(doc), name: fileName })); }
  catch (e) { /* Speicher voll - nicht schlimm */ }
}

let chordStyle = 'de';
try { chordStyle = localStorage.getItem('notenscanner.chords') || 'de'; } catch (e) { /* egal */ }
(function fillChordStyles() {
  const sel = $('chordStyle');
  for (const [value, label] of Object.entries(MX.CHORD_STYLES)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = 'Akkorde: ' + label;
    sel.appendChild(o);
  }
  if (!MX.CHORD_STYLES[chordStyle]) chordStyle = 'de';
  sel.value = chordStyle;
  sel.onchange = () => {
    chordStyle = sel.value;
    try { localStorage.setItem('notenscanner.chords', chordStyle); } catch (e) { /* egal */ }
    sel.blur();
    if (doc) { stopPlay(); render(); }
  };
})();

function fillKeySelect() {
  for (let f = -7; f <= 7; f++) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = 'Vorzeichnung korrigieren: ' + MX.keyName(f);
    $('keySel').appendChild(o);
    const t = document.createElement('option');
    t.value = f;
    t.textContent = MX.keyName(f);
    $('toKey').appendChild(t);
  }
}
fillKeySelect();

// ------------------------------------------------------------------ Laden

function loadXml(xml, name, keepZoom) {
  let parsed;
  try { parsed = MX.parse(xml); }
  catch (e) { notify(e.message); return false; }
  stopPlay();
  doc = parsed;
  fileName = name.replace(/\.[^.]+$/, '') || 'noten';
  document.title = fileName + ' – Notenscanner';
  undoStack = []; redoStack = []; selId = null; playData = null;
  $('welcome').hidden = true;
  if (!keepZoom) {
    const avail = $('scorePane').clientWidth - 40;
    zoom = Math.max(0.5, Math.min(1, Math.floor(avail / PAGE_W * 10) / 10));
  }
  if (!render()) { doc = null; $('welcome').hidden = false; return false; }
  save();
  preparePlayback();
  $('bpm').value = Math.round(playData.baseTempo);
  buildMixer();
  updateUi();
  return true;
}

async function openFiles(fileList) {
  const files = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
  if (!files.length) return;
  if (!tk) { notify('Die Notenanzeige wird noch geladen – bitte kurz warten.'); return; }
  const isScan = !/\.(xml|musicxml|mxl)$/i.test(files[0].name);
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);

  showOverlay(isScan ? 'Noten werden erkannt …' : 'Datei wird geladen …', 'Datei wird übertragen …');
  try {
    const res = await fetch('/api/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    let xml = data.xml;
    let previews = null;
    if (!xml) {
      const done = await waitForJob(data.job, data.pages);
      if (!done) return;                          // abgebrochen
      xml = done.xml;
      previews = done.previews;
    }
    showOriginal(isScan ? files : null, previews);
    if (!loadXml(xml, files[0].name)) showOriginal(null);
  } catch (e) {
    notify(e.message || String(e));
  } finally {
    currentJob = null;
    $('overlay').hidden = true;
  }
}

function showOverlay(title, msg) {
  $('ovTitle').textContent = title;
  $('ovMsg').textContent = msg;
  $('ovBar').style.width = '0';
  $('ovTime').textContent = '';
  $('overlay').hidden = false;
}

async function waitForJob(job, pages) {
  currentJob = job;
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    if (currentJob !== job) return null;
    const res = await fetch('/api/job/' + job);
    const st = await res.json();
    if (currentJob !== job) return null;
    if (st.status === 'done') return st;
    if (st.status === 'error' || st.error) throw new Error(st.error || 'Unbekannter Fehler.');
    $('ovMsg').textContent = st.message;
    $('ovBar').style.width = Math.min(96, (st.done + 0.15) / Math.max(1, pages) * 100) + '%';
    const m = Math.floor(st.elapsed / 60), s = String(st.elapsed % 60).padStart(2, '0');
    $('ovTime').textContent = `Laufzeit ${m}:${s} – je nach Seite und Rechner dauert das einige Sekunden bis wenige Minuten.`;
  }
}

$('ovCancel').onclick = () => {
  if (currentJob) fetch(`/api/job/${currentJob}/cancel`, { method: 'POST' });
  currentJob = null;
  $('overlay').hidden = true;
};

function showOriginal(files, previews) {
  const pane = $('origPane');
  for (const el of pane.querySelectorAll('[src^="blob:"]')) URL.revokeObjectURL(el.src);
  pane.textContent = '';
  if (!files) { pane.hidden = true; $('btnOriginal').disabled = true; $('btnOriginal').classList.remove('on'); return; }
  files.forEach((f, i) => {
    const pages = previews && previews[i];
    if (pages && pages.length) {
      pages.forEach((src, p) => {
        const img = document.createElement('img');
        img.src = src; img.alt = `Original: ${f.name}, Seite ${p + 1}`;
        pane.appendChild(img);
      });
      return;
    }
    const url = URL.createObjectURL(f);
    if (/\.pdf$/i.test(f.name)) {
      const e = document.createElement('embed');
      e.type = 'application/pdf'; e.src = url;
      pane.appendChild(e);
    } else {
      const img = document.createElement('img');
      img.src = url; img.alt = 'Original: ' + f.name;
      pane.appendChild(img);
    }
  });
  pane.hidden = false;
  $('btnOriginal').disabled = false;
  $('btnOriginal').classList.add('on');
}
$('btnOriginal').onclick = () => {
  $('origPane').hidden = !$('origPane').hidden;
  $('btnOriginal').classList.toggle('on', !$('origPane').hidden);
};

// ------------------------------------------------------------------ Anzeige

function render() {
  const pagesEl = $('pages');
  let ok = false;
  try { ok = tk.loadData(MX.serializeForDisplay(doc, chordStyle)); } catch (e) { ok = false; }
  if (!ok) { notify('Die Noten konnten nicht dargestellt werden.'); return false; }
  const n = tk.getPageCount();
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= n; i++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.innerHTML = tk.renderToSVG(i);
    frag.appendChild(div);
  }
  pagesEl.replaceChildren(frag);
  applyZoom();
  markBadMeasures();
  applySelection();
  return true;
}

function applyZoom() {
  for (const p of document.querySelectorAll('.page')) p.style.width = Math.round(PAGE_W * zoom) + 'px';
  $('zoomLabel').textContent = Math.round(zoom * 100) + ' %';
}

function markBadMeasures() {
  const seen = new Set();
  for (const id of MX.badMeasures(doc)) {
    const el = document.getElementById(id);
    const g = el && el.closest('g.measure');
    if (!g || seen.has(g)) continue;
    seen.add(g);
    const b = g.getBBox();
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('class', 'badmeasure');
    r.setAttribute('x', b.x); r.setAttribute('y', b.y - 60);
    r.setAttribute('width', b.width); r.setAttribute('height', b.height + 120);
    r.setAttribute('rx', 40);
    g.insertBefore(r, g.firstChild);
  }
}

function applySelection() {
  for (const el of document.querySelectorAll('#pages .sel')) el.classList.remove('sel');
  const el = selId && document.getElementById(selId);
  if (el) el.classList.add('sel');
}

function select(id, scroll) {
  selId = id || null;
  applySelection();
  updateUi();
  const el = selId && document.getElementById(selId);
  if (el && scroll) keepVisible(el);
}

function keepVisible(el) {
  const pane = $('scorePane').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < pane.top + 30 || r.bottom > pane.bottom - 30) {
    $('scorePane').scrollBy({ top: r.top - pane.top - pane.height / 2, behavior: 'smooth' });
  }
}

function updateUi() {
  const has = !!doc;
  const note = has && selId ? MX.byId(doc, selId) : null;
  for (const id of ['btnExport', 'btnPlay', 'btnTrDown', 'btnTrUp']) $(id).disabled = !has;
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
  for (const b of document.querySelectorAll('#editRow button')) b.disabled = !note;
  $('dynSel').disabled = !note;
  $('chordIn').disabled = $('lyricIn').disabled = !note;
  if (document.activeElement !== $('chordIn')) $('chordIn').value = note ? MX.harmonyText(note, chordStyle) : '';
  if (document.activeElement !== $('lyricIn')) $('lyricIn').value = note ? MX.lyricText(note, verse()) : '';
  $('btnMix').disabled = !has;
  for (const b of document.querySelectorAll('#editRow [data-mark]')) b.classList.toggle('on', !!note && MX.hasMark(note, b.dataset.mark));
  const wedge = note && MX.wedgeAt(note);
  for (const b of document.querySelectorAll('#editRow [data-wedge]')) {
    b.classList.toggle('on', (!!wedge && wedge.type === b.dataset.wedge) || (!!wedgePick && wedgePick.type === b.dataset.wedge));
  }
  $('dynSel').value = note ? MX.getDynamic(note) : '';
  if ($('dynSel').selectedIndex < 0) $('dynSel').value = '';
  $('keySel').disabled = $('timeSel').disabled = $('toKey').disabled = !has;
  $('toKey').value = '';
  if (has) for (const o of $('toKey').options) if (o.value !== '') {
    o.textContent = MX.keyName(+o.value) + (+o.value === MX.mainKey(doc) ? '  ← aktuell' : '');
  }
  if (has) {
    $('keySel').value = Math.max(-7, Math.min(7, MX.mainKey(doc)));
    const t = MX.mainTime(doc);
    $('timeSel').value = Array.from($('timeSel').options).some(o => o.value === t) ? t : '';
  }
  const st = $('statusSel');
  if (!has) { st.textContent = 'Keine Noten geladen.'; return; }
  if (!note) { st.textContent = 'Note oder Pause anklicken, um sie zu bearbeiten.  ? zeigt alle Tastenkürzel.'; return; }
  const d = MX.describe(doc, note);
  st.innerHTML = '<b>' + d.parts.map(esc).join(' · ') + '</b>';
  if (d.fill) {
    const txt = ` — Takt enthält ${String(d.fill.beats).replace('.', ',')} von ${d.fill.expected} Schlägen (${d.fill.expected}/${d.fill.beatType})`;
    st.innerHTML += d.fill.ok ? esc(txt) : `<span class="warn">${esc(txt)}</span>`;
  }
}
function notify(text) {
  if (quiet) return;
  $('msgText').textContent = text;
  $('msg').hidden = false;
  $('msgClose').focus();
}
$('msgClose').onclick = () => { $('msg').hidden = true; };
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function flash(msg) {
  $('statusMsg').textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { $('statusMsg').textContent = ''; }, 5000);
}

// ------------------------------------------------------------------ Bearbeiten

function edit(fn, opts = {}) {
  if (!doc) return;
  const note = selId ? MX.byId(doc, selId) : null;
  if (!opts.global && !note) return;
  const before = { xml: MX.serialize(doc), sel: selId };
  let result;
  try { result = fn(note); }
  catch (e) { console.error(e); doc = MX.parse(before.xml); flash('Diese Änderung war hier nicht möglich.'); return; }
  if (result === false) return;
  undoStack.push(before);
  if (undoStack.length > 150) undoStack.shift();
  redoStack = [];
  if (typeof result === 'string') selId = result || null;
  changed();
  if (opts.sound) {
    const n = selId && MX.byId(doc, selId);
    const p = n && MX.getPitch(n);
    if (p && p.step >= 0) player.blip(MX.midi(p));
  }
}

function changed() {
  stopPlay();
  playData = null;
  render();
  save();
  buildMixer();
  updateUi();
}

// ------------------------------------------------------------------ Akkord- und Liedtext-Eingabe

function verse() { return parseInt($('verseSel').value, 10) || 1; }

function commitChord() {
  const n = selId && MX.byId(doc, selId);
  if (!n) return;
  const v = $('chordIn').value;
  if (v.trim() && MX.parseChordText(v, chordStyle) === undefined) {
    flash(`„${v}“ wurde nicht als Akkord erkannt. Beispiele: Am, Fis7, Hm, B, Esmaj7, D/Fis`);
    return;
  }
  edit(x => MX.setHarmony(doc, x, v, chordStyle));
}

function commitLyric(move) {
  const n = selId && MX.byId(doc, selId);
  if (!n) return;
  const v = $('lyricIn').value;
  if (v !== MX.lyricText(n, verse())) edit(x => MX.setLyric(doc, x, verse(), v));
  if (!move) return;
  const cur = MX.byId(doc, selId);
  const next = cur && MX.nextSingable(cur, move);
  if (next) {
    select(next.getAttribute('id'), true);
    $('lyricIn').value = MX.lyricText(next, verse());
    $('lyricIn').select();
  }
}

$('chordIn').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitChord(); $('chordIn').select(); }
  else if (e.key === 'Escape') { e.stopPropagation(); updateUiFields(); $('chordIn').blur(); }
});
$('lyricIn').addEventListener('keydown', e => {
  if (e.key === 'Enter' || (e.key === ' ' && !e.shiftKey)) {
    e.preventDefault(); e.stopPropagation();
    commitLyric(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') { e.stopPropagation(); updateUiFields(); $('lyricIn').blur(); }
});
$('verseSel').onchange = () => { $('verseSel').blur(); updateUi(); };
function updateUiFields() {
  const n = selId && MX.byId(doc, selId);
  $('chordIn').value = n ? MX.harmonyText(n, chordStyle) : '';
  $('lyricIn').value = n ? MX.lyricText(n, verse()) : '';
}

// ------------------------------------------------------------------ Stimmen-Mischpult

player.trackGain = keys => {
  if (!keys || !keys.length) return 1;
  const anySolo = Array.from(mix.values()).some(m => m.solo);
  let best = 0;
  for (const k of keys) {
    const m = mix.get(k) || { mute: false, solo: false, vol: 1 };
    const g = m.mute || (anySolo && !m.solo) ? 0 : m.vol;
    if (g > best) best = g;
  }
  return best;
};

function buildMixer() {
  const menu = $('mixMenu');
  menu.textContent = '';
  if (!doc) return;
  const list = MX.tracks(doc);
  for (const t of list) if (!mix.has(t.key)) mix.set(t.key, { mute: false, solo: false, vol: 1 });
  for (const t of list) {
    const m = mix.get(t.key);
    const row = document.createElement('div');
    row.className = 'mixrow';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.label;
    const mute = document.createElement('button');
    mute.className = 'mute';
    mute.textContent = 'Stumm';
    mute.title = 'Diese Stimme nicht abspielen';
    const solo = document.createElement('button');
    solo.textContent = 'Solo';
    solo.title = 'Nur diese Stimme(n) abspielen';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '1.6'; vol.step = '0.05'; vol.value = String(m.vol);
    vol.title = 'Lautstärke dieser Stimme';
    const refresh = () => {
      mute.classList.toggle('on', m.mute);
      solo.classList.toggle('on', m.solo);
      const anySolo = Array.from(mix.values()).some(x => x.solo);
      row.classList.toggle('silent', m.mute || (anySolo && !m.solo) || m.vol === 0);
    };
    mute.onclick = () => { m.mute = !m.mute; refreshMixer(); };
    solo.onclick = () => { m.solo = !m.solo; refreshMixer(); };
    vol.oninput = () => { m.vol = parseFloat(vol.value); refresh(); };
    row._refresh = refresh;
    row.append(name, mute, solo, vol);
    menu.appendChild(row);
  }
  const foot = document.createElement('div');
  foot.className = 'mixfoot';
  const reset = document.createElement('button');
  reset.textContent = 'Alle wieder an';
  reset.onclick = () => { for (const m of mix.values()) { m.mute = false; m.solo = false; m.vol = 1; } buildMixer(); };
  foot.appendChild(reset);
  menu.appendChild(foot);
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Änderungen wirken sofort, auch während des Abspielens.';
  menu.appendChild(hint);
  refreshMixer();
}
function refreshMixer() {
  for (const row of $('mixMenu').querySelectorAll('.mixrow')) row._refresh();
  const active = Array.from(mix.values()).some(m => m.mute || m.solo || m.vol !== 1);
  $('btnMix').classList.toggle('on', active);
}
$('btnMix').onclick = e => { e.stopPropagation(); $('mixWrap').classList.toggle('open'); };
$('mixMenu').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => $('mixWrap').classList.remove('open'));

function undo() { stepHistory(undoStack, redoStack); }
function redo() { stepHistory(redoStack, undoStack); }
function stepHistory(from, to) {
  if (!from.length) return;
  to.push({ xml: MX.serialize(doc), sel: selId });
  const s = from.pop();
  doc = MX.parse(s.xml);
  selId = s.sel;
  changed();
}

const ACTIONS = {
  up: () => edit(n => MX.movePitch(doc, n, 1), { sound: true }),
  down: () => edit(n => MX.movePitch(doc, n, -1), { sound: true }),
  octUp: () => edit(n => MX.moveOctave(doc, n, 1), { sound: true }),
  octDown: () => edit(n => MX.moveOctave(doc, n, -1), { sound: true }),
  sharp: () => edit(n => MX.alterPitch(doc, n, 1), { sound: true }),
  flat: () => edit(n => MX.alterPitch(doc, n, -1), { sound: true }),
  natural: () => edit(n => MX.alterPitch(doc, n, 0), { sound: true }),
  dot: () => edit(n => MX.setValue(doc, n, null, true)),
  insert: () => edit(n => MX.insertAfter(doc, n), { sound: true }),
  chord: () => edit(n => MX.addChordTone(doc, n), { sound: true }),
  rest: () => edit(n => MX.toRest(doc, n)),
  tie: () => edit(n => {
    const r = MX.toggleTie(doc, n);
    if (r === false) flash('Für einen Haltebogen muss die nächste Note dieselbe Tonhöhe haben.');
    return r;
  }),
  delete: () => edit(n => MX.deleteNote(doc, n, false)),
  deleteHard: () => edit(n => MX.deleteNote(doc, n, true)),
};

$('editRow').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.dur) edit(n => MX.setValue(doc, n, b.dataset.dur, false));
  else if (b.dataset.mark) edit(n => MX.toggleMark(doc, n, b.dataset.mark));
  else if (b.dataset.wedge) {
    const n = MX.byId(doc, selId);
    const w = n && MX.wedgeAt(n);
    if (w && w.type === b.dataset.wedge) { edit(x => MX.removeWedge(doc, x)); return; }
    wedgePick = { type: b.dataset.wedge, from: selId };
    flash('Jetzt die letzte Note der Gabel anklicken (Esc bricht ab).');
    updateUi();
  }
  else if (ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act]();
});

$('keySel').onchange = e => {
  const f = parseInt(e.target.value, 10);
  edit(() => MX.setKey(doc, f), { global: true });
  e.target.blur();
  flash('Nur die Vorzeichnung wurde geändert, die Noten bleiben auf ihren Linien. '
    + 'Zum Transponieren „Transponieren“ oben verwenden. (Strg+Z macht es rückgängig.)');
};
$('toKey').onchange = e => {
  const v = e.target.value;
  e.target.blur();
  if (v === '') return;
  let key;
  edit(() => { key = MX.transposeToKey(doc, parseInt(v, 10)); }, { global: true });
  if (key != null) flash('Transponiert. Neue Tonart: ' + MX.keyName(key));
};
$('timeSel').onchange = e => {
  const m = /^(\d+)\/(\d+)$/.exec(e.target.value);
  if (m) edit(() => MX.setTime(doc, +m[1], +m[2]), { global: true });
  e.target.blur();
};
$('dynSel').onchange = e => {
  const v = e.target.value;
  edit(n => MX.setDynamic(doc, n, v === '-' ? '' : v));
  e.target.blur();
};
$('chkBad').onchange = e => document.body.classList.toggle('nobad', !e.target.checked);

function transposeBy(dir) {
  const semis = dir * parseInt($('interval').value, 10);
  let key;
  edit(() => { key = MX.transpose(doc, semis); }, { global: true });
  if (key != null) flash('Transponiert. Neue Tonart: ' + MX.keyName(key));
}
$('btnTrUp').onclick = () => transposeBy(1);
$('btnTrDown').onclick = () => transposeBy(-1);
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;

// ------------------------------------------------------------------ Auswahl per Maus

$('pages').addEventListener('click', e => {
  const g = e.target.closest('g.note, g.rest');
  if (wedgePick) {
    const pick = wedgePick;
    wedgePick = null;
    const from = MX.byId(doc, pick.from), to = g && MX.byId(doc, g.id);
    if (from && to) {
      edit(() => {
        const r = MX.setWedge(doc, from, to, pick.type);
        if (r === false) flash('Anfang und Ende einer Gabel müssen in derselben Stimme liegen.');
        return r;
      });
      return;
    }
    flash('Gabel abgebrochen.');
  }
  select(g && doc && MX.byId(doc, g.id) ? g.id : null);
});

// ------------------------------------------------------------------ Wiedergabe

function preparePlayback() {
  if (playData) return playData;
  tk.renderToMIDI();
  let tm;
  try { tm = tk.renderToTimemap({ includeRests: true }); } catch (e) { tm = tk.renderToTimemap(); }
  const levels = MX.dynamicLevels(doc);
  const trackList = MX.tracks(doc);
  const notes = [], open = new Map(), lastByPitch = new Map(), startOf = new Map();
  const fermataOn = new Map();          // id -> Beginn einer Note/Pause mit Fermate
  const holds = new Map();              // Ende einer Fermate (ms) -> Verlängerung (ms)
  let baseTempo = 0, endMs = 0;
  for (const e of tm) {
    if (e.tempo && !baseTempo) baseTempo = e.tempo;
    for (const id of e.off || []) {
      const n = open.get(id);
      if (n) { n.off = e.tstamp; open.delete(id); }
      if (fermataOn.has(id)) {
        const extra = Math.min(4000, e.tstamp - fermataOn.get(id));   // Fermate: etwa doppelt so lang
        holds.set(e.tstamp, Math.max(holds.get(e.tstamp) || 0, extra));
        fermataOn.delete(id);
      }
      if (e.tstamp > endMs) endMs = e.tstamp;
    }
    for (const id of e.on || []) {
      startOf.set(id, e.tstamp);
      const el = MX.byId(doc, id);
      if (!el) continue;
      if (MX.hasMark(el, 'fermata')) fermataOn.set(id, e.tstamp);
      const p = MX.getPitch(el);
      if (!p || p.step < 0) continue;
      const pitch = MX.midi(p);
      const prev = lastByPitch.get(pitch);
      if (MX.hasTie(el, 'stop') && prev && Math.abs((prev.off ?? e.tstamp) - e.tstamp) < 2) {
        prev.off = null;                 // übergebundene Note: Klang einfach verlängern
        open.set(id, prev);
        continue;
      }
      let gain = levels.get(id) ?? 0.76;
      if (MX.hasMark(el, 'accent')) gain *= 1.25;
      if (MX.hasMark(el, 'strong-accent')) gain *= 1.4;
      let short = 1;
      if (MX.hasMark(el, 'staccato')) short = 0.5;
      if (MX.hasMark(el, 'staccatissimo')) short = 0.3;
      const n = { pitch, on: e.tstamp, off: null, gain, short, tracks: MX.trackKeysOf(el, trackList) };
      notes.push(n); open.set(id, n); lastByPitch.set(pitch, n);
    }
  }
  for (const n of notes) {
    if (n.off == null) n.off = Math.max(n.on + 300, endMs);
    if (n.short < 1) n.off = n.on + (n.off - n.on) * n.short;
  }
  // Fermaten: alles, was danach kommt, rückt um die Haltezeit nach hinten
  const pts = Array.from(holds.entries()).sort((a, b) => a[0] - b[0]);
  const warp = t => { let add = 0; for (const [at, extra] of pts) { if (t >= at - 1) add += extra; else break; } return t + add; };
  if (pts.length) {
    for (const n of notes) { n.on = warp(n.on); n.off = warp(n.off); }
    tm = tm.map(e => Object.assign({}, e, { tstamp: warp(e.tstamp) }));
    for (const [id, t] of startOf) startOf.set(id, warp(t));
    endMs = warp(endMs);
  }
  notes.sort((a, b) => a.on - b.on);
  player.notes = notes;
  playData = { timeline: tm, endMs, baseTempo: baseTempo || 120, startOf };
  return playData;
}

function currentRate() {
  const bpm = Math.max(20, Math.min(300, parseFloat($('bpm').value) || playData.baseTempo));
  return bpm / playData.baseTempo;
}

function startPlay(fromMs) {
  if (!doc) return;
  preparePlayback();
  if (fromMs == null) fromMs = selId && playData.startOf.has(selId) ? playData.startOf.get(selId) : 0;
  if (fromMs >= playData.endMs) fromMs = 0;
  player.rate = currentRate();
  player.instrument = $('instrument').value;
  clearPlaying();
  tlIdx = playData.timeline.findIndex(e => e.tstamp >= fromMs - 0.5);
  if (tlIdx < 0) tlIdx = playData.timeline.length;
  player.play(fromMs, playData.endMs, stopPlay);
  $('btnPlay').textContent = '■ Stopp';
  $('btnPlay').classList.add('on');
  const loop = () => {
    if (!player.playing) return;
    const now = player.now(), tl = playData.timeline;
    let first = null;
    while (tlIdx < tl.length && tl[tlIdx].tstamp <= now) {
      const e = tl[tlIdx++];
      for (const id of e.off || []) { const el = document.getElementById(id); if (el) el.classList.remove('playing'); }
      for (const id of e.on || []) {
        const el = document.getElementById(id);
        if (el) { el.classList.add('playing'); first = first || el; }
      }
    }
    if (first) keepVisible(first);
  };
  clearInterval(playRaf);
  playRaf = setInterval(loop, 33);
  loop();
}

function clearPlaying() {
  for (const el of document.querySelectorAll('#pages .playing')) el.classList.remove('playing');
}
function stopPlay() {
  clearInterval(playRaf);
  if (player.playing) player.stop();
  clearPlaying();
  $('btnPlay').textContent = '▶ Abspielen';
  $('btnPlay').classList.remove('on');
}
function togglePlay() { if (player.playing) stopPlay(); else startPlay(); }

$('btnPlay').onclick = togglePlay;
$('bpm').onchange = () => { if (player.playing) startPlay(player.now()); };
$('instrument').onchange = e => { if (player.playing) startPlay(player.now()); e.target.blur(); };
$('interval').onchange = e => e.target.blur();

// ------------------------------------------------------------------ Speichern / Export

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('btnExport').onclick = e => { e.stopPropagation(); $('btnExport').parentElement.classList.toggle('open'); };
document.addEventListener('click', () => $('btnExport').parentElement.classList.remove('open'));
$('exportMenu').addEventListener('click', e => {
  const kind = e.target.dataset.export;
  if (!kind || !doc) return;
  if (kind === 'musicxml') {
    download(fileName + '.musicxml', new Blob([MX.serialize(doc, true)], { type: 'application/vnd.recordare.musicxml+xml' }));
  } else if (kind === 'midi') {
    const bin = atob(tk.renderToMIDI());
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    download(fileName + '.mid', new Blob([bytes], { type: 'audio/midi' }));
  } else if (kind === 'print') {
    stopPlay();
    window.print();
  }
});

// ------------------------------------------------------------------ Öffnen, Ziehen, Zoom, Hilfe

$('btnOpen').onclick = $('btnOpen2').onclick = () => $('file').click();
$('file').onchange = e => { openFiles(e.target.files); e.target.value = ''; };

let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

function setZoom(z) { zoom = Math.max(0.4, Math.min(2.5, Math.round(z * 10) / 10)); applyZoom(); }
$('btnZoomIn').onclick = () => setZoom(zoom + 0.1);
$('btnZoomOut').onclick = () => setZoom(zoom - 0.1);

$('btnHelp').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').addEventListener('click', e => { if (e.target === $('help')) $('help').hidden = true; });

$('lnkDemo').onclick = e => { e.preventDefault(); if (tk) { showOriginal(null); loadXml(demoXml(), 'Beispiel'); } };

function demoXml() {
  // "Alle meine Entchen" (Volkslied)
  const tune = 'C4q D4q E4q F4q|G4h G4h|A4q A4q A4q A4q|G4w|A4q A4q A4q A4q|G4w|F4q F4q F4q F4q|E4h E4h|G4q G4q G4q G4q|C4w';
  const dur = { q: [1, 'quarter'], h: [2, 'half'], w: [4, 'whole'] };
  const measures = tune.split('|').map((m, i) => {
    const notes = m.split(' ').map(t => {
      const [d, type] = dur[t[2]];
      return `<note><pitch><step>${t[0]}</step><octave>${t[1]}</octave></pitch><duration>${d}</duration><voice>1</voice><type>${type}</type></note>`;
    }).join('');
    const attrs = i === 0
      ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type><sound tempo="100"/></direction>'
      : '';
    return `<measure number="${i + 1}">${attrs}${notes}</measure>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>Alle meine Entchen</work-title></work>'
    + '<part-list><score-part id="P1"><part-name></part-name></score-part></part-list>'
    + `<part id="P1">${measures}</part></score-partwise>`;
}

// ------------------------------------------------------------------ Tastatur

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (!$('msg').hidden) { if (e.key === 'Escape') $('msg').hidden = true; return; }
  if (!$('help').hidden) { if (e.key === 'Escape') $('help').hidden = true; return; }
  if (!$('overlay').hidden) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); $('file').click(); return; }
  if (tag === 'INPUT' && e.target.type !== 'checkbox' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
    return;
  }
  if (!doc) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  let handled = true;

  if (ctrl && k === 'z') (e.shiftKey ? redo : undo)();
  else if (ctrl && k === 'y') redo();
  else if (ctrl && k === 's') $('exportMenu').querySelector('[data-export=musicxml]').click();
  else if (ctrl && k === 'p') $('exportMenu').querySelector('[data-export=print]').click();
  else if (k === ' ') togglePlay();
  else if (k === 'Escape') {
    if (wedgePick) { wedgePick = null; flash('Gabel abgebrochen.'); updateUi(); }
    else if (player.playing) stopPlay(); else select(null);
  }
  else if (k === '?') $('help').hidden = false;
  else if (!selId) handled = false;
  else if (k === 'ArrowUp') (ctrl ? ACTIONS.octUp : ACTIONS.up)();
  else if (k === 'ArrowDown') (ctrl ? ACTIONS.octDown : ACTIONS.down)();
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    const n = MX.byId(doc, selId);
    const id = n && MX.neighbourId(n, k === 'ArrowLeft' ? -1 : 1);
    if (id) select(id, true);
  }
  else if (ctrl || e.altKey) handled = false;
  else if (k === '+') ACTIONS.sharp();
  else if (k === '-') ACTIONS.flat();
  else if (k === '0') ACTIONS.natural();
  else if (k >= '1' && k <= '6') {
    const type = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'][+k - 1];
    edit(n => MX.setValue(doc, n, type, false));
  }
  else if (k === '.') ACTIONS.dot();
  else if ('cdefgah'.includes(k)) edit(n => MX.setStep(doc, n, 'cdefgah'.indexOf(k)), { sound: true });
  else if (k === 'b') edit(n => MX.setStep(doc, n, 6, -1), { sound: true });
  else if (k === 'n' || k === 'Insert') ACTIONS.insert();
  else if (k === 'k') ACTIONS.chord();
  else if (k === 'p') ACTIONS.rest();
  else if (k === 't') ACTIONS.tie();
  else if (k === 'Delete' || k === 'Backspace') (e.shiftKey ? ACTIONS.deleteHard : ACTIONS.delete)();
  else handled = false;

  if (handled) e.preventDefault();
});

updateUi();
