// Backliner for AbleSet – Server
// Empfängt den Live-Status von AbleSet per OSC und verteilt ihn per WebSocket an die iPads.
// Daten liegen – wie bei AbleSet – im Ordner des Ableton-Projekts (Unterordner "Backliner").
// Wird kein Projektordner gefunden, nutzt die App die zentrale Bibliothek im App-Datenordner.
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { Client, Server } = require('node-osc');

const ABLESET_HOST = process.env.ABLESET_HOST || '127.0.0.1';
const ABLESET_PORT = Number(process.env.ABLESET_PORT || 39051); // OSC-Eingang von AbleSet
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 39060);   // hier empfangen wir
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const DATA_DIR = process.env.BACKLINER_DATA || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PROJECT_ID = '__project';
const PROJECT_SUBDIR = 'Backliner';
const PROJECT_FILENAME = 'backliner.json';

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file + '.tmp', file); // atomar, damit die Datei nie halb geschrieben ist
}
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const clone = o => JSON.parse(JSON.stringify(o));
function emptyProduction(name) {
  return { name, musicians: [], songs: {}, lastSetlist: [] };
}

// ---------- Bibliothek (zentral, App-Datenordner) ----------
let library = readJson(DATA_FILE, null) || { activeProduction: 'default', productions: { default: emptyProduction('Neue Produktion') } };
const META_FILE = path.join(DATA_DIR, 'ableset-meta.json');
let metaStore = readJson(META_FILE, {});
function saveLibrary() {
  try { writeJsonAtomic(DATA_FILE, library); } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); }
}
let metaSaveTimer = null;
function saveLibraryMeta() {
  clearTimeout(metaSaveTimer);
  metaSaveTimer = setTimeout(() => {
    try { writeJsonAtomic(META_FILE, metaStore); } catch (e) { console.error('Speichern (Meta) fehlgeschlagen:', e.message); }
  }, 1000);
}

// ---------- Projekt (im Ordner des Ableton-Projekts) ----------
// project = { name, folder, file, data: <Produktion>, meta: {}, needsSetup }
let project = null;
const MAP_FILE = path.join(DATA_DIR, 'projects.json');     // gemerkte Zuordnung Projektname → Ordner
let projectMap = readJson(MAP_FILE, {});
let lastBackup = 0;

function backupProjectFile() {
  // Wie AbleSet: alte Stände mit Zeitstempel in "Backup" ablegen (höchstens alle 10 Minuten, die letzten 30 behalten)
  if (!project || !fs.existsSync(project.file) || Date.now() - lastBackup < 10 * 60 * 1000) return;
  lastBackup = Date.now();
  const dir = path.join(path.dirname(project.file), 'Backup');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(project.file, path.join(dir, `backliner_${stamp}.json`));
  const old = fs.readdirSync(dir).filter(f => /^backliner_.*\.json$/.test(f)).sort();
  old.slice(0, Math.max(0, old.length - 30)).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
}
let projectSaveTimer = null;
function saveProject(immediate = false) {
  if (!project || project.needsSetup) return;        // ohne Einrichtung nichts in den Projektordner schreiben
  const p = project;
  const doSave = () => {
    try {
      if (p !== project) return;
      backupProjectFile();
      writeJsonAtomic(p.file, { app: 'Backliner for AbleSet', version: 1, savedAt: new Date().toISOString(), production: p.data, ablesetMeta: p.meta });
    } catch (e) { console.error('Speichern im Projektordner fehlgeschlagen:', e.message); live.project.error = e.message; broadcast(); }
  };
  clearTimeout(projectSaveTimer);
  if (immediate) doSave(); else projectSaveTimer = setTimeout(doSave, 500);
}

function loadProject(name, folder) {
  const file = path.join(folder, PROJECT_SUBDIR, PROJECT_FILENAME);
  const saved = readJson(file, null);
  clearTimeout(projectSaveTimer);
  lastBackup = 0;
  project = saved && saved.production
    ? { name, folder, file, data: saved.production, meta: saved.ablesetMeta || {}, needsSetup: false }
    : { name, folder, file, data: emptyProduction(name), meta: {}, needsSetup: true };
  project.data.name = name;
  console.log(`Projekt „${name}“: ${saved ? 'Daten geladen aus' : 'noch keine Daten in'} ${file}`);
}

