// Renders the app logos (SVG) to icon.png (256 px) and icon.ico (256/64/48/32/16 px) with Electron's own renderer.
// Run with Electron (not plain Node):  npx electron tools/make-icons.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS = [
  { svg: 'desktop/logo.svg', out: 'desktop', alsoPublic: true },
  { svg: 'companion/logo.svg', out: 'companion' },
];
const SIZES = [256, 64, 48, 32, 16];

async function render(win, svg, size) {
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/** ICO file holding PNG images (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  for (const job of JOBS) {
    const svg = readFileSync(path.join(root, job.svg), 'utf-8');
    const pngs = [];
    for (const size of SIZES) pngs.push({ size, data: await render(win, svg, size) });
    writeFileSync(path.join(root, job.out, 'icon.png'), pngs[0].data);
    writeFileSync(path.join(root, job.out, 'icon.ico'), ico(pngs));
    if (job.alsoPublic) {
      copyFileSync(path.join(root, job.svg), path.join(root, 'public', 'logo.svg'));
      copyFileSync(path.join(root, job.out, 'icon.png'), path.join(root, 'public', 'icon.png'));
    }
    console.log(`${job.out}: icon.png + icon.ico`);
  }
  app.quit();
});
