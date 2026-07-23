// One-off: render public/favicon.svg into a multi-size build/icon.ico.
// Deps are intentionally NOT in package.json — run with:
//   npm i --no-save sharp png-to-ico && node scripts/make-icon.mjs
// The resulting build/icon.ico is committed, so `npm run dist` needs none of this.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'public', 'favicon.svg');
const OUT = path.join(ROOT, 'build', 'icon.ico');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((s) => sharp(SVG, { density: 72 * (s / 44) * 4 }).resize(s, s).png().toBuffer()),
);
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, await pngToIco(pngs));
console.log(`wrote ${OUT} (${sizes.join('/')}px)`);