// Den Ordner zum Projektnamen finden: gemerkte Zuordnung → Spotlight → typische Ordner durchsuchen
const alsName = name => `${name}.als`;
function isProjectFolder(folder, name) {
  try { return fs.statSync(path.join(folder, alsName(name))).isFile(); } catch { return false; }
}
function rankFolders(name, files) {
  return [...new Set(files
    .filter(f => path.basename(f) === alsName(name) && !/[\\/]Backup[\\/]/.test(f))
    .map(f => path.dirname(f)))]
    .map(dir => {
      let mtime = 0; try { mtime = fs.statSync(path.join(dir, alsName(name))).mtimeMs; } catch {}
      return { dir, hasAbleSet: fs.existsSync(path.join(dir, 'AbleSet')), mtime };
    })
    .sort((a, b) => (b.hasAbleSet - a.hasAbleSet) || (b.mtime - a.mtime))
    .map(x => x.dir);
}
function spotlightSearch(name) {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return resolve([]);
    const q = `kMDItemFSName == "${alsName(name).replace(/["\\]/g, '\\$&')}"`;
    execFile('mdfind', [q], { timeout: 8000 }, (err, out) => resolve(err ? [] : out.split('\n').filter(Boolean)));
  });
}
function walkSearch(name, roots, maxDepth = 5) {
  const found = [], skip = new Set(['node_modules', 'Library', '.Trash', 'Backup', 'Samples', 'Ableton Project Info']);
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length > 20) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name === alsName(name)) found.push(path.join(dir, e.name));
      else if (e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  roots.filter(r => fs.existsSync(r)).forEach(r => walk(r, 0));
  return found;
}
const SEARCH_ROOTS = (process.env.BACKLINER_SEARCH_DIRS ? process.env.BACKLINER_SEARCH_DIRS.split(path.delimiter)
  : ['Music', 'Documents', 'Desktop', 'Dropbox'].map(d => path.join(os.homedir(), d)));

let resolving = 0;
async function resolveProject(name) {
  const token = ++resolving;
  if (!name || /^(untitled|unbenannt|ohne titel)\b/i.test(name)) {
    project = null;
    live.project = { name: name || '', folder: '', found: false, needsSetup: false, reason: name ? 'unsaved' : 'none' };
    return broadcast(true);
  }
  live.project = { name, folder: '', found: false, needsSetup: false, searching: true };
  broadcast();
  let folder = projectMap[name] && isProjectFolder(projectMap[name], name) ? projectMap[name] : null;
  if (!folder) folder = rankFolders(name, await spotlightSearch(name))[0] || null;
  if (!folder) folder = rankFolders(name, walkSearch(name, SEARCH_ROOTS))[0] || null;
  if (token !== resolving) return;                    // inzwischen anderes Projekt geladen
  if (folder) {
    projectMap[name] = folder;
    try { writeJsonAtomic(MAP_FILE, projectMap); } catch {}
    loadProject(name, folder);
  } else {
    project = null;
    console.log(`Projektordner für „${name}“ nicht gefunden – nutze die Bibliothek.`);
  }
  updateProjectStatus();
  live.changed = [];
  broadcast(true);
}
function updateProjectStatus() {
  live.project = project
    ? { name: project.name, folder: project.folder, file: project.file, found: true, needsSetup: project.needsSetup }
    : { name: currentProjectName, folder: '', found: false, needsSetup: false, reason: currentProjectName ? 'notfound' : 'none' };
}
// Für das Menü der Mac-App: Projektordner von Hand wählen
function setProjectFolder(folder) {
  if (!currentProjectName) return 'AbleSet meldet gerade kein geladenes Projekt.';
  if (!isProjectFolder(folder, currentProjectName)) return `In diesem Ordner liegt keine „${alsName(currentProjectName)}“.`;
  projectMap[currentProjectName] = folder;
  try { writeJsonAtomic(MAP_FILE, projectMap); } catch {}
  loadProject(currentProjectName, folder);
  updateProjectStatus();
  broadcast(true);
  return null;
}

// ---------- Zugriff auf die aktive Produktion (Projekt oder Bibliothek) ----------
const prod = () => project ? project.data : library.productions[library.activeProduction];
const meta = () => project ? project.meta : (metaStore[library.activeProduction] ||= {});
function save() { if (project) saveProject(); else saveLibrary(); }
function saveMeta() { if (project) saveProject(); else saveLibraryMeta(); }
// Was die iPads als "data" bekommen: im Projekt-Modus genau eine Produktion
function view() {
  return project ? { activeProduction: PROJECT_ID, productions: { [PROJECT_ID]: project.data } } : library;
}
const libraryList = () => Object.entries(library.productions).map(([id, p]) => ({ id, name: p.name }));

