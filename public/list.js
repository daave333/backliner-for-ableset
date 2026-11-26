// Backliner for AbleSet – Listenansicht der Live-Seite
// Zeigt alle Songs und die Wechsel dazwischen, scrollt automatisch mit
// und springt nach manuellem Scrollen von selbst zurück.
'use strict';

const LIST = { html: '', userAt: 0, progUntil: 0 };

function shortGear(m, a) {
  const i = instOf(m, a.inst);
  const parts = [`<b>${esc(i?.name || '—')}</b>`];
  if (a.tuning) parts.push(esc(a.tuning));
  if (a.capo) parts.push(`Capo ${esc(a.capo)}`);
  return parts.join(' · ');
}

// Status eines Wechsels vor Song j: done | go | prep | ''
function eventState(j, to) {
  const { activeIndex, remaining } = S.live;
  if (j <= activeIndex) return 'done';
  const k = j - activeIndex;
  const t = timing(to);
  if (k === 1 && remaining != null && remaining <= t.go) return 'go';
  if (activeIndex >= 0 && k <= t.prep) return 'prep';
  return '';
}

// Notizen/Überschrift eines Songs: beim aktuellen Song live von AbleSet, sonst das Gelernte
function metaFor(song, j) {
  if (j === S.live.activeIndex) return { part: S.live.part || '', before: S.live.notesBefore || [], after: S.live.notesAfter || [] };
  return (S.meta && S.meta[song]) || null;
}
// Notizen zwischen Song j-1 und Song j (Notizen "nach" dem einen und "vor" dem anderen sind dieselben)
function notesBetween(j) {
  const { setlist } = S.live;
  const a = j > 0 ? metaFor(setlist[j - 1], j - 1) : null, b = metaFor(setlist[j], j);
  return [...new Set([...(a?.after || []), ...(b?.before || [])])];
}

function renderList() {
  const el = $('list');
  if (!el || !S.data) return;
  const { setlist, activeIndex } = S.live;
  const mine = P().musicians.filter(m => me.musicians.includes(m.id));
  let html;
  if (!mine.length) {
    html = `<div class="empty">Noch keine Musiker ausgewählt. Unter „Einstellungen“ festlegen, wen du betreust.</div>`;
  } else if (!setlist.length) {
    html = `<div class="empty">Noch keine Setlist von AbleSet empfangen.</div>`;
  } else {
    let lastPart = null;
    html = setlist.map((song, j) => {
      let out = '';
      const passed = j <= activeIndex ? ' done' : '';
      // Überschrift aus AbleSet (z. B. "Zugabenblock"), wenn ein neuer Abschnitt beginnt
      const part = metaFor(song, j)?.part;
      if (part && part !== lastPart) out += `<div class="lrow heading${passed}">${esc(part)}</div>`;
      if (part) lastPart = part;
      // Notizen aus AbleSet (z. B. "Ansage", "Pause")
      out += notesBetween(j).map(n => `<div class="lrow anote${passed}">🗒 ${esc(n)}</div>`).join('');
      // Wechsel-Event vor diesem Song
      if (j > 0) {
        const prev = setlist[j - 1];
        const lines = mine.filter(m => isChange(endOf(prev, m.id), startOf(song, m.id))).map(m => {
          const from = instOf(m, endOf(prev, m.id).inst);
          return `<div class="evline"><span class="who">${esc(m.name)}</span> ${esc(from?.name || '—')} → ${shortGear(m, startOf(song, m.id))}</div>`;
        });
        if (lines.length) {
          const st = eventState(j, song);
          const label = st === 'go' ? 'JETZT WECHSELN' : st === 'prep' ? 'Vorbereiten' : st === 'done' ? 'Wechsel' : 'Wechsel';
          out += `<div class="lrow event ${st}" data-ev="${j}"><div class="evhead">⇄ ${label} <span class="label">vor „${esc(song)}“</span></div>${lines.join('')}</div>`;
        }
      }
      // Songzeile
      const state = j < activeIndex ? 'past' : j === activeIndex ? 'current' : 'future';
      const chips = mine.map(m => {
        // beim laufenden Song die Ausstattung des aktuellen Abschnitts zeigen
        const base = assignOf(song, m.id), a = j === activeIndex ? nowOf(song, m.id) : base;
        const i = instOf(m, a.inst), b = instOf(m, base.backup);
        const notes = (base.notes || []).filter(n => norm(n)).map(n => `<div class="note">📝 ${esc(n)}</div>`).join('');
        return `<div class="chip" style="border-color:${esc(i?.color || '#555')}"><span class="who">${esc(m.name)}</span> ${shortGear(m, a)}${b ? ` <span class="label">· Backup ${esc(b.name)}</span>` : ''}${notes}</div>`;
      }).join('');
      // Wechsel innerhalb des Songs, nach Abschnitt sortiert
      const inSong = mine.flatMap(m => realChanges(song, m.id).map(x => ({ m, ...x }))).sort((x, y) => x.c.at - y.c.at).map(({ m, c, from }) => {
        const st = inSongState(j, song, c);
        const label = st === 'go' ? 'JETZT WECHSELN' : st === 'prep' ? 'Im Song' : 'Im Song';
        return `<div class="insong ${st}"><span class="evhead">⇄ ${label} ab „${esc(secName(song, c))}“</span>
          <span class="who">${esc(m.name)}</span> ${esc(instOf(m, from.inst)?.name || '—')} → ${shortGear(m, c)}</div>`;
      }).join('');
      const desc = norm(S.live.descriptions?.[j]);
      out += `<div class="lrow song ${state}" data-idx="${j}">
        <div class="lhead"><span class="num">${j + 1}</span><span class="name">${esc(song)}</span>${state === 'current' ? '<span class="rowtime" id="rowTime"></span>' : ''}</div>
        ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
        <div class="lgear">${chips}</div>
        ${inSong}
      </div>`;
      return out;
    }).join('');
    // Notizen nach dem letzten Song (z. B. "Ende")
    const lastNotes = metaFor(setlist[setlist.length - 1], setlist.length - 1)?.after || [];
    html += lastNotes.map(n => `<div class="lrow anote">🗒 ${esc(n)}</div>`).join('');
  }
  // DOM nur anfassen, wenn sich wirklich etwas geändert hat (Countdown läuft separat)
  if (html !== LIST.html) { el.innerHTML = html; LIST.html = html; }
  const rt = $('rowTime');
  if (rt) rt.textContent = fmt(S.live.remaining);
}

