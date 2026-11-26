// Simuliert AbleSet: nimmt /subscribe an und schickt Setlist, aktuellen Song und Restzeit.
// Start: node test/fake-ableset.js   (danach den Server starten)
const { Server, Client } = require('node-osc');

const songs = ["Intro", "Don't Stop", "Ballade", "Rocker", "Finale", "Zugabe 1", "Medley", "Akustik-Set", "Hymne", "Outro"];
const durations = [20, 40, 35, 30, 25, 30, 45, 30, 35, 20];
let idx = 0, remaining = durations[0], client = null;
// Setlist-Struktur wie im AbleSet-Editor: Überschriften, Notizen zwischen Songs, Songbeschreibungen
const parts = songs.map((_, i) => i < 5 ? 'Hauptset' : 'Zugabenblock');
const descriptions = songs.map((s, i) => i === 2 ? 'Akustik-Intro, Licht runter' : '');
const notes = { 0: ['Einlass-Musik aus'], 3: ['Ansage Band'], 5: ['Abgang & Zugaberufe'] }; // Notiz VOR Song i
const endNotes = ['Ende – Licht an'];
// Abschnitte (Locators) pro Song, gleichmäßig über die Songlänge verteilt
const sectionsOf = i => i === 3 ? ['Intro', 'Strophe', 'Refrain', 'Bridge', 'Outro'] : ['Intro', 'Strophe', 'Refrain', 'Outro'];
function sectionState() {
  const secs = sectionsOf(idx), len = durations[idx] / secs.length, elapsed = durations[idx] - remaining;
  const si = Math.min(secs.length - 1, Math.floor(elapsed / len));
  return { secs, si, rem: (si + 1) * len - elapsed };
}
let lastSection = -1;
function sendSection(force) {
  const { secs, si, rem } = sectionState();
  if (force || si !== lastSection) {
    lastSection = si;
    client.send('/setlist/activeSectionIndex', si, () => {});
    client.send('/setlist/nextSectionIndex', si + 1 < secs.length ? si + 1 : -1, () => {});
  }
  client.send('/setlist/remainingTimeInSection', rem, () => {});
}

const server = new Server(39051, '0.0.0.0');
server.on('message', ([addr, ...args]) => {
  if (addr === '/subscribe') {
    if (!client) console.log('Abo erhalten:', args.join(' '));
    client = new Client(String(args[0]), Number(args[1]));
  }
  if (addr === '/getValues' && client) sendAll();
});

function sendSongInfo() {
  const before = notes[idx] || [null], after = idx === songs.length - 1 ? endNotes : (notes[idx + 1] || [null]);
  client.send('/setlist/activePartName', parts[idx], () => {});
  client.send('/setlist/notesBeforeActiveSong', ...before, () => {});
  client.send('/setlist/notesAfterActiveSong', ...after, () => {});
  client.send('/setlist/sections', ...sectionsOf(idx), () => {});
  sendSection(true);
}
// Projektname wie in Ableton: node test/fake-ableset.js --project "Mein Set"
const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
let projectName = argAfter('--project') || 'Mira Kolibri Live';
// Projektwechsel testen: --switch-to "Anderes Set" (nach 20 Sekunden)
if (argAfter('--switch-to')) setTimeout(() => {
  projectName = argAfter('--switch-to');
  console.log('Projekt gewechselt:', projectName);
  client && client.send('/global/projectName', projectName, () => {});
}, 20000);

function sendAll() {
  client.send('/global/projectName', projectName, () => {});
  client.send('/setlist/songs', ...songs, () => {});
  client.send('/setlist/songDescriptions', ...descriptions, () => {});
  client.send('/setlist/activeSongIndex', idx, () => {});
  sendSongInfo();
  client.send('/global/isPlaying', 1, () => {});
  client.send('/setlist/remainingTimeInSong', remaining, () => {});
}

setInterval(() => {
  if (!client) return;
  remaining -= 1;
  if (remaining < 0) { idx = (idx + 1) % songs.length; remaining = durations[idx]; client.send('/setlist/activeSongIndex', idx, () => {}); sendSongInfo(); }
  client.send('/setlist/remainingTimeInSong', remaining, () => {});
  sendSection();
}, 1000);

// Bei einem bestimmten Song starten: node test/fake-ableset.js --start 3
if (argAfter('--start')) { idx = Number(argAfter('--start')); remaining = durations[idx]; }

// Schneller Durchlauf zum Testen: node test/fake-ableset.js --fast (1 Song = 4 Sekunden)
if (process.argv.includes('--fast')) durations.fill(4), remaining = 4;

// Nach 12 Sekunden die Setlist umstellen, um den Änderungshinweis zu testen
if (process.argv.includes('--reorder')) setTimeout(() => {
  [songs[2], songs[3]] = [songs[3], songs[2]];
  console.log('Setlist umgestellt:', songs.join(', '));
  client && client.send('/setlist/songs', ...songs, () => {});
}, 12000);
console.log('Fake-AbleSet hört auf Port 39051');
