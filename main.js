// Backliner for AbleSet – Mac-App (Electron)
// Läuft als Menüleisten-App (wie AbleSet): Symbol oben rechts mit Status, iPad-Adresse und Optionen.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, clipboard, dialog } = require('electron');
const os = require('os');
const path = require('path');

// Nur eine Instanz zulassen (sonst wäre Port 8080 doppelt belegt)
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

process.env.BACKLINER_DATA = app.getPath('userData');
let serverError = null;
process.on('uncaughtException', e => { serverError = e; console.error(e); });
const { HTTP_PORT, getStatus, setProjectFolder, setUpdateInfo } = require('./server.js');
const updater = require('./updater.js');

// ---------- Updates ----------
// update = { state: 'idle'|'checking'|'available'|'downloading'|'error', info, progress, error }
const update = { state: 'idle', info: null, progress: 0, error: '' };
let notifiedVersion = null;
function publishUpdate() {
  setUpdateInfo({ current: app.getVersion(), latest: update.info?.latest || null, available: update.state === 'available' || update.state === 'downloading' });
  lastMenuKey = ''; updateTray();
}
async function checkUpdates(interactive) {
  if (update.state === 'downloading') return;
  update.state = 'checking'; publishUpdate();
  try {
    update.info = await updater.checkForUpdate();
    update.state = update.info.available ? 'available' : 'idle';
    update.error = '';
    publishUpdate();
    if (update.info.available && !interactive && notifiedVersion !== update.info.latest) {
      notifiedVersion = update.info.latest;               // pro Version nur einmal melden
      const { Notification } = require('electron');
      if (Notification.isSupported()) new Notification({ title: `Backliner ${update.info.latest} ist verfügbar`, body: 'Installieren über das Plektrum-Symbol in der Menüleiste.' }).show();
    }
    if (interactive) {
      if (update.info.available) return confirmInstall();
      dialog.showMessageBox({ type: 'info', message: 'Backliner ist auf dem neuesten Stand.', detail: `Installiert: ${app.getVersion()}${update.info.latest ? ` · Neueste Version: ${update.info.latest}` : ''}${update.info.note ? `\n${update.info.note}` : ''}` });
    }
  } catch (e) {
    update.state = 'error'; update.error = e.message; publishUpdate();
    if (interactive) dialog.showMessageBox({ type: 'warning', message: 'Update-Prüfung fehlgeschlagen.', detail: `${e.message}\n\nIst der Mac mit dem Internet verbunden?` });
  }
}
async function confirmInstall() {
  const info = update.info;
  if (!info || !info.available) return;
  const { live } = getStatus();
  const showRunning = live.connected && live.playing;
  const r = await dialog.showMessageBox({
    type: showRunning ? 'warning' : 'question',
    message: `Backliner ${info.latest} installieren?`,
    detail: (showRunning ? '⚠️ AbleSet spielt gerade! Während der Installation startet Backliner neu und die iPads verlieren kurz die Verbindung.\n\n' : '')
      + `Installiert ist ${info.current}. Die App lädt die neue Version (${Math.round(info.size / 1e6)} MB), startet neu – deine Daten bleiben erhalten.`
      + (info.notes ? `\n\nNeu:\n${info.notes.slice(0, 800)}` : ''),
    buttons: ['Jetzt installieren', 'Später', 'Auf GitHub ansehen'],
    defaultId: showRunning ? 1 : 0, cancelId: 1
  });
  if (r.response === 2) return shell.openExternal(info.page);
  if (r.response !== 0) return;
  update.state = 'downloading'; update.progress = 0; publishUpdate();
  try {
    await updater.installUpdate(info, p => { update.progress = p; lastMenuKey = ''; updateTray(); });
  } catch (e) {
    update.state = 'available'; publishUpdate();
    const rr = await dialog.showMessageBox({ type: 'error', message: 'Update fehlgeschlagen.', detail: e.message, buttons: ['OK', 'Download-Seite öffnen'] });
    if (rr.response === 1) shell.openExternal(info.page);
  }
}
function updateMenuItem() {
  if (update.state === 'checking') return { label: 'Suche nach Updates …', enabled: false };
  if (update.state === 'downloading') return { label: `Update wird geladen … ${Math.round(update.progress * 100)} %`, enabled: false };
  if (update.state === 'available') return { label: `⬆️ Update auf ${update.info.latest} installieren …`, click: confirmInstall };
  return { label: 'Nach Updates suchen …', click: () => checkUpdates(true) };
}