// ---------- Automatisches Scrollen ----------
function stickyOffset() {
  const h = document.querySelector('header'), n = $('now');
  return (h ? h.offsetHeight : 0) + (n ? n.offsetHeight : 0);
}
function anchorRow() {
  // Aktueller Song steht oben; vor dem ersten Song der Anfang der Liste
  return document.querySelector('#list .lrow.current') || document.querySelector('#list .lrow');
}
function scrollToCurrent(smooth) {
  const row = anchorRow();
  if (!row) return;
  const y = Math.max(0, row.getBoundingClientRect().top + window.scrollY - stickyOffset() - 8);
  if (Math.abs(window.scrollY - y) < 4) return;
  LIST.progUntil = Date.now() + 1500;
  window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' });
}
function listActive() { return tab === 'live' && me.view !== 'cards'; }

function markUser() { LIST.userAt = Date.now(); }
['touchstart', 'touchmove', 'wheel', 'mousedown', 'keydown'].forEach(ev =>
  window.addEventListener(ev, e => { if (listActive() && !e.target.closest?.('#backBtn, header')) markUser(); }, { passive: true }));
// Nachlaufendes Scrollen (Schwung nach dem Wischen) zählt auch als manuell
window.addEventListener('scroll', () => {
  if (listActive() && Date.now() > LIST.progUntil && Date.now() - LIST.userAt < 1500) markUser();
}, { passive: true });

setInterval(() => {
  const btn = $('backBtn');
  if (!btn) return;
  if (!listActive()) { btn.style.display = 'none'; return; }
  const delay = Math.max(1, me.returnSec || 5) * 1000;
  const idle = Date.now() - LIST.userAt;
  if (idle < delay) {
    btn.style.display = 'block';
    btn.textContent = `↩ Zurück zur aktuellen Position · ${Math.ceil((delay - idle) / 1000)} s`;
    const banner = $('banner');
    btn.style.bottom = `calc(${banner && banner.offsetHeight ? banner.offsetHeight : 0}px + 1em)`;
  } else {
    btn.style.display = 'none';
    scrollToCurrent(true);
  }
}, 250);

function listJumpNow() { LIST.userAt = 0; scrollToCurrent(true); }
