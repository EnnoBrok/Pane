// Generates the app icon from code: src/assets/icon.svg, icon.png (512 px) and
// icon.ico (16-256 px, for the Windows exe). Run with: npm run icons
// The in-app mark in src/renderer/index.html uses the same SLICE path.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'src', 'assets');

// One toast slice in a 10 x 10 box: flat-domed crust with a slight shoulder, straight sides, round bottom.
const SLICE = 'M0.3 3.4 C-0.2 2.9 -0.15 1.6 0.6 1.0 C1.6 0.2 3.2 0 5 0 C6.8 0 8.4 0.2 9.4 1.0 C10.15 1.6 10.2 2.9 9.7 3.4 L9.7 8 Q9.7 10 7.7 10 L2.3 10 Q0.3 10 0.3 8 Z';
const BACK = [2.1, 0];        // the back slice sits up and to the right, in a 12.1 x 12.4 box
const FRONT = [0, 2.4];
const slice = ([x, y], attrs = '') => `<path d="${SLICE}" transform="translate(${x} ${y})" ${attrs}/>`;

// Each slice is a translucent band with a light edge on both sides, on a see-through plate.
const U = 27;                 // px per unit at 512 px
const BAND = 0.95;
const EDGE = 0.2;
const ox = (512 - 12.1 * U) / 2;
const oy = (512 - 12.4 * U) / 2;
const band = (pos, id) =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" x="-2" y="-2" width="16" height="16">` +
  `${slice(pos, `fill="none" stroke="#fff" stroke-width="${BAND}"`)}${slice(pos, `fill="none" stroke="#000" stroke-width="${BAND - 2 * EDGE}"`)}</mask>` +
  `${slice(pos, `fill="#fff" fill-opacity="0.05" stroke="#fff" stroke-opacity="0.16" stroke-width="${BAND - 2 * EDGE}"`)}` +
  `<rect x="-2" y="-2" width="16" height="16" fill="#fff" fill-opacity="0.92" mask="url(#${id})"/>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2d34" stop-opacity="0.82"/>
      <stop offset="1" stop-color="#0c0d10" stop-opacity="0.74"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.3"/></filter>
  </defs>
  <rect width="512" height="512" rx="72" fill="url(#plate)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="70.5" fill="none" stroke="#fff" stroke-opacity="0.14" stroke-width="3"/>
  <g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${U})">
    <g fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="${BAND}" filter="url(#glow)">${slice(BACK)}${slice(FRONT)}</g>
    ${band(BACK, 'b')}${band(FRONT, 'f')}
  </g>
</svg>
`;

// An ICO file holding one PNG per size (supported since Windows Vista).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p.data)]);
}

app.whenReady().then(async () => {
  fs.writeFileSync(path.join(OUT, 'icon.svg'), SVG);
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,<body></body>');
  // The SVG is rasterized by Chromium itself, so the result matches what the app draws.
  const render = (size) => w.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`).then(url => nativeImage.createFromDataURL(url).toPNG());
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(512));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, data: await render(size) });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs));
  console.log(`wrote icon.svg, icon.png and icon.ico (${sizes.join(', ')} px) to ${OUT}`);
  app.quit();
});