// Projektordner von Hand wählen, falls die automatische Suche ihn nicht findet
async function chooseProjectFolder() {
  const { project } = getStatus();
  if (!project.name) return dialog.showMessageBox({ type: 'info', message: 'AbleSet meldet gerade kein geladenes Projekt.', detail: 'Bitte zuerst das Projekt in Ableton öffnen.' });
  const r = await dialog.showOpenDialog({ title: `Ordner von „${project.name}“ wählen`, message: `Den Ordner wählen, in dem „${project.name}.als“ liegt.`, properties: ['openDirectory'], defaultPath: project.folder || app.getPath('music') });
  if (r.canceled || !r.filePaths[0]) return;
  const err = setProjectFolder(r.filePaths[0]);
  if (err) dialog.showMessageBox({ type: 'warning', message: 'Das ist nicht der richtige Ordner.', detail: err });
  lastMenuKey = ''; updateTray();
}

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push({ name, ip: n.address, url: `http://${n.address}:${HTTP_PORT}` });
  return out;
}
const fmt = s => (s == null || isNaN(s)) ? '–:––' : `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

// ---------- Status-Fenster ----------
let win = null;
const QRCode = require('qrcode');
async function page() {
  const list = addresses();
  const qrs = await Promise.all(list.map(a => QRCode.toString(a.url, { type: 'svg', margin: 2, color: { dark: '#0d0d0f', light: '#ffffff' } }).catch(() => '')));
  const urls = list.map((a, i) => `<div class="url"><div class="qr">${qrs[i]}</div><div><b>${a.url}</b><span>${a.name}</span></div></div>`).join('')
    || '<p>Kein Netzwerk gefunden – WLAN/LAN prüfen.</p>';
  const err = serverError ? `<p class="err">Fehler: ${String(serverError.message).replace(/</g, '&lt;')}${serverError.code === 'EADDRINUSE' ? ` – Port ${HTTP_PORT} ist schon belegt (läuft die App doppelt?)` : ''}</p>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{background:#0d0d0f;color:#ececf0;font:15px -apple-system,sans-serif;padding:22px;margin:0;-webkit-user-select:text}
    h2{color:#3ad37a;margin:0 0 4px} p{color:#8a8a96;margin:6px 0}
    .url{display:flex;gap:16px;align-items:center;background:#17171b;border:1px solid #2e2e36;border-radius:10px;padding:12px 14px;margin:10px 0}
    .url b{display:block;font-size:22px;color:#3ad37a} .url span{color:#8a8a96;font-size:12px}
    .qr{width:150px;height:150px;flex:none;border-radius:8px;overflow:hidden;background:#fff} .qr svg{width:100%;height:100%;display:block}
    .err{color:#e5383b}
  </style></head><body>
    <h2>Backliner for AbleSet läuft</h2>
    <p>QR-Code mit der iPad-Kamera scannen oder die Adresse in Safari öffnen (gleiches Netzwerk):</p>${urls}${err}
    <p>Das Fenster kann zu – Backliner läuft oben in der Menüleiste weiter (Plektrum-Symbol).</p>
    <p style="font-size:12px">Version ${app.getVersion()}${update.state === 'available' ? ` · <span style="color:#3ad37a">Update ${update.info.latest} verfügbar – im Menüleisten-Symbol installieren</span>` : ''}</p>
  </body></html>`;
}
async function showWindow() {
  const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(await page());
  if (win) { win.loadURL(html); win.show(); win.focus(); return; }
  const n = Math.max(1, addresses().length);
  win = new BrowserWindow({ width: 560, height: Math.min(900, 230 + n * 186), backgroundColor: '#0d0d0f', title: 'Backliner for AbleSet', resizable: true, show: false });
  win.loadURL(html);
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('closed', () => { win = null; });
}

// ---------- Menüleisten-Symbol ----------
let tray = null, lastMenuKey = '';
const settings = { showTime: true };
try { Object.assign(settings, require(path.join(app.getPath('userData'), 'app-settings.json'))); } catch {}
function saveSettings() {
  try { require('fs').writeFileSync(path.join(app.getPath('userData'), 'app-settings.json'), JSON.stringify(settings)); } catch {}
}

function updateTray() {
  if (!tray) return;
  const { live, production, project } = getStatus();
  const cur = live.setlist[live.activeIndex], next = live.setlist[live.activeIndex + 1];
  const time = cur != null ? fmt(live.remaining) : '';

  // Restzeit neben dem Symbol (abschaltbar)
  tray.setTitle(settings.showTime && live.connected && cur != null ? ` ${time}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(`Backliner for AbleSet – ${live.connected ? 'mit AbleSet verbunden' : 'keine Daten von AbleSet'}`);

  // Menü nur neu bauen, wenn sich etwas Sichtbares geändert hat (nicht jede Sekunde)
  const list = addresses();
  const key = JSON.stringify([live.connected, cur, next, production, project, list.map(a => a.url), settings, app.getLoginItemSettings().openAtLogin, !!serverError, update.state, Math.round(update.progress * 100)]);
  if (key === lastMenuKey) return;
  lastMenuKey = key;

  const template = [
    { label: 'Backliner for AbleSet', enabled: false },
    { label: live.connected ? '🟢 Mit AbleSet verbunden' : '🔴 Keine Daten von AbleSet', enabled: false },
    ...(project.found ? [{ label: `Projekt: ${project.name}${project.needsSetup ? ' (noch nicht eingerichtet)' : ''}`, enabled: false }]
      : project.name ? [{ label: `⚠️ Ordner von „${project.name}“ ${project.searching ? 'wird gesucht …' : 'nicht gefunden'}`, enabled: false },
                        { label: `Bibliothek: ${production}`, enabled: false }]
      : production ? [{ label: `Bibliothek: ${production}`, enabled: false }] : []),
    ...(cur != null ? [{ label: `Jetzt: ${cur}`, enabled: false }] : []),
    ...(next != null ? [{ label: `Danach: ${next}`, enabled: false }] : []),
    ...(serverError ? [{ label: `⚠️ ${serverError.code === 'EADDRINUSE' ? `Port ${HTTP_PORT} belegt` : 'Server-Fehler'}`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'iPad-Adresse kopieren', enabled: list.length > 0, submenu: list.length ? list.map(a => ({ label: `${a.url}  (${a.name})`, click: () => clipboard.writeText(a.url) })) : undefined },
    { label: 'Oberfläche im Browser öffnen', click: () => shell.openExternal(`http://localhost:${HTTP_PORT}`) },
    { label: 'QR-Code für iPads anzeigen …', click: showWindow },
    { type: 'separator' },
    { label: 'Restzeit in der Menüleiste anzeigen', type: 'checkbox', checked: settings.showTime, click: i => { settings.showTime = i.checked; saveSettings(); lastMenuKey = ''; updateTray(); } },
    { label: 'Beim Anmelden automatisch starten', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: i => { app.setLoginItemSettings({ openAtLogin: i.checked }); lastMenuKey = ''; updateTray(); } },
    { type: 'separator' },
    { label: 'Backliner-Daten im Projektordner zeigen', enabled: !!project.found, click: () => project.file && require('fs').existsSync(project.file) ? shell.showItemInFolder(project.file) : shell.openPath(project.folder) },
    { label: 'Projektordner wählen …', enabled: !!project.name, click: chooseProjectFolder },
    { label: 'Bibliothek (App-Daten) öffnen', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    updateMenuItem(),
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Backliner beenden', accelerator: 'Command+Q', click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Kein Dock-Symbol – die App lebt in der Menüleiste
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray();
  setInterval(updateTray, 500);

  // Updates: kurz nach dem Start und dann alle 6 Stunden still prüfen (installiert wird nur auf Klick)
  publishUpdate();
  setTimeout(() => checkUpdates(false), 15000);
  setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);

  // Beim ersten Start einmal das Fenster mit der iPad-Adresse zeigen
  const firstRunFlag = path.join(app.getPath('userData'), '.welcome-shown');
  const fs = require('fs');
  if (!fs.existsSync(firstRunFlag) || serverError) {
    showWindow();
    try { fs.writeFileSync(firstRunFlag, '1'); } catch {}
  }
});

// Fenster schließen beendet nicht – Backliner läuft in der Menüleiste weiter
app.on('window-all-closed', () => {});
app.on('second-instance', showWindow);
