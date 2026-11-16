#!/bin/bash
# Startet Backliner ohne App, z. B. zum schnellen Testen. Fenster offen lassen.
cd "$(dirname "$0")" || exit 1
command -v npm >/dev/null 2>&1 || { echo "Node.js fehlt – siehe nodejs.org"; open "https://nodejs.org/de/download"; read -n 1 -s -r; exit 1; }
[ -d node_modules/express ] || npm install --omit=dev --no-audit --no-fund
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo ""; echo "Auf den iPads öffnen:  http://${IP:-<IP-dieses-Macs>}:8080"; echo "Beenden: dieses Fenster schließen."; echo ""
node server.js
