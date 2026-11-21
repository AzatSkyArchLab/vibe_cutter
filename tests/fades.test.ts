import { describe, expect, it } from 'vitest';
import { NO_FX, fadeEnvelope, fadeGain, sanitizeFx } from '../src/domain/audio-fx';
import { outputSettings } from '../src/domain/export-preset';
import type { Project } from '../src/domain/project';
import { buildRenderPlan } from '../src/domain/render-plan';
import { appendAtEnd, placementsForAsset, setAudioFx, splitAt, tracksOfKind } from '../src/domain/timeline';
import { Mixer, type PcmChunk, type SourceFeed } from '../src/engine/audio/mixer';
import { R30, asset, setup, valid } from './helpers';

describe('кривые появления и затухания', () => {
  it('все кривые идут от тишины к полной громкости', () => {
    for (const c of ['linear', 'smooth', 'fast', 'slow'] as const) {
      expect(fadeGain(c, 0)).toBeCloseTo(0, 9);
      expect(fadeGain(c, 1)).toBeCloseTo(1, 9);
      let prev = -1;
      for (let t = 0; t <= 1; t += 0.05) {
        const g = fadeGain(c, t);
        expect(g).toBeGreaterThanOrEqual(prev);
        prev = g;
      }
    }
  });

  it('формы различаются как в Vegas: быстрая выше линейной, медленная ниже', () => {
    expect(fadeGain('fast', 0.25)).toBeGreaterThan(fadeGain('linear', 0.25));
    expect(fadeGain('slow', 0.25)).toBeLessThan(fadeGain('linear', 0.25));
    expect(fadeGain('smooth', 0.5)).toBeCloseTo(0.5, 9);
  });

  it('огибающая клипа: появление в начале, затухание в конце, середина без изменений', () => {
    const fx = { ...NO_FX, fadeIn: 1, fadeInCurve: 'linear' as const, fadeOut: 2, fadeOutCurve: 'linear' as const };
    expect(fadeEnvelope(fx, 0.5, 10)).toBeCloseTo(0.5, 9);
    expect(fadeEnvelope(fx, 5, 10)).toBe(1);
    expect(fadeEnvelope(fx, 9, 10)).toBeCloseTo(0.5, 9);
  });

  it('появление и затухание длиннее клипа сжимаются пропорционально', () => {
    const fx = { ...NO_FX, fadeIn: 3, fadeInCurve: 'linear' as const, fadeOut: 1, fadeOutCurve: 'linear' as const };
    // клип 2 с: появление 1.5 с, затухание 0.5 с
    expect(fadeEnvelope(fx, 0.75, 2)).toBeCloseTo(0.5, 9);
    expect(fadeEnvelope(fx, 1.75, 2)).toBeCloseTo(0.5, 9);
  });
});

describe('ручки на таймлайне', () => {
  const A = asset('A', 10);
  const out = outputSettings({ target: 'youtube', width: 1920, height: 1080, frameRate: R30 });
  const fx = sanitizeFx({ fadeIn: 1, fadeOut: 2 });

  function withFades() {
    const s = setup();
    let tl = appendAtEnd(s.tl, placementsForAsset(s.tl, A, { video: s.v1, audio: s.a1 }), s.ids).timeline;
    const audio = tracksOfKind(tl, 'audio')[0]!.clips[0]!;
    tl = setAudioFx(tl, audio.id, fx);
    return { ...s, tl: valid(tl) };
  }
  const project = (timeline: Project['timeline']): Project => ({
    version: 1,
    name: 't',
    settings: { width: 1920, height: 1080, frameRate: R30, fit: 'fit' },
    assets: [A],
    timeline,
  });

  it('разрез: левая часть сохраняет появление, правая затухание', () => {
    const { tl, ids } = withFades();
    const cut = valid(splitAt(tl, 100, ids));
    const [left, right] = tracksOfKind(cut, 'audio')[0]!.clips;
    expect([left!.audioFx?.fadeIn, left!.audioFx?.fadeOut]).toEqual([1, 0]);
    expect([right!.audioFx?.fadeIn, right!.audioFx?.fadeOut]).toEqual([0, 2]);
  });

  it('куски с ручками не сливаются; границы клипа передаются в план, в том числе при рендере In/Out', () => {
    const { tl, ids } = withFades();
    const cut = splitAt(tl, 100, ids);
    expect(buildRenderPlan(project(cut), out).audio.map((a) => [a.from, a.to, a.clipStart, a.clipEnd])).toEqual([
      [0, 100, 0, 100],
      [100, 300, 100, 300],
    ]);
    const ranged = buildRenderPlan(project(tl), out, { from: 30, to: 90 });
    expect(ranged.audio.map((a) => [a.from, a.to, a.clipStart, a.clipEnd])).toEqual([[0, 60, -30, 270]]);
  });

  it('ручки не задаются видеоклипу', () => {
    const { tl } = withFades();
    const v = tracksOfKind(tl, 'video')[0]!.clips[0]!;
    expect(() => setAudioFx(tl, v.id, fx)).toThrow(/только звуковому/);
  });
});

describe('микшер: огибающая громкости', () => {
  const RATE = 48000;
  const constFeed = (total: number): SourceFeed => {
    let at = 0;
    return {
      sampleRate: RATE,
      async next(): Promise<PcmChunk | null> {
        if (at >= total) return null;
        const n = Math.min(4096, total - at);
        const c: PcmChunk = { index: at, channels: [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.5)] };
        at += n;
        return c;
      },
      close() {},
    };
  };

  it('линейное появление 1 с: на 0.5 с громкость ровно половина, затем полная', async () => {
    const fx = sanitizeFx({ fadeIn: 1, fadeInCurve: 'linear' });
    const m = new Mixer([{ outStart: 0, outEnd: RATE * 2, sourceTime: 0, open: async () => constFeed(RATE * 3), fx, clipStart: 0, clipEnd: RATE * 2 }], RATE, RATE * 2);
    const out: number[] = [];
    for (let b; (b = await m.nextBlock(4800)); ) out.push(...b.channels[0]);
    expect(out[RATE / 2]!).toBeCloseTo(0.25, 3);
    expect(out[Math.round(RATE * 1.5)]!).toBeCloseTo(0.5, 6);
    expect(Math.abs(out[1]!)).toBeLessThan(0.001);
  });

  it('кусок из середины клипа считает кривую от края клипа, а не куска', async () => {
    const fx = sanitizeFx({ fadeIn: 2, fadeInCurve: 'linear' });
    // кусок начинается через 1 с после начала клипа
    const m = new Mixer([{ outStart: 0, outEnd: RATE, sourceTime: 0, open: async () => constFeed(RATE * 2), fx, clipStart: -RATE, clipEnd: RATE }], RATE, RATE);
    const out: number[] = [];
    for (let b; (b = await m.nextBlock(4800)); ) out.push(...b.channels[0]);
    expect(out[RATE / 2]!).toBeCloseTo(0.5 * 0.75, 3);
  });
});
