import { describe, expect, it } from 'vitest';
import {
  addTrack, appendAtEnd, insert, lift, moveClips, overwrite, placementsForAsset, rippleDelete,
  rippleDeleteRange, splitAt, splitClipsAt, timelineEnd, trimEnd, trimStart, withLinked,
} from '../src/domain/timeline';
import { asset, setup, shape, valid } from './helpers';

const A = asset('A', 10); // 300 кадров
const B = asset('B', 4); // 120 кадров
const len = (id: string) => (id === 'A' ? 300 : 120);

function twoClips() {
  const s = setup();
  let tl = appendAtEnd(s.tl, placementsForAsset(s.tl, A, { video: s.v1, audio: s.a1 }), s.ids).timeline;
  tl = appendAtEnd(tl, placementsForAsset(tl, B, { video: s.v1, audio: s.a1 }), s.ids).timeline;
  return { ...s, tl: valid(tl) };
}

describe('размещение', () => {
  it('append кладёт связанные видео и звук встык', () => {
    const { tl } = twoClips();
    expect(shape(tl, 0)).toEqual([[0, 0, 300], [300, 0, 120]]);
    expect(shape(tl, 1)).toEqual(shape(tl, 0));
    const [v, a] = [tl.tracks[0]!.clips[0]!, tl.tracks[1]!.clips[0]!];
    expect(v.linkId).not.toBeNull();
    expect(v.linkId).toBe(a.linkId);
    expect(tl.tracks[0]!.clips[1]!.linkId).not.toBe(v.linkId);
  });

  it('overwrite затирает середину, разрезая клип', () => {
    const { tl, ids, v1 } = twoClips();
    const out = valid(overwrite(tl, 100, [{ trackId: v1, assetId: B.id, sourceIn: 0, length: 50 }], ids).timeline);
    expect(shape(out, 0)).toEqual([[0, 0, 100], [100, 0, 50], [150, 150, 150], [300, 0, 120]]);
    expect(shape(out, 1)).toEqual(shape(tl, 1)); // звук не тронут
  });

  it('insert раздвигает все дорожки', () => {
    const { tl, ids, v1, a1 } = twoClips();
    const out = valid(insert(tl, 100, placementsForAsset(tl, B, { video: v1, audio: a1 }, { sourceIn: 10, length: 20 }), ids).timeline);
    expect(shape(out, 0)).toEqual([[0, 0, 100], [100, 10, 20], [120, 100, 200], [320, 0, 120]]);
    expect(shape(out, 1)).toEqual(shape(out, 0));
    expect(timelineEnd(out)).toBe(440);
  });
});

describe('резы и удаление', () => {
  it('split режет все дорожки и сохраняет связь правых половин', () => {
    const { tl, ids } = twoClips();
    const out = valid(splitAt(tl, 100, ids));
    expect(shape(out, 0)).toEqual([[0, 0, 100], [100, 100, 200], [300, 0, 120]]);
    const rightV = out.tracks[0]!.clips[1]!;
    const rightA = out.tracks[1]!.clips[1]!;
    expect(rightV.linkId).toBe(rightA.linkId);
    expect(rightV.linkId).not.toBe(out.tracks[0]!.clips[0]!.linkId);
  });

  it('split на стыке ничего не меняет', () => {
    const { tl, ids } = twoClips();
    expect(splitAt(tl, 300, ids)).toBe(tl);
  });

  it('split выбранного клипа не трогает другие дорожки', () => {
    const { tl, ids } = twoClips();
    const tl2 = valid(addTrack(tl, 'video', ids));
    const v2 = tl2.tracks[1]!.id;
    const withV2 = overwrite(tl2, 50, [{ trackId: v2, assetId: B.id, sourceIn: 0, length: 100 }], ids).timeline;
    const v2clip = withV2.tracks[1]!.clips[0]!.id;
    const out = valid(splitClipsAt(withV2, 80, [v2clip], ids));
    expect(shape(out, 1)).toEqual([[50, 0, 30], [80, 30, 70]]);
    expect(shape(out, 0)).toEqual(shape(withV2, 0));
  });

  it('lift оставляет пустоту, ripple delete закрывает её на видео и звуке', () => {
    const { tl, ids } = twoClips();
    const cut = splitAt(splitAt(tl, 100, ids), 200, ids);
    const mid = withLinked(cut, [cut.tracks[0]!.clips[1]!.id]);
    expect(mid).toHaveLength(2);
    expect(shape(valid(lift(cut, mid)), 0)).toEqual([[0, 0, 100], [200, 200, 100], [300, 0, 120]]);
    const rippled = valid(rippleDelete(cut, mid));
    expect(shape(rippled, 0)).toEqual([[0, 0, 100], [100, 200, 100], [200, 0, 120]]);
    expect(shape(rippled, 1)).toEqual(shape(rippled, 0));
  });

  it('ripple delete диапазона In/Out', () => {
    const { tl, ids } = twoClips();
    const out = valid(rippleDeleteRange(tl, 250, 350, ids));
    expect(shape(out, 0)).toEqual([[0, 0, 250], [250, 50, 70]]);
    expect(shape(out, 1)).toEqual(shape(out, 0));
  });
});

