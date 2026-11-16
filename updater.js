// Backliner for AbleSet – Updates über GitHub Releases
// Fragt die neueste Version bei GitHub ab, lädt das Mac-Paket (.zip), tauscht die App aus und startet neu.
// Bewusst ohne Electrons eingebautes Auto-Update: das verlangt eine kostenpflichtige Apple-Signatur.
const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'daave333/backliner-for-ableset';
const RELEASES_URL = `https://github.com/${REPO}/releases`;

// "1.10.0" > "1.9.2"
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Backliner-for-AbleSet' }
  });
  if (res.status === 404) return { available: false, current: app.getVersion(), latest: null, note: 'Noch keine Version veröffentlicht.' };
  if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const zip = (rel.assets || []).find(a => /\.zip$/i.test(a.name));
  return {
    available: !!latest && newer(latest, app.getVersion()) && !!zip,
    current: app.getVersion(),
    latest,
    notes: (rel.body || '').trim(),
    url: zip ? zip.browser_download_url : null,
    size: zip ? zip.size : 0,
    page: rel.html_url || RELEASES_URL
  };
}

async function download(url, file, onProgress) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Backliner-for-AbleSet' } });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let done = 0;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      await new Promise((ok, fail) => out.write(Buffer.from(value), e => e ? fail(e) : ok()));
      done += value.length;
      if (total && onProgress) onProgress(done / total);
    }
  } finally {
    await new Promise(ok => out.end(ok));
  }
  if (total && done !== total) throw new Error('Download unvollständig');
}

const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 120000 }, (e, so, se) => e ? fail(new Error(se || e.message)) : ok(so)));

// Pfad des laufenden .app-Pakets (…/Backliner for AbleSet.app)
function currentBundle() {
  const m = process.execPath.match(/^(.*?\.app)\//);
  return m ? m[1] : null;
}

// Lädt das Update, entpackt es und tauscht die App nach dem Beenden aus. Danach startet die neue Version.
async function installUpdate(info, onProgress) {
  if (!app.isPackaged) throw new Error('Updates gehen nur in der installierten App, nicht im Entwicklungsmodus.');
  const bundle = currentBundle();
  if (!bundle) throw new Error('Pfad der App nicht gefunden.');
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); }
  catch { throw new Error(`Keine Schreibrechte in „${path.dirname(bundle)}“. Bitte die neue Version von GitHub manuell installieren.`); }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'backliner-update-'));
  const zip = path.join(work, 'update.zip');
  await download(info.url, zip, onProgress);
  onProgress && onProgress(1, 'Entpacken …');
  const unpacked = path.join(work, 'neu');
  await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);          // ditto erhält Signatur und Rechte
  const newApp = fs.readdirSync(unpacked).find(f => f.endsWith('.app'));
  if (!newApp) throw new Error('Im Update-Paket ist keine App enthalten.');
  const newPath = path.join(unpacked, newApp);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newPath]).catch(() => {});

  // Austausch erst nach dem Beenden – mit Rückfall auf die alte Version, falls etwas schiefgeht
  const script = path.join(work, 'install.sh');
  fs.writeFileSync(script, `#!/bin/bash
APP=${JSON.stringify(bundle)}
NEW=${JSON.stringify(newPath)}
OLD=${JSON.stringify(path.join(work, 'alt.app'))}
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
if mv "$APP" "$OLD"; then
  if mv "$NEW" "$APP"; then rm -rf "$OLD"; else mv "$OLD" "$APP"; fi
fi
open "$APP"
`, { mode: 0o755 });
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

module.exports = { checkForUpdate, installUpdate, newer, RELEASES_URL };
