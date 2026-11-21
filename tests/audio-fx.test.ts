import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FX, fxTailSec, hasFx, sameFx, sanitizeFx } from '../src/domain/audio-fx';
import { outputSettings } from '../src/domain/export-preset';
import { parseProjectFile, serializeProjectFile, type Project } from '../src/domain/project';
import { buildRenderPlan } from '../src/domain/render-plan';
import { appendAtEnd, placementsForAsset, splitAt } from '../src/domain/timeline';
import { FxChain } from '../src/engine/audio/effects';
import { Mixer, type PcmChunk, type SourceFeed } from '../src/engine/audio/mixer';
import { fakes, video } from './fakes';
import { R30, asset, setup } from './helpers';

const RATE = 48000;
const sine = (freq: number, n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / RATE));
const rms = (a: Float32Array, from = 0, to = a.length) => {
  const f = Math.floor(from);
  const t = Math.floor(to);
  let s = 0;
  for (let i = f; i < t; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / Math.max(1, t - f));
};
const db = (x: number) => 20 * Math.log10(x);

/** Пропускает сигнал через цепочку блоками по 1000 (как в микшере). */
function run(fx: Parameters<typeof sanitizeFx>[0], l: Float32Array, r = l.slice()): [Float32Array, Float32Array] {
  const chain = new FxChain(sanitizeFx(fx), RATE);
  const L = l.slice();
  const R = r.slice();
  for (let i = 0; i < L.length; i += 1000) {
    const n = Math.min(1000, L.length - i);
    chain.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return [L, R];
}

describe('эффекты звука', () => {
  it('громкость: −6 дБ уменьшает амплитуду вдвое', () => {
    const x = sine(440, RATE);
    const [y] = run({ gainDb: -6 }, x);
    expect(rms(y) / rms(x)).toBeCloseTo(Math.pow(10, -6 / 20), 6);
  });

  it('«телефон» оставляет середину и срезает низ и верх', () => {
    const level = (f: number) => {
      const x = sine(f, RATE, 0.1);
      const [y] = run({ phone: 1 }, x);
      return db(rms(y, RATE / 2) / rms(x, RATE / 2));
    };
    const mid = level(1000);
    expect(mid - level(80)).toBeGreaterThan(25);
    expect(mid - level(9000)).toBeGreaterThan(20);
  });

  it('«телефон» звучит моно', () => {
    const [l, r] = run({ phone: 1 }, sine(1000, 4800), sine(700, 4800));
    for (let i = 0; i < 4800; i += 97) expect(l[i]).toBeCloseTo(r[i]!, 6);
  });

  it('реверберация: после короткого щелчка звучит хвост и затухает', () => {
    const x = new Float32Array(RATE * 3);
    x.fill(0.8, 0, 480); // щелчок 10 мс
    const [y] = run({ reverb: { preset: 'hall', mix: 0.5 } }, x);
    const tail1 = rms(y, RATE * 0.3, RATE * 0.6);
    const tail2 = rms(y, RATE * 2.2, RATE * 2.5);
    expect(tail1).toBeGreaterThan(0.005);
    expect(tail2).toBeLessThan(tail1 / 3);
  });

  it('без эффектов сигнал не меняется', () => {
    const x = sine(440, 4800);
    const [y] = run(NO_FX, x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('модель: допустимые значения, сравнение, длина хвоста', () => {
    expect(sanitizeFx({ gainDb: 99, phone: 7, reverb: { preset: 'x' as never, mix: -1 } })).toEqual({
      gainDb: 12,
      phone: 1,
      reverb: { preset: 'room', mix: 0 },
    });
    expect(hasFx(NO_FX)).toBe(false);
    expect(hasFx({ ...NO_FX, reverb: { preset: 'hall', mix: 0 } })).toBe(false);
    expect(sameFx(null, NO_FX)).toBe(true);
    expect(sameFx({ ...NO_FX, phone: 0.5 }, NO_FX)).toBe(false);
    expect(fxTailSec({ ...NO_FX, reverb: { preset: 'cathedral', mix: 0.3 } })).toBe(5);
  });
});

describe('микшер с эффектами', () => {
  function feed(total: number): SourceFeed {
    let at = 0;
    return {
      sampleRate: RATE,
      async next(): Promise<PcmChunk | null> {
        if (at >= total) return null;
        const n = Math.min(4000, total - at);
        const s = sine(500, n);
        const c: PcmChunk = { index: at, channels: [s, s.slice()] };
        at += n;
        return c;
      },
      close() {},
    };
  }

  async function mixAll(m: Mixer): Promise<Float32Array> {
    const parts: Float32Array[] = [];
    for (let b; (b = await m.nextBlock(2048)); ) parts.push(b.channels[0].slice());
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  }

  it('хвост реверберации звучит после конца клипа, а без эффекта там тишина', async () => {
    const clipEnd = RATE; // клип 1 с, выход 3 с
    const wet = await mixAll(new Mixer([{ outStart: 0, outEnd: clipEnd, sourceTime: 0, open: async () => feed(RATE * 2), fx: { gainDb: 0, phone: 0, reverb: { preset: 'hall', mix: 0.5 } } }], RATE, RATE * 3));
    const dry = await mixAll(new Mixer([{ outStart: 0, outEnd: clipEnd, sourceTime: 0, open: async () => feed(RATE * 2) }], RATE, RATE * 3));
    expect(wet.length).toBe(RATE * 3);
    expect(rms(dry, clipEnd + 100, clipEnd + RATE / 2)).toBe(0);
    expect(rms(wet, clipEnd + 100, clipEnd + RATE / 2)).toBeGreaterThan(0.005);
  });
});

describe('эффекты в плане и редакторе', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const A = asset('A', 10);
  const out = outputSettings({ target: 'youtube', width: 1920, height: 1080, frameRate: R30 });
  const project = (timeline: Project['timeline']): Project => ({
    version: 1,
    name: 't',
    settings: { width: 1920, height: 1080, frameRate: R30, fit: 'fit' },
    assets: [A],
    timeline,
  });

  it('куски с одинаковыми эффектами сливаются, с разными нет', () => {
    const s = setup();
    let tl = appendAtEnd(s.tl, placementsForAsset(s.tl, A, { video: s.v1, audio: s.a1 }), s.ids).timeline;
    tl = splitAt(tl, 100, s.ids);
    const fx = { gainDb: 0, phone: 1, reverb: null };
    const both = { ...tl, tracks: tl.tracks.map((t) => (t.kind === 'audio' ? { ...t, clips: t.clips.map((c) => ({ ...c, audioFx: fx })) } : t)) };
    expect(buildRenderPlan(project(both), out).audio.map((a) => [a.from, a.to, a.fx?.phone])).toEqual([[0, 300, 1]]);
    const one = { ...tl, tracks: tl.tracks.map((t) => (t.kind === 'audio' ? { ...t, clips: t.clips.map((c, i) => (i === 1 ? { ...c, audioFx: fx } : c)) } : t)) };
    expect(buildRenderPlan(project(one), out).audio.map((a) => [a.from, a.to, a.fx?.phone ?? 0])).toEqual([[0, 100, 0], [100, 300, 1]]);
  });

  it('редактор: эффект на звуке выделенной пары; ползунок подряд как один шаг отмены; сохранение в файл', async () => {
    const { editor, disk } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    editor.appendAsset(id);
    const sel = editor.selectedAudioClip();
    expect(sel).not.toBeNull();
    for (const mix of [0.1, 0.2, 0.3]) editor.updateAudioFx(sel!.id, { reverb: { preset: 'hall', mix } });
    expect(editor.selectedAudioClip()!.fx.reverb).toEqual({ preset: 'hall', mix: 0.3 });
    editor.undo();
    expect(hasFx(editor.selectedAudioClip()!.fx)).toBe(false);
    editor.redo();
    editor.updateAudioFx(sel!.id, { phone: 0.7, gainDb: -3 });
    await editor.saveToFile();
    const saved = parseProjectFile(disk.get('Монтаж.vcut')!);
    const clip = saved.timeline.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect(clip.audioFx).toEqual({ gainDb: -3, phone: 0.7, reverb: { preset: 'hall', mix: 0.3 } });
    expect(parseProjectFile(serializeProjectFile(saved))).toEqual(saved);
  });

  it('эффекты сброшены в ноль: поле в клипе не хранится', async () => {
    const { editor } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    editor.appendAsset(id);
    const a = editor.selectedAudioClip()!.id;
    editor.updateAudioFx(a, { phone: 1 });
    editor.updateAudioFx(a, { phone: 0 });
    const clip = editor.timeline.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect('audioFx' in clip).toBe(false);
  });
});
