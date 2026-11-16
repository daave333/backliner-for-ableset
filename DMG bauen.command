#!/bin/bash
# Baut die Mac-App "Backliner for AbleSet" als DMG. Einfach doppelklicken.
cd "$(dirname "$0")" || exit 1
echo "=== Backliner for AbleSet – DMG bauen ==="
if ! command -v npm >/dev/null 2>&1; then
  echo ""
  echo "Node.js fehlt noch. Die Download-Seite öffnet sich gleich:"
  echo "Bitte die LTS-Version installieren und danach diese Datei erneut doppelklicken."
  open "https://nodejs.org/de/download"
  read -n 1 -s -r -p "Taste drücken zum Schließen …"; exit 1
fi
echo "Node.js $(node -v) gefunden."
echo ""
echo "1/2  Pakete installieren (beim ersten Mal ein paar Minuten) …"
npm install --no-audit --no-fund || { echo "FEHLER bei npm install"; read -n 1 -s -r -p "Taste drücken …"; exit 1; }
echo ""
echo "2/2  App bauen …"
npm run dist || { echo "FEHLER beim Bauen"; read -n 1 -s -r -p "Taste drücken …"; exit 1; }
echo ""
echo "FERTIG! Die DMG liegt im Ordner 'dist'."
open dist
read -n 1 -s -r -p "Taste drücken zum Schließen …"
