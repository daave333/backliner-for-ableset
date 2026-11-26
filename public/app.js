// Backliner for AbleSet – iPad-Oberfläche
'use strict';

// ---------- Zustand ----------
let S = { live: { connected: false, setlist: [], activeIndex: -1, remaining: null, playing: false, changed: [], descriptions: [], part: '', notesBefore: [], notesAfter: [], sections: [], sectionIndex: -1, nextSectionIndex: -1, sectionRemaining: null }, data: null, meta: {} };
let tab = 'live';
let editSongs = [];           // Songliste, die der Editor gerade zeigt (Index → Name)

// Persönliche Einstellungen: liegen nur auf diesem iPad
const DEFAULTS = { musicians: [], prepSongs: 1, goSeconds: 30, size: 'm', orient: 'landscape', view: 'list', returnSec: 5 };
let me;
try { me = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('backliner') || '{}')); } catch { me = { ...DEFAULTS }; }
function saveMe() {
  try { localStorage.setItem('backliner', JSON.stringify(me)); } catch {}
  applyLook(); renderLive();
}

// ---------- Hilfen ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const P = () => S.data.productions[S.data.activeProduction];
const fmt = s => (s == null || isNaN(s)) ? '–:––' : `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const TUNINGS = ['Standard', 'Eb Standard', 'D Standard', 'Drop D', 'Drop C#', 'Drop C', 'DADGAD', 'Open G', 'Open D', 'Open E', 'B Standard'];

function songData(name) {
  const songs = P().songs;
  if (!songs[name]) songs[name] = { assign: {}, override: {} };
  songs[name].assign ||= {};
  songs[name].override ||= {};
  return songs[name];
}
function assignOf(song, mid) { return (song != null && P().songs[song]?.assign?.[mid]) || {}; }
function ensureAssign(song, mid) {
  const a = songData(song).assign;
  if (!a[mid]) a[mid] = { notes: [] };
  a[mid].notes ||= [];
  a[mid].changes ||= [];
  return a[mid];
}
const instOf = (m, id) => id ? m.instruments.find(i => i.id === id) : null;
const norm = v => String(v ?? '').trim();
// Leeres Tuning heißt Standard – „Standard“ und „“ sind also kein Wechsel
const normTuning = v => norm(v).toLowerCase() || 'standard';
function isChange(a, b) {
  return norm(a.inst) !== norm(b.inst) || normTuning(a.tuning) !== normTuning(b.tuning) || norm(a.capo) !== norm(b.capo);
}

// ---------- Wechsel innerhalb eines Songs (an AbleSet-Abschnitten) ----------
// Ablauf eines Musikers in einem Song: Ausstattung zu Songbeginn, dann Wechsel ab Abschnitt „at“
function segmentsOf(song, mid) {
  const a = assignOf(song, mid);
  const chg = (a.changes || []).filter(c => c && Number.isFinite(+c.at) && +c.at > 0).sort((x, y) => x.at - y.at);
  return [a, ...chg];
}
const startOf = (song, mid) => assignOf(song, mid);
const endOf = (song, mid) => { const s = segmentsOf(song, mid); return s[s.length - 1]; };
// Abschnitte eines Songs: beim aktuellen Song live von AbleSet, sonst das Gelernte
function sectionsFor(song) {
  if (song != null && song === S.live.setlist?.[S.live.activeIndex] && S.live.sections?.length) return S.live.sections;
  return (S.meta && S.meta[song]?.sections) || [];
}
const secName = (song, c) => norm(sectionsFor(song)[c.at]) || norm(c.name) || `Abschnitt ${+c.at + 1}`;
// Ausstattung gerade jetzt (beim aktuellen Song abhängig vom Abschnitt)
function nowOf(song, mid) {
  const segs = segmentsOf(song, mid);
  if (song !== S.live.setlist?.[S.live.activeIndex]) return segs[0];
  const si = S.live.sectionIndex ?? -1;
  return segs.filter((c, i) => i === 0 || c.at <= si).pop();
}
// Status eines Wechsels im Song: done | go | prep | '' (j = Position des Songs in der Setlist)
function inSongState(j, song, c) {
  const { activeIndex, sectionIndex, nextSectionIndex, sectionRemaining } = S.live;
  if (j < activeIndex) return 'done';
  if (j > activeIndex) return '';
  if (c.at <= sectionIndex) return 'done';
  if (c.at === nextSectionIndex && sectionRemaining != null && sectionRemaining <= timing(song).go) return 'go';
  return 'prep';
}
// Noch ausstehende Wechsel im aktuellen Song
function pendingInSong(song, j, m) {
  return realChanges(song, m.id).map(({ c }) => ({ c, st: inSongState(j, song, c) })).filter(x => x.st === 'go' || x.st === 'prep');
}
// Nur Wechsel, bei denen sich wirklich etwas ändert (mit der vorherigen Ausstattung)
function realChanges(song, mid) {
  const segs = segmentsOf(song, mid);
  return segs.slice(1).map((c, k) => ({ c, from: segs[k] })).filter(x => isChange(x.from, x.c));
}
function timing(song) {
  const o = (song != null && P().songs[song]?.override) || {};
  return { prep: o.prepSongs ?? me.prepSongs, go: o.goSeconds ?? me.goSeconds };
}
function describe(m, a) {
  const i = instOf(m, a.inst);
  if (!i && !a.tuning && !a.capo) return 'ohne Instrument';
  return [i ? i.name : '?', a.tuning || 'Standard', a.capo ? `Capo ${a.capo}` : null].filter(Boolean).join(' · ');
}

// ---------- Verbindung ----------
let ws, online = false;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { online = true; renderStatus(); };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    const dataChanged = !!msg.data;
    S.live = msg.live;
    if (msg.data) S.data = msg.data;
    if (msg.meta) S.meta = msg.meta;
    render(dataChanged);
  };
  ws.onclose = () => { online = false; renderStatus(); setTimeout(connect, 1000); };
  ws.onerror = () => ws.close();
}
connect();

let pushTimer = null;
function push() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // Projektpfad mitschicken: Wurde in Ableton inzwischen ein anderes Projekt geladen, verwirft der Server die Änderung
    fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Backliner-Project': S.live.project?.file || '' }, body: JSON.stringify(S.data) })
      .then(r => { if (r.status === 409) alert('In Ableton wurde gerade das Projekt gewechselt – deine letzte Änderung wurde nicht gespeichert. Bitte noch einmal eintragen.'); })
      .catch(() => alert('Speichern fehlgeschlagen – keine Verbindung zum Server.'));
  }, 100);
}

// ---------- Rendering ----------
function render(dataChanged) {
  if (!S.data) return;
  renderStatus();
  renderLive();
  if (dataChanged && !isEditing()) {
    if (tab === 'settings') renderSettings();
    if (tab === 'editor') renderEditor();
  }
}
const isEditing = () => !!document.activeElement?.closest?.('#settings, #editor');

function renderStatus() {
  $('offline').style.display = online ? 'none' : 'block';
  $('dot').className = 'dot' + (online && S.live.connected ? ' on' : '');
  $('dot').title = !online ? 'Server nicht erreichbar' : S.live.connected ? 'Mit AbleSet verbunden' : 'Keine Daten von AbleSet';
  const ch = S.live.changed || [];
  $('changed').style.display = ch.length ? 'block' : 'none';
  $('changedList').textContent = ch.join(', ');
  renderProjectSetup();
}

// Neues Ableton-Projekt ohne Backliner-Daten: einmal fragen, woher die Daten kommen sollen
function renderProjectSetup() {
  const pr = S.live.project || {}, el = $('projSetup');
  if (!pr.found || !pr.needsSetup) { el.style.display = 'none'; el.dataset.key = ''; return; }
  const libs = S.live.library || [];
  const key = pr.file + '|' + libs.map(l => l.id).join(',');
  el.style.display = 'block';
  if (el.dataset.key === key) return;             // nicht neu bauen, sonst springt die Auswahl zurück
  el.dataset.key = key;
  el.innerHTML = `<b>Neues Ableton-Projekt „${esc(pr.name)}“</b> – hier sind noch keine Backliner-Daten gespeichert.
    <div class="row">Übernehmen aus <select id="importFrom">${libs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select>
      <button class="primary" data-act="importProj" ${libs.length ? '' : 'disabled'}>Übernehmen</button>
      <button data-act="emptyProj">Leer starten</button></div>
    <div class="label">Gespeichert wird danach im Projektordner: ${esc(pr.folder)}/Backliner</div>`;
}

function slotHtml(m, song, title, highlight, state) {
  if (song == null) return '';
  const a = state || assignOf(song, m.id), base = assignOf(song, m.id), i = instOf(m, a.inst), b = instOf(m, base.backup);
  const j = S.live.setlist.indexOf(song);
  const inSong = realChanges(song, m.id).map(({ c }) => {
    const st = inSongState(j, song, c);
    return `<div class="insong ${st}">⇄ ab „${esc(secName(song, c))}“: ${esc(describe(m, c))}</div>`;
  }).join('');
  return `<div class="slot${highlight ? ' change' : ''}" style="border-color:${esc(i?.color || '#555')}">
    <div class="label">${esc(title)} · ${esc(song)}</div>
    <b>${esc(i?.name || '—')}</b> · ${esc(a.tuning || 'Standard')} · Capo ${esc(a.capo || '–')}
    ${b ? `<div class="label">Backup: ${esc(b.name)}</div>` : ''}
    ${(base.notes || []).filter(n => norm(n)).map(n => `<div>📝 ${esc(n)}</div>`).join('')}
    ${inSong}
  </div>`;
}

function renderLive() {
  if (!S.data) return;
  const { setlist, activeIndex, remaining, playing } = S.live;
  const cur = setlist[activeIndex], next = setlist[activeIndex + 1];
  $('song').textContent = cur ?? (setlist.length ? 'Kein Song aktiv' : 'Keine Setlist von AbleSet');
  $('nowLabel').textContent = (activeIndex >= 0 ? `Jetzt · Song ${activeIndex + 1} von ${setlist.length}` : 'Jetzt') + (S.live.part ? ` · ${S.live.part}` : '');
  $('time').textContent = fmt(remaining);
  $('time').className = playing ? '' : 'paused';

  const mine = P().musicians.filter(m => me.musicians.includes(m.id));
  const alerts = { go: [], prep: [] };

  $('cols').innerHTML = mine.map(m => {
    let level = '';
    // 1) Wechsel im laufenden Song (an einem AbleSet-Abschnitt)
    const pend = cur != null ? pendingInSong(cur, activeIndex, m) : [];
    const goIn = pend.find(x => x.st === 'go');
    if (goIn) {
      level = 'go';
      const r = S.live.sectionRemaining;
      const when = (!playing || r <= 0.5) ? 'JETZT' : `in ${Math.ceil(r)} s`;
      alerts.go.push(`${m.name}: Wechsel ${when} (ab „${secName(cur, goIn.c)}“) → ${describe(m, goIn.c)}`);
    }
    // 2) Wechsel zum nächsten Song steht unmittelbar bevor
    const nextChange = next != null && isChange(endOf(cur, m.id), startOf(next, m.id));
    if (!level && !pend.length && nextChange && remaining != null && remaining <= timing(next).go) {
      level = 'go';
      const when = (!playing || remaining <= 0.5) ? 'JETZT' : `in ${Math.ceil(remaining)} s`;
      alerts.go.push(`${m.name}: Wechsel ${when} → ${describe(m, startOf(next, m.id))}`);
    }
    // 3) Wechsel im laufenden Song vorbereiten
    if (!level && pend.length) {
      level = 'prep';
      alerts.prep.push(`${m.name}: im Song ab „${secName(cur, pend[0].c)}“ → ${describe(m, pend[0].c)}`);
    }
    // 4) Wechsel in den nächsten Songs vorbereiten (Vorlauf pro Song überschreibbar)
    const upcoming = [];
    for (let k = 1; activeIndex + k < setlist.length && k <= 10; k++) {
      const from = setlist[activeIndex + k - 1], to = setlist[activeIndex + k];
      if (activeIndex + k - 1 < 0) continue;
      if (isChange(endOf(from, m.id), startOf(to, m.id))) {
        if (k <= timing(to).prep) upcoming.push({ k, to });
      }
    }
    if (!level && upcoming.length) {
      level = 'prep';
      const u = upcoming[0];
      alerts.prep.push(`${m.name}: vorbereiten für „${u.to}“ → ${describe(m, startOf(u.to, m.id))}`);
    }
    const later = upcoming.filter(u => u.k > 1);
    return `<div class="col ${level}">
      <h2>${esc(m.name)}</h2>
      ${cur != null ? slotHtml(m, cur, 'Jetzt', false, nowOf(cur, m.id)) : ''}
      ${next != null ? (nextChange ? slotHtml(m, next, 'Danach – WECHSEL', true) : `<div class="same">✔ bleibt bei „${esc(next)}“</div>`) : ''}
      ${cur == null && setlist.length ? slotHtml(m, setlist[0], 'Erster Song') : ''}
      ${later.length ? `<div class="upcoming">Weitere Wechsel: ${later.map(u => `${esc(u.to)} (in ${u.k} Songs)`).join(', ')}</div>` : ''}
    </div>`;
  }).join('') || `<div class="empty">Noch keine Musiker ausgewählt. Unter „Einstellungen“ festlegen, wen du betreust${P().musicians.length ? '' : ' – vorher im „Editor“ Musiker anlegen'}.</div>`;

  // Listen- oder Kartenansicht
  const listMode = me.view !== 'cards';
  $('cols').style.display = listMode ? 'none' : '';
  $('list').style.display = listMode ? '' : 'none';
  if (listMode && typeof renderList === 'function') renderList();

  const banner = $('banner');
  // Im Editor/den Einstellungen würde das Banner Eingabefelder verdecken – dort nur ein Punkt im Live-Button
  const liveBtn = document.querySelector('header [data-tab=live]');
  liveBtn.textContent = (tab !== 'live' && alerts.go.length) ? '🔴 Live' : (tab !== 'live' && alerts.prep.length) ? '🟡 Live' : 'Live';
  if (tab !== 'live') { banner.className = ''; banner.textContent = ''; }
  else if (alerts.go.length) { banner.className = 'go'; banner.textContent = '🔴 ' + alerts.go.join('  ·  '); }
  else if (alerts.prep.length) { banner.className = 'prep'; banner.textContent = '🟡 ' + alerts.prep.join('  ·  '); }
  else { banner.className = ''; banner.textContent = ''; }
}

function applyLook() {
  document.body.classList.toggle('s', me.size === 's');
  document.body.classList.toggle('l', me.size === 'l');
  document.body.classList.toggle('portrait', me.orient === 'portrait');
}
applyLook();

function showTab(t) {
  tab = t;
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === t));
  document.querySelectorAll('header [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (t === 'settings') renderSettings();
  if (t === 'editor') renderEditor();
  renderLive();
  window.scrollTo(0, 0);
  if (t === 'live' && typeof listJumpNow === 'function') setTimeout(listJumpNow, 50);
}

// ---------- Einstellungen (pro iPad) ----------
// Adresse für weitere iPads (vom Server, damit auf dem Mac nicht "localhost" steht)
let shareUrlCache = '';
fetch('/api/url').then(r => r.json()).then(j => { shareUrlCache = j.url; const el = $('shareUrl'); if (el) el.textContent = j.url; }).catch(() => {});

function renderSettings() {
  if (!S.data) return;
  const prods = Object.entries(S.data.productions);
  const seg = (key, opts) => `<span class="seg">${opts.map(([v, l]) => `<button data-act="me" data-key="${key}" data-val="${v}" class="${me[key] === v ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  $('settingsBody').innerHTML = `
  ${(() => {
    const pr = S.live.project || {};
    if (pr.found) return `<div class="card">
    <h2>Ableton-Projekt: ${esc(pr.name)}</h2>
    <div class="label">Die Daten werden im Projektordner gespeichert und wechseln automatisch mit, wenn in Ableton ein anderes Projekt geladen wird.</div>
    <div class="path">${esc(pr.file || '')}</div>
    ${pr.needsSetup ? '<div class="label" style="color:var(--warn)">Noch nicht eingerichtet – siehe Hinweis oben.</div>' : ''}
    ${pr.error ? `<div class="label" style="color:var(--alert)">Speichern fehlgeschlagen: ${esc(pr.error)}</div>` : ''}
  </div>`;
    const why = pr.reason === 'notfound' ? `Der Ordner von „${esc(pr.name)}“ wurde nicht gefunden – auf dem Mac über das Plektrum-Symbol in der Menüleiste „Projektordner wählen…“.`
      : pr.reason === 'unsaved' ? 'Das Ableton-Projekt ist noch nicht gespeichert.'
      : pr.searching ? `Suche den Ordner von „${esc(pr.name)}“ …` : 'AbleSet meldet gerade kein Projekt.';
    return `<div class="card">
    <h2>Produktion (Bibliothek)</h2>
    <div class="label" style="color:var(--warn);margin-bottom:.4em">${why} Bis dahin wird in der zentralen Bibliothek gespeichert.</div>
    <div class="row">
      <select data-f="production">${prods.map(([k, p]) => `<option value="${esc(k)}" ${k === S.data.activeProduction ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <button data-act="newProd">+ Neue Produktion</button>
      <button data-act="renameProd">Umbenennen</button>
      <button data-act="deleteProd" class="danger" ${prods.length < 2 ? 'disabled' : ''}>Löschen</button>
    </div>
    <div class="label">Die Produktion gilt für alle iPads.</div>
  </div>`;
  })()}
  <div class="card">
    <h2>Ich betreue heute</h2>
    ${P().musicians.map(m => `<label class="musician-check"><input type="checkbox" data-f="mine" data-mid="${m.id}" ${me.musicians.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('') || '<div class="empty">Noch keine Musiker – im Editor anlegen.</div>'}
  </div>
  <div class="card">
    <h2>Meine Hinweise</h2>
    <div class="row">🟡 Vorbereiten <input type="number" min="0" max="10" inputmode="numeric" data-f="prepSongs" value="${me.prepSongs}" style="width:4em"> Song(s) vorher</div>
    <div class="row">🔴 „Gleich geht’s los“ <input type="number" min="0" max="600" inputmode="numeric" data-f="goSeconds" value="${me.goSeconds}" style="width:5em"> Sekunden vor Songende</div>
    <div class="label">Einzelne Songs können im Editor eigene Zeiten bekommen.</div>
  </div>
  <div class="card">
    <h2>Darstellung</h2>
    <div class="row">Live-Ansicht ${seg('view', [['list', 'Liste'], ['cards', 'Karten']])}</div>
    <div class="row">Nach manuellem Scrollen zurückspringen nach <input type="number" min="1" max="60" inputmode="numeric" data-f="returnSec" value="${me.returnSec}" style="width:4em"> Sekunden</div>
    <div class="row">Schrift ${seg('size', [['s', 'Klein'], ['m', 'Mittel'], ['l', 'Groß']])}</div>
    <div class="row">Layout ${seg('orient', [['landscape', 'Spalten (quer)'], ['portrait', 'Untereinander (hoch)']])}</div>
    <div class="label">Diese Einstellungen gelten nur für dieses iPad.</div>
  </div>
  <div class="card">
    <h2>Weiteres iPad verbinden</h2>
    <div class="row" style="align-items:flex-start;gap:1em">
      <img src="qr.svg" alt="QR-Code" style="width:180px;height:180px;border-radius:10px;background:#fff">
      <div><div class="label">Mit der Kamera des anderen iPads scannen – öffnet diese Oberfläche direkt.</div>
        <div id="shareUrl" style="margin-top:.4em;color:var(--accent);font-weight:700">${esc(shareUrlCache || location.origin)}</div></div>
    </div>
  </div>
  <div class="card">
    <h2>App-Version</h2>
    <div>Backliner for AbleSet ${esc(S.live.app?.current || '')}</div>
    <div class="label" style="${S.live.app?.available ? 'color:var(--accent)' : ''}">${S.live.app?.available
      ? `Update auf ${esc(S.live.app.latest)} verfügbar – auf dem Show-Mac über das Plektrum-Symbol in der Menüleiste installieren.`
      : 'Updates werden auf dem Show-Mac über das Plektrum-Symbol in der Menüleiste gesucht und installiert.'}</div>
  </div>
  <div class="card">
    <h2>Notizen & Überschriften aus AbleSet</h2>
    <div class="label">AbleSet meldet Notizen und Überschriften nur für den aktuellen Song. Die App merkt sich alles, sobald ein Song einmal dran war – nach einem Durchlauf ist die Liste vollständig.
      Bekannt sind gerade ${S.live.setlist.length ? `${S.live.setlist.filter(s => S.meta?.[s]).length} von ${S.live.setlist.length}` : Object.keys(S.meta || {}).length} Songs.</div>
    <div class="row"><button data-act="resetMeta" class="danger">Gelernte Notizen zurücksetzen</button></div>
  </div>`;
}

// Tuning als Auswahlliste (auf dem iPad zuverlässiger als ein Textfeld mit Vorschlägen), eigene Werte per Eingabe
function tuningSelect(f, val, attrs) {
  const v = norm(val), known = TUNINGS.some(t => t.toLowerCase() === v.toLowerCase());
  return `<select data-f="${f}" ${attrs} class="tuning">
    ${TUNINGS.map(t => `<option ${(t === 'Standard' ? !v || v.toLowerCase() === 'standard' : t.toLowerCase() === v.toLowerCase()) ? 'selected' : ''}>${esc(t)}</option>`).join('')}
    ${v && !known ? `<option selected>${esc(v)}</option>` : ''}
    <option value="__custom">✎ Eigenes Tuning …</option></select>`;
}

// ---------- Editor (gilt für alle) ----------
function renderEditor() {
  if (!S.data) return;
  const p = P();
  const live = S.live.setlist || [];
  const extra = Object.keys(p.songs).filter(n => !live.includes(n));
  editSongs = [...new Set([...live, ...extra])];
  const changed = new Set(S.live.changed || []);

  let h = `<div class="card"><h2>Musiker & Instrumente</h2><div class="assign-grid">`;
  h += p.musicians.map((m, mi) => `<div class="assign">
      <div class="row"><input type="text" style="width:auto;flex:1" data-f="mName" data-mi="${mi}" value="${esc(m.name)}" placeholder="Name">
        <button class="danger" data-act="delMusician" data-mi="${mi}">✕</button></div>
      ${m.instruments.map((i, ii) => `<div class="row">
        <input type="color" data-f="iColor" data-mi="${mi}" data-ii="${ii}" value="${esc(i.color)}">
        <input type="text" style="width:auto;flex:1" data-f="iName" data-mi="${mi}" data-ii="${ii}" value="${esc(i.name)}" placeholder="Instrument">
        <button class="danger" data-act="delInst" data-mi="${mi}" data-ii="${ii}">✕</button></div>`).join('')}
      <button data-act="addInst" data-mi="${mi}">+ Instrument</button>
    </div>`).join('');
  h += `</div><div class="row" style="margin-top:.75em"><button class="primary" data-act="addMusician">+ Musiker</button></div></div>`;

  h += `<div class="card"><h2>Songs</h2>
    <div class="label">${live.length ? 'Reihenfolge kommt live aus AbleSet. Songs, die nicht mehr in der Setlist sind, stehen am Ende.' : 'Noch keine Setlist von AbleSet empfangen – zum Testen kannst du Songs von Hand anlegen.'}</div>
    <div class="row"><input type="text" id="newSong" placeholder="Songname" style="width:auto;flex:1"><button data-act="addSong">+ Song</button></div></div>`;

  if (!p.musicians.length) h += `<div class="empty">Lege zuerst Musiker an.</div>`;
  h += editSongs.map((s, si) => {
    const sd = p.songs[s] || { assign: {}, override: {} };
    const o = sd.override || {};
    const pos = live.indexOf(s);
    return `<div class="song-card">
      <h3><span>${pos >= 0 ? `${pos + 1}. ` : '<span class="label">(nicht in Setlist)</span> '}${esc(s)} ${changed.has(s) ? '<span class="changed">⚠️ prüfen</span>' : ''}</span>
        <span class="label">Eigene Zeiten:
          <input type="number" min="0" max="10" inputmode="numeric" style="width:4em" data-f="ovPrep" data-si="${si}" value="${o.prepSongs ?? ''}" placeholder="${me.prepSongs}"> Songs
          <input type="number" min="0" max="600" inputmode="numeric" style="width:5em" data-f="ovGo" data-si="${si}" value="${o.goSeconds ?? ''}" placeholder="${me.goSeconds}"> Sek.
          ${pos < 0 ? `<button class="danger" data-act="delSong" data-si="${si}">Entfernen</button>` : ''}
        </span></h3>
      <div class="assign-grid">${p.musicians.map(m => {
        const a = sd.assign?.[m.id] || {};
        const i = instOf(m, a.inst);
        const opts = sel => `<option value="">—</option>` + m.instruments.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
        const capo = v => `<option value="">–</option>` + Array.from({ length: 12 }, (_, n) => `<option ${String(n + 1) === String(v) ? 'selected' : ''}>${n + 1}</option>`).join('');
        const d = `data-si="${si}" data-mid="${m.id}"`;
        const secs = sectionsFor(s);
        const secOpts = at => {
          const o = secs.map((n, k) => k > 0 ? `<option value="${k}" ${k === +at ? 'selected' : ''}>${k + 1}. ${esc(n || 'Abschnitt ' + (k + 1))}</option>` : '').join('');
          return (+at >= secs.length || +at < 1) ? o + `<option value="${esc(at)}" selected>${esc(secName(s, { at, name: '' }))}</option>` : o;
        };
        const changes = (a.changes || []).map((c, ci) => {
          const ci_ = `${d} data-ci="${ci}"`, ic = instOf(m, c.inst);
          return `<div class="ichg" style="border-color:${esc(ic?.color || '#555')}">
            <div class="row"><b class="label">⇄ Wechsel ab</b> <select data-f="cAt" ${ci_}>${secOpts(c.at)}</select>
              <button class="danger" data-act="delChange" ${ci_}>✕</button></div>
            <div class="row"><select data-f="cInst" ${ci_}>${opts(c.inst)}</select></div>
            <div class="row">${tuningSelect('cTuning', c.tuning, ci_)} Capo <select data-f="cCapo" ${ci_}>${capo(c.capo)}</select></div>
          </div>`;
        }).join('');
        return `<div class="assign" style="border-color:${esc(i?.color || '#555')}">
          <b>${esc(m.name)}</b>
          <div class="row"><select data-f="inst" ${d}>${opts(a.inst)}</select></div>
          <div class="row">${tuningSelect('tuning', a.tuning, d)} Capo <select data-f="capo" ${d}>${capo(a.capo)}</select></div>
          <div class="row"><span class="label">Backup</span><select data-f="backup" ${d}>${opts(a.backup)}</select></div>
          ${(a.notes || []).map((n, ni) => `<div class="row"><input type="text" class="note" style="flex:1;width:auto" data-f="note" data-ni="${ni}" ${d} value="${esc(n)}" placeholder="Notiz">
            <button class="danger" data-act="delNote" data-ni="${ni}" ${d}>✕</button></div>`).join('')}
          <button data-act="addNote" ${d}>+ Notizfeld</button>
          ${changes}
          <button data-act="addChange" ${d} ${secs.length > 1 ? '' : 'disabled'}>+ Wechsel im Song</button>
          ${secs.length > 1 ? '' : `<div class="label">Wechsel im Song: Abschnitte erscheinen, sobald der Song einmal in AbleSet aktiv war.</div>`}
        </div>`;
      }).join('')}</div>
    </div>`;
  }).join('');
  $('editorBody').innerHTML = h;
}

// ---------- Druckansicht ----------
function renderPrint() {
  const p = P();
  const songs = (S.live.setlist && S.live.setlist.length) ? S.live.setlist : Object.keys(p.songs);
  $('print').innerHTML = `<h2>${esc(p.name)} – Wechselliste</h2>
  <p>Gedruckt am ${new Date().toLocaleString('de-DE')} · ⇄ = Wechsel</p>
  <table><tr><th>#</th><th>Song</th>${p.musicians.map(m => `<th>${esc(m.name)}</th>`).join('')}</tr>
  ${songs.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s)}</td>${p.musicians.map(m => {
    const a = assignOf(s, m.id), prev = endOf(songs[i - 1], m.id), inst = instOf(m, a.inst), b = instOf(m, a.backup);
    const chg = i > 0 && isChange(prev, a);
    const inSong = realChanges(s, m.id).map(({ c }) => `<br><b>⇄ ab „${esc(secName(s, c))}“: ${esc(describe(m, c))}</b>`).join('');
    return `<td class="${chg ? 'chg' : ''}">${chg ? '⇄ ' : ''}${inst ? `<span class="sw" style="background:${esc(inst.color)}"></span>${esc(inst.name)}` : '—'}
      ${a.tuning ? ' · ' + esc(a.tuning) : ''}${a.capo ? ' · Capo ' + esc(a.capo) : ''}
      ${b ? `<br><small>Backup: ${esc(b.name)}</small>` : ''}
      ${(a.notes || []).filter(n => norm(n)).map(n => `<br><small>${esc(n)}</small>`).join('')}${inSong}</td>`;
  }).join('')}</tr>`).join('')}</table>`;
}

// ---------- Eingaben ----------
document.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.tab) return showTab(t.dataset.tab);
  if (t.id === 'printBtn') { renderPrint(); return window.print(); }
  if (t.id === 'ackBtn') return fetch('/api/ack-changes', { method: 'POST' });
  if (t.id === 'backBtn') return listJumpNow();
  const act = t.dataset.act;
  if (!act || !S.data) return;
  const p = P(), mi = +t.dataset.mi, ii = +t.dataset.ii, si = +t.dataset.si, ni = +t.dataset.ni, mid = t.dataset.mid;
  const song = editSongs[si];
  switch (act) {
    case 'me': me[t.dataset.key] = t.dataset.val; saveMe(); renderSettings(); return;
    case 'importProj': case 'emptyProj': {
      const from = act === 'importProj' ? $('importFrom')?.value : null;
      fetch('/api/project/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from }) });
      return;
    }
    case 'resetMeta':
      if (!confirm('Alle gelernten AbleSet-Notizen und Überschriften dieser Produktion vergessen? (z. B. nach einer neuen Setlist)')) return;
      fetch('/api/reset-meta', { method: 'POST' }); return;
    case 'newProd': {
      const name = prompt('Name der neuen Produktion?'); if (!name) return;
      const id = uid(); S.data.productions[id] = { name, musicians: [], songs: {}, lastSetlist: [] };
      S.data.activeProduction = id; break;
    }
    case 'renameProd': { const name = prompt('Neuer Name:', p.name); if (!name) return; p.name = name; break; }
    case 'deleteProd': {
      if (!confirm(`Produktion „${p.name}“ wirklich löschen? Alle Songdaten darin gehen verloren.`)) return;
      delete S.data.productions[S.data.activeProduction];
      S.data.activeProduction = Object.keys(S.data.productions)[0]; break;
    }
    case 'addMusician': p.musicians.push({ id: uid(), name: 'Neuer Musiker', instruments: [] }); break;
    case 'delMusician':
      if (!confirm(`„${p.musicians[mi].name}“ mit allen Instrumenten löschen?`)) return;
      p.musicians.splice(mi, 1); break;
    case 'addInst': p.musicians[mi].instruments.push({ id: uid(), name: 'Neues Instrument', color: '#3ad37a' }); break;
    case 'delInst':
      if (!confirm(`„${p.musicians[mi].instruments[ii].name}“ löschen?`)) return;
      p.musicians[mi].instruments.splice(ii, 1); break;
    case 'addSong': {
      const name = norm($('newSong').value); if (!name) return;
      songData(name); break;
    }
    case 'delSong':
      if (!confirm(`„${song}“ mit allen Zuordnungen entfernen?`)) return;
      delete p.songs[song]; break;
    case 'addNote': ensureAssign(song, mid).notes.push(''); break;
    case 'addChange': {
      const a = ensureAssign(song, mid), secs = sectionsFor(song), last = endOf(song, mid);
      const used = a.changes.map(c => +c.at);
      const at = Math.min(Math.max(1, ...used.map(x => x + 1)), Math.max(1, secs.length - 1));
      a.changes.push({ at, name: secs[at] || '', inst: last.inst || '', tuning: last.tuning || '', capo: last.capo || '' });
      break;
    }
    case 'delChange': ensureAssign(song, mid).changes.splice(+t.dataset.ci, 1); break;
    case 'delNote': ensureAssign(song, mid).notes.splice(ni, 1); break;
    default: return;
  }
  push(); renderEditor(); renderSettings();
});

document.addEventListener('change', e => {
  const t = e.target, f = t.dataset.f;
  if (!f || !S.data) return;
  const p = P(), mi = +t.dataset.mi, ii = +t.dataset.ii, si = +t.dataset.si, ni = +t.dataset.ni, mid = t.dataset.mid;
  const song = editSongs[si];
  let v = t.value;
  // „Eigenes Tuning …“: Wert abfragen, bei Abbruch Anzeige zurücksetzen
  if (v === '__custom') {
    const old = f === 'cTuning' ? ensureAssign(song, mid).changes[+t.dataset.ci]?.tuning : assignOf(song, mid).tuning;
    const x = prompt('Tuning eingeben (z. B. Drop B, Open C, Eb Drop Db):', old || '');
    if (x == null || !norm(x)) { renderEditor(); return; }
    v = norm(x);
  }
  switch (f) {
    // persönliche Einstellungen – nur lokal
    case 'mine':
      me.musicians = t.checked ? [...new Set([...me.musicians, mid])] : me.musicians.filter(x => x !== mid);
      return saveMe();
    case 'prepSongs': me.prepSongs = Math.max(0, parseInt(v, 10) || 0); return saveMe();
    case 'goSeconds': me.goSeconds = Math.max(0, parseInt(v, 10) || 0); return saveMe();
    case 'returnSec': me.returnSec = Math.max(1, parseInt(v, 10) || 5); return saveMe();
    // gemeinsame Daten – an den Server
    case 'production': S.data.activeProduction = v; push(); renderSettings(); renderLive(); return;
    case 'mName': p.musicians[mi].name = v; break;
    case 'iName': p.musicians[mi].instruments[ii].name = v; break;
    case 'iColor': p.musicians[mi].instruments[ii].color = v; break;
    case 'ovPrep': case 'ovGo': {
      const o = songData(song).override, key = f === 'ovPrep' ? 'prepSongs' : 'goSeconds';
      if (v === '') delete o[key]; else o[key] = Math.max(0, parseInt(v, 10) || 0);
      break;
    }
    case 'inst': case 'tuning': case 'capo': case 'backup': ensureAssign(song, mid)[f] = v; break;
    case 'note': ensureAssign(song, mid).notes[ni] = v; break;
    case 'cAt': case 'cInst': case 'cTuning': case 'cCapo': {
      const c = ensureAssign(song, mid).changes[+t.dataset.ci]; if (!c) return;
      const key = { cAt: 'at', cInst: 'inst', cTuning: 'tuning', cCapo: 'capo' }[f];
      c[key] = f === 'cAt' ? +v : v;
      if (f === 'cAt') c.name = sectionsFor(song)[+v] || c.name;
      break;
    }
    default: return;
  }
  push(); renderLive();
  // Farbbalken im Editor sofort aktualisieren
  if (['inst', 'iColor', 'cInst', 'cAt', 'tuning', 'cTuning'].includes(f)) { const keep = document.activeElement; renderEditor(); keep?.blur?.(); }
});

window.addEventListener('beforeprint', renderPrint);
