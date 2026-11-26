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

// → { songName: { sections: [{ name, t }], duration } } – t in Sekunden ab Songbeginn
function analyze(file) {
  const xml = readXml(file);
  const locs = parseLocators(xml), bpm = parseTempo(xml);
  const songs = {};
  let cur = null;
  const finish = endBeat => {
    if (!cur) return;
    if (endBeat != null) cur.duration = seconds(bpm, cur.start, endBeat);
    songs[cur.name] = { sections: cur.sections.map(x => ({ name: x.name, t: seconds(bpm, cur.start, x.beat) })), duration: cur.duration ?? null };
    cur = null;
  };
  for (const l of locs) {
    const raw = l.name.trim();
    if (!raw || raw.startsWith('*') || raw.startsWith('[')) continue;            // Notizen, ClyphX
    if (raw.startsWith('>')) {                                                    // Abschnitt
      const name = cleanCue(raw.replace(/^>+/, ''));
      if (cur && name) cur.sections.push({ name, beat: l.time });
      continue;
    }
    const name = cleanCue(raw);
    if (/^(STOP|AUTOSTOP|SONG END)$/i.test(name)) { finish(l.time); continue; }  // Songende
    if (!name) continue;
    finish(l.time);                                                               // nächster Song beendet den vorigen
    cur = { name, start: l.time, sections: [] };
  }
  finish(null);
  return songs;
}

module.exports = { analyze, cleanCue, parseLocators, parseTempo, seconds };