// ---------- Live-Status ----------
let currentProjectName = '';
const live = {
  connected: false,      // kommt etwas von AbleSet an?
  setlist: [],
  activeIndex: -1,
  remaining: null,       // Sekunden bis Songende
  playing: false,
  changed: [],           // Songs, deren Wechsel nach einer Umstellung geprüft werden sollten
  descriptions: [],      // Songbeschreibungen aus AbleSet, passend zur Setlist
  part: '',              // Überschrift, unter der der aktuelle Song steht
  notesBefore: [],       // AbleSet-Notizen direkt vor dem aktuellen Song
  notesAfter: [],        // AbleSet-Notizen direkt nach dem aktuellen Song
  project: { name: '', folder: '', found: false, needsSetup: false, reason: 'none' },
  library: libraryList(),
  app: { current: readJson(path.join(__dirname, 'package.json'), {}).version || '', latest: null, available: false }
};

const cleanList = args => args.filter(a => a != null && String(a).trim() !== '').map(String);

// Notizen/Überschrift erst übernehmen, wenn sich nach einem Songwechsel alles eingeschwungen hat
let learnTimer = null;
function scheduleLearn() {
  clearTimeout(learnTimer);
  learnTimer = setTimeout(() => {
    const song = live.setlist[live.activeIndex];
    if (song == null) return;
    const entry = { part: live.part || '', before: live.notesBefore, after: live.notesAfter };
    const m = meta();
    if (JSON.stringify(m[song]) !== JSON.stringify(entry)) {
      m[song] = entry; saveMeta(); broadcast(false, true);
    }
  }, 1500);
}

function updateSetlist(names) {
  const old = prod().lastSetlist || [];
  if (old.length && JSON.stringify(old) !== JSON.stringify(names)) {
    // Ein Song ist "geändert", wenn er neu ist oder einen anderen Vorgänger hat als vorher
    const prevOf = list => { const m = {}; list.forEach((n, i) => { if (!(n in m)) m[n] = list[i - 1] ?? null; }); return m; };
    const before = prevOf(old), after = prevOf(names);
    const diff = names.filter(n => !(n in before) || before[n] !== after[n]);
    live.changed = [...new Set([...live.changed, ...diff])].filter(n => names.includes(n));
  }
  live.setlist = names;
  prod().lastSetlist = names;
  save();
}

// ---------- OSC ----------
const FILTER = ['/setlist/songs', '/setlist/activeSongIndex', '/setlist/remainingTimeInSong', '/global/isPlaying',
  '/setlist/songDescriptions', '/setlist/activePartName', '/setlist/notesBeforeActiveSong', '/setlist/notesAfterActiveSong',
  '/global/projectName'];
const osc = new Server(LISTEN_PORT, '0.0.0.0');
const ableset = new Client(ABLESET_HOST, ABLESET_PORT);
let lastMessage = 0;

function subscribe() {
  // Laut AbleSet-Doku: /subscribe [host] [port] [name] [fine|ms] [Filter...]
  ableset.send('/subscribe', '127.0.0.1', LISTEN_PORT, 'Backliner for AbleSet', 250, ...FILTER, () => {});
  ableset.send('/getValues', '127.0.0.1', LISTEN_PORT, ...FILTER, () => {});
}
subscribe();
setInterval(subscribe, 10000);               // Abo regelmäßig erneuern (z. B. nach AbleSet-Neustart)
setInterval(() => {                           // Verbindungsstatus prüfen
  const ok = Date.now() - lastMessage < 5000;
  if (ok !== live.connected) { live.connected = ok; broadcast(); }
}, 1000);

osc.on('message', ([address, ...args]) => {
  lastMessage = Date.now();
  switch (address) {
    case '/setlist/songs': updateSetlist(args.filter(a => a != null).map(String)); break;
    case '/setlist/activeSongIndex': live.activeIndex = Number(args[0]); scheduleLearn(); break;
    case '/setlist/songDescriptions': live.descriptions = args.map(a => a == null ? '' : String(a)); break;
    case '/setlist/activePartName': live.part = args[0] == null ? '' : String(args[0]); scheduleLearn(); break;
    case '/setlist/notesBeforeActiveSong': live.notesBefore = cleanList(args); scheduleLearn(); break;
    case '/setlist/notesAfterActiveSong': live.notesAfter = cleanList(args); scheduleLearn(); break;
    case '/setlist/remainingTimeInSong': live.remaining = Number(args[0]); break;
    case '/global/isPlaying': live.playing = !!Number(args[0]); break;
    case '/global/projectName': {
      const name = String(args[0] ?? '').replace(/\.als$/i, '').trim();
      if (name !== currentProjectName) { currentProjectName = name; resolveProject(name); }
      break;
    }
    case '/heartbeat': break;
    default: return;
  }
  if (!live.connected) live.connected = true;
  broadcast();
});
osc.on('error', e => console.error('OSC-Fehler:', e.message));

