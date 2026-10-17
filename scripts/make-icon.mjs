// Иконка приложения 1024×1024 (PNG) без сторонних зависимостей:
// плашка в стиле macOS, дорожки таймлайна и плейхед. Сглаживание — суперсэмплинг 4×4.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 1024;
const SS = 4;
const px = new Float32Array(N * N * 4);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const inRoundRect = (x, y, l, t, w, h, r) => {
  const cx = Math.min(Math.max(x, l + r), l + w - r);
  const cy = Math.min(Math.max(y, t + r), t + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= l && x <= l + w && y >= t && y <= t + h;
};

// Плашка: сетка иконок macOS — 824 из 1024, скругление ≈ 185.
const BG = { l: 100, t: 100, w: 824, h: 824, r: 185 };
const clips = [
  { l: 190, t: 300, w: 300, h: 110, c: '#4a76ab' }, // видео
  { l: 520, t: 300, w: 330, h: 110, c: '#355a86' },
  { l: 300, t: 450, w: 420, h: 96, c: '#7a55b8' }, // титр
  { l: 190, t: 590, w: 300, h: 110, c: '#3f8a63' }, // звук
  { l: 520, t: 590, w: 330, h: 110, c: '#2f6a4c' },
];
const PLAY_X = 505;

function shade(x, y) {
  if (!inRoundRect(x, y, BG.l, BG.t, BG.w, BG.h, BG.r)) return null;
  // Фон — вертикальный градиент.
  const k = (y - BG.t) / BG.h;
  let c = [0x30 + (0x18 - 0x30) * k, 0x30 + (0x18 - 0x30) * k, 0x37 + (0x1c - 0x37) * k];
  for (const cl of clips) if (inRoundRect(x, y, cl.l, cl.t, cl.w, cl.h, 22)) c = hex(cl.c);
  // Плейхед: линия и треугольник сверху.
  const orange = hex('#f0883e');
  if (Math.abs(x - PLAY_X) <= 9 && y >= 230 && y <= 790) c = orange;
  if (y >= 200 && y <= 262 && Math.abs(x - PLAY_X) <= (262 - y) * 0.75 + 4) c = orange;
  return c;
}

for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; a += 1;
      }
    const i = (y * N + x) * 4;
    const n = SS * SS;
    // Цвет без премультипликации: делим на покрытие.
    px[i] = a ? r / a : 0;
    px[i + 1] = a ? g / a : 0;
    px[i + 2] = a ? b / a : 0;
    px[i + 3] = (a / n) * 255;
  }

// PNG: RGBA 8 бит, фильтр 0 на каждой строке.
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N * 4; x++) raw[y * (N * 4 + 1) + 1 + x] = Math.round(px[y * N * 4 + x]);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../build/icon.png', import.meta.url), png);
console.log(`build/icon.png ${png.length} bytes`);
