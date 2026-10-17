import { describe, expect, it } from 'vitest';
import { outputSettings } from '../src/domain/export-preset';
import type { Project } from '../src/domain/project';
import { buildRenderPlan, videoSourceTime } from '../src/domain/render-plan';
import { addTrack, appendAtEnd, lift, overwrite, placementsForAsset, splitAt, withLinked } from '../src/domain/timeline';
import { R30, asset, setup } from './helpers';

const A = asset('A', 10);
const B = asset('B', 4, { audio: null });
const out = outputSettings({ target: 'youtube', width: 1920, height: 1080, frameRate: R30 });

function project(build: (s: ReturnType<typeof setup>) => Project['timeline']): Project {
  const s = setup();
  return {
    version: 1,
    name: 't',
    settings: { width: 1920, height: 1080, frameRate: R30, fit: 'fit' },
    assets: [A, B],
    timeline: build(s),
  };
}

describe('план рендера', () => {
  it('склейка с пустотой и верхней дорожкой', () => {
    const p = project(({ tl, ids, v1, a1 }) => {
      let t = appendAtEnd(tl, placementsForAsset(tl, A, { video: v1, audio: a1 }), ids).timeline;
      t = splitAt(splitAt(t, 100, ids), 150, ids);
      t = lift(t, withLinked(t, [t.tracks[0]!.clips[1]!.id])); // дыра 100..150
      t = addTrack(t, 'video', ids);
      return overwrite(t, 200, [{ trackId: t.tracks[1]!.id, assetId: B.id, sourceIn: 10, length: 30 }], ids).timeline;
    });
    const plan = buildRenderPlan(p, out);
    expect(plan.totalFrames).toBe(300);
    expect(plan.video).toEqual([
      { from: 0, to: 100, source: { assetId: 'A', sourceIn: 0 } },
      { from: 100, to: 150, source: null },
      { from: 150, to: 200, source: { assetId: 'A', sourceIn: 150 } },
      { from: 200, to: 230, source: { assetId: 'B', sourceIn: 10 } },
      { from: 230, to: 300, source: { assetId: 'A', sourceIn: 230 } },
    ]);
    expect(plan.audio.map((a) => [a.from, a.to, a.sourceIn])).toEqual([[0, 100, 0], [150, 300, 150]]);
  });

  it('разрез без изменений сливается в один непрерывный кусок', () => {
    const p = project(({ tl, ids, v1, a1 }) =>
      splitAt(appendAtEnd(tl, placementsForAsset(tl, A, { video: v1, audio: a1 }), ids).timeline, 100, ids),
    );
    expect(buildRenderPlan(p, out).video).toEqual([{ from: 0, to: 300, source: { assetId: 'A', sourceIn: 0 } }]);
  });

  it('диапазон In/Out сдвигается к нулю', () => {
    const p = project(({ tl, ids, v1, a1 }) => appendAtEnd(tl, placementsForAsset(tl, A, { video: v1, audio: a1 }), ids).timeline);
    const plan = buildRenderPlan(p, out, { from: 30, to: 90 });
    expect(plan.totalFrames).toBe(60);
    expect(plan.video).toEqual([{ from: 0, to: 60, source: { assetId: 'A', sourceIn: 30 } }]);
    expect(plan.audio.map((a) => [a.from, a.to, a.sourceIn])).toEqual([[0, 60, 30]]);
  });

  it('пустой таймлайн — ошибка', () => {
    expect(() => buildRenderPlan(project(({ tl }) => tl), out)).toThrow(/пуст/);
  });

  it('HDR и VFR дают предупреждения', () => {
    const hdr = asset('A', 10, { video: { ...A.video!, hdr: true, variableFrameRate: true } });
    const p = { ...project(({ tl, ids, v1, a1 }) => appendAtEnd(tl, placementsForAsset(tl, hdr, { video: v1, audio: a1 }), ids).timeline), assets: [hdr] };
    expect(buildRenderPlan(p, out).warnings).toHaveLength(2);
  });

  it('время кадра в исходнике — середина периода, со сдвигом начала файла', () => {
    expect(videoSourceTime({ ...A, startTime: 0.5 }, 3, R30)).toBeCloseTo(0.5 + 3.5 / 30, 9);
  });
});

describe('план рендера: звук', () => {
  it('разрез без изменений не дробит звук', () => {
    const p = project(({ tl, ids, v1, a1 }) =>
      splitAt(appendAtEnd(tl, placementsForAsset(tl, A, { video: v1, audio: a1 }), ids).timeline, 100, ids),
    );
    expect(buildRenderPlan(p, out).audio.map((a) => [a.from, a.to, a.sourceIn])).toEqual([[0, 300, 0]]);
  });
});
