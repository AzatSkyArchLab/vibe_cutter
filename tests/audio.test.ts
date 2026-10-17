import { describe, expect, it } from 'vitest';
import { Resampler } from '../src/engine/audio/resampler';
import { Mixer, type PcmChunk, type SourceFeed } from '../src/engine/audio/mixer';

const sine = (rate: number, freq: number, n: number, from = 0) =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * (i + from)) / rate));

/** Исходник, отдающий синус порциями произвольного размера. */
function sineFeed(rate: number, freq: number, total: number, chunk = 1000, startIndex = 0): SourceFeed {
  let at = startIndex;
  return {
    sampleRate: rate,
    async next(): Promise<PcmChunk | null> {
      if (at >= total) return null;
      const n = Math.min(chunk, total - at);
      const s = sine(rate, freq, n, at);
      const c: PcmChunk = { index: at, channels: [s, s.slice()] };
      at += n;
      return c;
    },
    close() {},
  };
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

describe('ресемплер', () => {
  it('при равных частотах и целой позиции копирует отсчёты точно', () => {
    const r = new Resampler(48000, 48000, 100);
    const src = sine(48000, 440, 2000);
    r.push(src, 0);
    r.finish();
    const out = new Float32Array(500);
    expect(r.read(out, 0, 500)).toBe(500);
    expect(Array.from(out)).toEqual(Array.from(src.subarray(100, 600)));
  });

  it('44.1 → 48 кГц сохраняет частоту, фазу и амплитуду', () => {
    const r = new Resampler(44100, 48000, 0);
    r.push(sine(44100, 1000, 44100), 0);
    r.finish();
    const out = new Float32Array(40000);
    r.read(out, 0, 40000);
    const expected = sine(48000, 1000, 40000);
    let maxErr = 0;
    for (let i = 100; i < 39000; i++) maxErr = Math.max(maxErr, Math.abs(out[i]! - expected[i]!));
    expect(maxErr).toBeLessThan(2e-3);
  });

  it('ждёт вход, пока его не хватает для окна', () => {
    const r = new Resampler(44100, 48000, 0);
    r.push(sine(44100, 1000, 10), 0);
    expect(r.read(new Float32Array(100), 0, 100)).toBe(0);
  });
});

describe('микшер', () => {
  it('ставит куски на нужные места, дыры — тишина, длина точная', async () => {
    const rate = 48000;
    const mixer = new Mixer(
      [
        { outStart: 0, outEnd: 4800, sourceTime: 0, open: async () => sineFeed(44100, 500, 44100) },
        { outStart: 9600, outEnd: 14400, sourceTime: 0.1, open: async () => sineFeed(44100, 500, 44100, 777) },
      ],
      rate,
      19200,
    );
    const blocks: Float32Array[] = [];
    for (let b; (b = await mixer.nextBlock(1024)); ) blocks.push(b.channels[0]);
    const all = new Float32Array(blocks.reduce((s, b) => s + b.length, 0));
    let o = 0;
    for (const b of blocks) (all.set(b, o), (o += b.length));
    expect(all.length).toBe(19200);
    expect(rms(all.subarray(200, 4600))).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rms(all.subarray(4800, 9600))).toBe(0);
    expect(rms(all.subarray(14400))).toBe(0);
    // Второй кусок: источник с позиции 4410 (0.1 с) — фаза совпадает с синусом от 0.1 с.
    const expected = sine(48000, 500, 4000, 4800);
    let maxErr = 0;
    for (let i = 200; i < 4000; i++) maxErr = Math.max(maxErr, Math.abs(all[9600 + i]! - expected[i]!));
    expect(maxErr).toBeLessThan(3e-3);
  });

  it('исходник короче куска — недостающее заполняется тишиной без зависания', async () => {
    const mixer = new Mixer([{ outStart: 0, outEnd: 9600, sourceTime: 0, open: async () => sineFeed(48000, 500, 1000) }], 48000, 9600);
    let n = 0;
    for (let b; (b = await mixer.nextBlock(4096)); ) n += b.channels[0].length;
    expect(n).toBe(9600);
  });
});
