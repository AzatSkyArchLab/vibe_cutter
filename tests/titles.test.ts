import { describe, expect, it } from 'vitest';
import { outputSettings } from '../src/domain/export-preset';
import { parseProjectFile, serializeProjectFile, type Project } from '../src/domain/project';
import { buildRenderPlan } from '../src/domain/render-plan';
import { defaultTitle, sanitizeTitle, titleOpacity } from '../src/domain/title';
import {
  addTrack, appendAtEnd, layersAt, moveClips, overwrite, placementsForAsset, splitAt, trimEnd, trimStart, validateTimeline,
} from '../src/domain/timeline';
import { R30, asset, setup, shape, valid } from './helpers';

const A = asset('A', 10);
const out = outputSettings({ target: 'youtube', width: 1920, height: 1080, frameRate: R30 });
const len = () => 300;

/** Видео A на V1 (0..300) и титр на V2 в [from, from+length). */
function withTitle(from = 60, length = 90, template: 'center' | 'lower-left' = 'center') {
  const s = setup();
  let tl = appendAtEnd(s.tl, placementsForAsset(s.tl, A, { video: s.v1, audio: s.a1 }), s.ids).timeline;
  tl = addTrack(tl, 'video', s.ids);
  const v2 = tl.tracks[1]!.id;
  const r = overwrite(tl, from, [{ trackId: v2, assetId: null, title: defaultTitle(template), sourceIn: 0, length }], s.ids);
  return { ...s, tl: valid(r.timeline), titleId: r.created[0]!, v2 };
}

const project = (timeline: Project['timeline']): Project => ({
  version: 1,
  name: 't',
  settings: { width: 1920, height: 1080, frameRate: R30, fit: 'fit' },
  assets: [A],
  timeline,
});

describe('титры на таймлайне', () => {
  it('титр поверх видео: основа — видео, титр — слой сверху', () => {
    const { tl } = withTitle();
    expect(layersAt(tl, 30).overlays).toHaveLength(0);
    const l = layersAt(tl, 100);
    expect(l.base?.assetId).toBe('A');
    expect(l.overlays.map((c) => c.title?.template)).toEqual(['center']);
  });

  it('видео на дорожке выше перекрывает титр снизу (как в Resolve)', () => {
    const s = setup();
    let tl = addTrack(s.tl, 'video', s.ids);
    tl = overwrite(tl, 0, [{ trackId: s.v1, assetId: null, title: defaultTitle('center'), sourceIn: 0, length: 100 }], s.ids).timeline;
    tl = overwrite(tl, 0, [{ trackId: tl.tracks[1]!.id, assetId: A.id, sourceIn: 0, length: 100 }], s.ids).timeline;
    const l = layersAt(valid(tl), 10);
    expect(l.base?.assetId).toBe('A');
    expect(l.overlays).toHaveLength(0);
  });

  it('план рендера: титр делит кадры на куски, номер кадра титра идёт непрерывно', () => {
    const { tl } = withTitle(60, 90);
    const plan = buildRenderPlan(project(tl), out);
    expect(plan.video.map((v) => [v.from, v.to, v.source?.sourceIn, v.overlays.map((o) => o.offset)])).toEqual([
      [0, 60, 0, []],
      [60, 150, 60, [0]],
      [150, 300, 150, []],
    ]);
    expect(plan.video[1]!.overlays[0]!.length).toBe(90);
    // Звук титры не трогают.
    expect(plan.audio.map((a) => [a.from, a.to])).toEqual([[0, 300]]);
  });

  it('титр без видео под ним рисуется на чёрном', () => {
    const s = setup();
    const tl = overwrite(s.tl, 0, [{ trackId: s.v1, assetId: null, title: defaultTitle('center'), sourceIn: 0, length: 45 }], s.ids).timeline;
    const plan = buildRenderPlan(project(valid(tl)), out);
    expect(plan.totalFrames).toBe(45);
    expect(plan.video).toEqual([{ from: 0, to: 45, source: null, overlays: [expect.objectContaining({ offset: 0, length: 45 })] }]);
    expect(plan.audio).toEqual([]);
    expect(plan.assets).toEqual([]);
  });

  it('разрез титра даёт два независимых титра с отдельным появлением', () => {
    const { tl, ids } = withTitle(60, 90);
    const cut = valid(splitAt(tl, 100, ids));
    const plan = buildRenderPlan(project(cut), out);
    expect(plan.video.map((v) => [v.from, v.to, v.overlays.map((o) => [o.offset, o.length])])).toEqual([
      [0, 60, []],
      [60, 100, [[0, 40]]],
      [100, 150, [[0, 50]]],
      [150, 300, []],
    ]);
  });

  it('титр растягивается в обе стороны без ограничения исходником', () => {
    const { tl, titleId } = withTitle(60, 90);
    const longer = valid(trimEnd(trimStart(tl, titleId, -60), titleId, 500, len));
    expect(shape(longer, 1)).toEqual([[0, 0, 650]]);
  });

  it('титр можно двигать, но не на аудиодорожку', () => {
    const { tl, titleId, ids } = withTitle(60, 90);
    const moved = valid(moveClips(tl, [titleId], 30, ids, { audio: 1 }));
    expect(shape(moved, 1)).toEqual([[90, 0, 90]]);
    expect(moved.tracks.find((t) => t.kind === 'audio')!.clips).toHaveLength(1);
  });

  it('проверка таймлайна ловит клип и без файла, и без титра', () => {
    const { tl } = withTitle();
    const broken = { ...tl, tracks: tl.tracks.map((t, i) => (i === 1 ? { ...t, clips: t.clips.map((c) => ({ ...c, title: undefined })) } : t)) };
    expect(validateTimeline(broken).join()).toMatch(/либо файлом, либо титром/);
  });
});

describe('оформление титра', () => {
  it('появление и исчезновение', () => {
    const t = { ...defaultTitle('center'), fadeIn: 1, fadeOut: 1 };
    const fps = 30;
    expect(titleOpacity(t, 0, 300, fps)).toBeCloseTo(1 / 31, 6);
    expect(titleOpacity(t, 15, 300, fps)).toBeCloseTo(16 / 31, 6);
    expect(titleOpacity(t, 150, 300, fps)).toBe(1);
    expect(titleOpacity(t, 299, 300, fps)).toBeCloseTo(1 / 31, 6);
    expect(titleOpacity({ ...t, fadeIn: 0, fadeOut: 0 }, 0, 300, fps)).toBe(1);
  });

  it('значения из файла приводятся к допустимым', () => {
    const t = sanitizeTitle({ template: 'lower-left', size: 9999, color: 'red', backgroundOpacity: -3, text: 'Привет' } as never);
    expect(t.template).toBe('lower-left');
    expect(t.size).toBe(40);
    expect(t.color).toBe('#ffffff');
    expect(t.backgroundOpacity).toBe(0);
    expect(t.text).toBe('Привет');
    expect(sanitizeTitle({ template: 'нечто' } as never).template).toBe('center');
  });

  it('титры сохраняются в файл проекта и читаются обратно', () => {
    const { tl } = withTitle(10, 20, 'lower-left');
    const p = project(tl);
    expect(parseProjectFile(serializeProjectFile(p))).toEqual(p);
  });
});