// ---------- HTTP + WebSocket ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/state', (req, res) => res.json({ live, data: view() }));
app.post('/api/data', (req, res) => {
  const d = req.body;
  if (!d || typeof d !== 'object' || !d.productions || !d.productions[d.activeProduction]) return res.status(400).send('Ungültige Daten');
  // Das iPad sagt mit, für welches Projekt es gespeichert hat – wurde inzwischen gewechselt, wird verworfen
  if ((req.get('X-Backliner-Project') || '') !== (project ? project.file : '')) return res.status(409).send('Projekt wurde gewechselt – bitte neu laden');
  if (project) {
    // Projekt-Modus: nur die Projekt-Produktion annehmen (veraltete Bibliotheks-Ansicht eines iPads verwerfen)
    if (d.activeProduction !== PROJECT_ID) return res.status(409).send('Projekt wurde gewechselt – bitte neu laden');
    project.data = d.productions[PROJECT_ID];
    project.data.name = project.name;
    if (project.needsSetup) { project.needsSetup = false; updateProjectStatus(); } // wer editiert, hat eingerichtet
    saveProject();
  } else {
    if (d.activeProduction === PROJECT_ID) return res.status(409).send('Kein Projekt aktiv – bitte neu laden');
    library = d; saveLibrary(); live.library = libraryList();
  }
  broadcast(true); res.sendStatus(204);
});
// Neues Projekt einrichten: Daten aus einer Produktion der Bibliothek übernehmen oder leer starten
app.post('/api/project/import', (req, res) => {
  if (!project) return res.status(409).send('Kein Projekt aktiv');
  const from = req.body && req.body.from;
  if (from) {
    const src = library.productions[from];
    if (!src) return res.status(404).send('Produktion nicht gefunden');
    project.data = clone(src);
    project.data.name = project.name;
    project.meta = clone(metaStore[from] || {});
  }
  project.needsSetup = false;
  saveProject(true);
  updateProjectStatus();
  broadcast(true); res.sendStatus(204);
});
app.post('/api/ack-changes', (req, res) => { live.changed = []; broadcast(); res.sendStatus(204); });
// QR-Code mit der Adresse dieser Oberfläche – zum Abscannen mit weiteren iPads
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push({ name, ip: n.address, url: `http://${n.address}:${HTTP_PORT}` });
  return out;
}
function shareUrl(req) {
  const url = `http://${req.headers.host}`;
  // Vom Mac selbst aufgerufen (localhost)? Dann die Netzwerk-Adresse nehmen, die iPads erreichen können
  return /^(localhost|127\.|\[::1\])/.test(req.headers.host || '') ? (lanAddresses()[0]?.url || url) : url;
}
app.get('/api/url', (req, res) => res.json({ url: shareUrl(req) }));
app.get('/qr.svg', async (req, res) => {
  const url = shareUrl(req);
  try {
    const svg = await require('qrcode').toString(url, { type: 'svg', margin: 2, color: { dark: '#0d0d0f', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) { res.status(500).send(e.message); }
});
app.post('/api/reset-meta', (req, res) => {
  if (project) project.meta = {}; else metaStore[library.activeProduction] = {};
  saveMeta(); scheduleLearn(); broadcast(false, true); res.sendStatus(204);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let last = 0, pending = null, dataDirty = true, metaDirty = true;
function broadcast(withData = false, withMeta = false) {
  if (withData) { dataDirty = true; metaDirty = true; } // andere Produktion → andere Meta-Infos
  if (withMeta) metaDirty = true;
  const now = Date.now();
  if (now - last < 150) { if (!pending) pending = setTimeout(() => { pending = null; broadcast(); }, 150); return; }
  last = now;
  // Songdaten und Meta-Infos nur mitschicken, wenn sie sich geändert haben – spart WLAN-Bandbreite
  const msg = { live };
  if (dataDirty) msg.data = view();
  if (metaDirty) msg.meta = meta();
  dataDirty = metaDirty = false;
  const json = JSON.stringify(msg);
  wss.clients.forEach(c => c.readyState === 1 && c.send(json));
}
wss.on('connection', ws => ws.send(JSON.stringify({ live, data: view(), meta: meta() })));

server.listen(HTTP_PORT, '0.0.0.0', () => console.log(`Backliner for AbleSet läuft auf Port ${HTTP_PORT}`));
server.on('error', e => console.error('Server-Fehler:', e.message));

// Für das Menüleisten-Symbol der Mac-App
module.exports = {
  HTTP_PORT,
  getStatus: () => ({ live, production: prod()?.name || '', project: live.project }),
  setProjectFolder,
  setUpdateInfo: info => { live.app = { ...live.app, ...info }; broadcast(); }
};