describe('подрезка и перемещение', () => {
  it('trimStart упирается в соседа и в начало исходника, двигает и звук', () => {
    const { tl, ids } = twoClips();
    const second = tl.tracks[0]!.clips[1]!.id;
    const trimmed = valid(trimStart(tl, second, 30));
    expect(shape(trimmed, 0)[1]).toEqual([330, 30, 90]);
    expect(shape(trimmed, 1)[1]).toEqual([330, 30, 90]);
    // назад можно вернуть только 30 кадров исходника
    expect(shape(valid(trimStart(trimmed, second, -100)), 0)[1]).toEqual([300, 0, 120]);
    // не короче кадра
    expect(shape(valid(trimStart(tl, second, 1000)), 0)[1]).toEqual([419, 119, 1]);
    void ids;
  });

  it('trimEnd не залезает на соседа и не выходит за исходник', () => {
    const { tl, ids } = twoClips();
    const first = tl.tracks[0]!.clips[0]!.id;
    expect(shape(trimEnd(tl, first, 50, len), 0)[0]).toEqual([0, 0, 300]);
    const lifted = lift(tl, withLinked(tl, [tl.tracks[0]!.clips[1]!.id]));
    const short = trimEnd(lifted, first, -100, len);
    expect(shape(short, 0)[0]).toEqual([0, 0, 200]);
    expect(shape(valid(trimEnd(short, first, 500, len)), 0)[0]).toEqual([0, 0, 300]);
    void ids;
  });

  it('move двигает пару и затирает место назначения', () => {
    const { tl, ids } = twoClips();
    const second = tl.tracks[0]!.clips[1]!.id;
    const out = valid(moveClips(tl, [second], -100, ids));
    expect(shape(out, 0)).toEqual([[0, 0, 200], [200, 0, 120]]);
    expect(shape(out, 1)).toEqual(shape(out, 0));
  });

  it('move на дорожку выше', () => {
    const { tl, ids } = twoClips();
    const tl2 = addTrack(tl, 'video', ids);
    const second = tl2.tracks[0]!.clips[1]!.id;
    const out = valid(moveClips(tl2, [second], 0, ids, { video: 1 }));
    expect(shape(out, 0)).toEqual([[0, 0, 300]]);
    expect(shape(out, 1)).toEqual([[300, 0, 120]]);
    expect(shape(out, 2)).toEqual([[0, 0, 300], [300, 0, 120]]); // A1 на месте
  });

  it('move не уходит левее нуля', () => {
    const { tl, ids } = twoClips();
    const first = tl.tracks[0]!.clips[0]!.id;
    expect(moveClips(tl, [first], -50, ids)).toBe(tl);
  });
});
