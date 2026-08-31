// 一次性工具：把 public/favicon.svg 產生成多尺寸的 build/icon.ico。
// 相依套件刻意「不」放進 package.json —— 執行方式：
//   npm i --no-save sharp png-to-ico && node scripts/make-icon.mjs
// 產出的 build/icon.ico 已經進版控，所以 `npm run dist` 完全不需要這些東西。
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
