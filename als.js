// Liest Songs und Abschnitte direkt aus der Ableton-Projektdatei (.als)
// AbleSet-Cue-Notation: Song-Cue = Songname, Abschnitt = "> Name" (bzw. ">> Name"),
// "* …" wird ignoriert, STOP/AUTOSTOP/SONG END beenden einen Song,
// {Beschreibung}, [Dauer/Farbe] und +FLAGS gehören nicht zum Namen.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const unXml = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function cleanCue(n) {
  return n.replace(/\{[^}]*\}/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/(^|\s)[+][A-Za-z0-9-]+/g, ' ')   // +PAUSE, +LOOP, +JUMP, +2 …
    .replace(/^\s*\.\s*/, '')                 // ". Song" (Songs direkt hintereinander)
    .replace(/\s+/g, ' ').trim();
}

function readXml(file) {
  const buf = fs.readFileSync(file);
  return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

function parseLocators(xml) {
  const block = xml.match(/<Locators>\s*<Locators>([\s\S]*?)<\/Locators>\s*<\/Locators>/);
  if (!block) return [];
  const out = [];
  const re = /<Locator Id="\d+">([\s\S]*?)<\/Locator>/g;
  let m;
  while ((m = re.exec(block[1]))) {
    const t = m[1].match(/<Time Value="([^"]+)"/), n = m[1].match(/<Name Value="([^"]*)"/);
    if (t && n) out.push({ time: parseFloat(t[1]), name: unXml(n[1]) });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Tempo der Master-/Main-Spur inkl. Automation → Funktion bpm(beat)
function parseTempo(xml) {
  const master = xml.match(/<(MasterTrack|MainTrack)>([\s\S]*?)<\/\1>/);
  const scope = master ? master[2] : xml;
  const tempo = scope.match(/<Tempo>[\s\S]*?<Manual Value="([^"]+)"[\s\S]*?<AutomationTarget Id="(\d+)"/);
  const manual = tempo ? parseFloat(tempo[1]) : 120;
  let points = [];
  if (tempo) {
    const env = scope.match(new RegExp(`<PointeeId Value="${tempo[2]}"\\s*/>[\\s\\S]*?<Events>([\\s\\S]*?)</Events>`));
    if (env) {
      const re = /<FloatEvent[^>]*Time="([^"]+)"[^>]*Value="([^"]+)"/g;
      let m;
      while ((m = re.exec(env[1]))) points.push({ beat: parseFloat(m[1]), bpm: parseFloat(m[2]) });
      points.sort((a, b) => a.beat - b.beat);
    }
  }
  points = points.filter(p => p.bpm > 0);
  if (!points.length) return () => manual;
  return beat => {
    if (beat <= points[0].beat) return points[0].bpm;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (beat <= b.beat) return b.beat === a.beat ? b.bpm : a.bpm + (b.bpm - a.bpm) * (beat - a.beat) / (b.beat - a.beat);
    }
    return points[points.length - 1].bpm;
  };
}

// Sekunden zwischen zwei Positionen (in Beats), numerisch über die Tempokurve
function seconds(bpm, from, to) {
  const step = 0.125;
  let s = 0;
  for (let b = from; b < to; b += step) {
    const w = Math.min(step, to - b);
    s += w * 60 / bpm(b + w / 2);
  }
  return s;
}

// Songs/Abschnitte als MIDI-Clips auf einer Spur „Songs“ bzw. „Sections“ (AbleSet ab Live 11)
function parseTrackCues(xml) {
  const out = [];
  const tr = /<(MidiTrack|AudioTrack) Id="\d+"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = tr.exec(xml))) {
    const name = unXml((m[2].match(/<EffectiveName Value="([^"]*)"/) || [])[1] || '').trim();
    const kind = /^songs?$/i.test(name) ? 'song' : /^sections?$/i.test(name) ? 'section' : null;
    if (!kind) continue;
    const arr = m[2].match(/<ArrangerAutomation>\s*<Events>([\s\S]*?)<\/Events>/);   // nur Arrangement, keine Session-Clips
    if (!arr) continue;
    for (const c of arr[1].split(/<\/(?:MidiClip|AudioClip)>/)) {
      const t = c.match(/<(?:MidiClip|AudioClip) Id="\d+" Time="([^"]+)"/), n = c.match(/<Name Value="([^"]*)"/);
      if (!t || !n) continue;
      const end = c.match(/<CurrentEnd Value="([^"]+)"/);
      out.push({ kind, time: parseFloat(t[1]), end: end ? parseFloat(end[1]) : null, name: unXml(n[1]) });
    }
  }
  return out;
}

// → { songName: { sections: [{ name, t }], duration } } – t in Sekunden ab Songbeginn
function analyze(file) {
  const xml = readXml(file);
  const bpm = parseTempo(xml);
  // Alle Cues zusammen: Locators (Cue-Notation) und Clips auf den Spuren „Songs“/„Sections“
  const cues = [];
  for (const l of parseLocators(xml)) {
    const raw = l.name.trim();
    if (!raw || raw.startsWith('*') || raw.startsWith('[')) continue;            // Notizen, ClyphX
    if (raw.startsWith('>')) { cues.push({ kind: 'section', time: l.time, name: cleanCue(raw.replace(/^>+/, '')) }); continue; }
    const name = cleanCue(raw);
    if (/^(STOP|AUTOSTOP|SONG END)$/i.test(name)) cues.push({ kind: 'end', time: l.time });
    else if (name) cues.push({ kind: 'song', time: l.time, name });
  }
  for (const c of parseTrackCues(xml)) {
    const name = cleanCue(c.name.replace(/^>+/, ''));
    if (name) cues.push({ ...c, name });
  }
  // bei gleicher Position: erst Songende, dann Song, dann Abschnitt
  const order = { end: 0, song: 1, section: 2 };
  cues.sort((a, b) => a.time - b.time || order[a.kind] - order[b.kind]);

  const songs = {};
  let cur = null;
  const finish = endBeat => {
    if (!cur) return;
    const e = endBeat ?? cur.end;
    songs[cur.name] = {
      sections: cur.sections.filter(x => e == null || x.beat < e).map(x => ({ name: x.name, t: seconds(bpm, cur.start, x.beat) })),
      duration: e != null ? seconds(bpm, cur.start, e) : null
    };
    cur = null;
  };
  for (const c of cues) {
    if (cur && cur.end != null && c.time >= cur.end) finish(cur.end);           // Song-Clip zu Ende
    if (c.kind === 'end') { finish(c.time); continue; }
    if (c.kind === 'song') { finish(c.time); cur = { name: c.name, start: c.time, end: c.end ?? null, sections: [] }; continue; }
    if (cur && c.name) cur.sections.push({ name: c.name, beat: c.time });
  }
  finish(null);
  return songs;
}

module.exports = { analyze, cleanCue, parseLocators, parseTempo, parseTrackCues, seconds };
