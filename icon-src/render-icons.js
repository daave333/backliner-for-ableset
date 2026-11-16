// Erzeugt alle Icon-Größen aus den SVG-Vorlagen: node icon-src/render-icons.js
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const jobs = [
  ['icon.svg', 1024, 'build/icon.png'],
  ['icon.svg', 180, 'public/apple-touch-icon.png'],
  ['icon.svg', 64, 'public/favicon.png'],
  ['tray.svg', 18, 'assets/trayTemplate.png'],
  ['tray.svg', 36, 'assets/trayTemplate@2x.png'],
];
for (const [src, size, out] of jobs) {
  const svg = fs.readFileSync(path.join(__dirname, src));
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
  fs.writeFileSync(path.join(root, out), png);
  console.log(out, size + 'px', png.length, 'Bytes');
}
