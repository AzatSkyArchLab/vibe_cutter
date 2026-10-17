import { describe, expect, it } from 'vitest';
import {
  addTrack, appendAtEnd, deleteEmptyTracks, deleteTrack, overwrite, placementsForAsset, tracksOfKind, trackName, withLinked,
} from '../src/domain/timeline';
import { asset, setup, valid } from './helpers';

const A = asset('A', 10);

function withTracks() {
  const s = setup();
  let tl = appendAtEnd(s.tl, placementsForAsset(s.tl, A, { video: s.v1, audio: s.a1 }), s.ids).timeline;
  tl = addTrack(addTrack(tl, 'video', s.ids), 'video', s.ids); // V1 V2 V3
  tl = addTrack(tl, 'audio', s.ids); // A1 A2
  const [v1, v2, v3] = tracksOfKind(tl, 'video');
  tl = overwrite(tl, 0, [{ trackId: v3!.id, assetId: A.id, sourceIn: 0, length: 30 }], s.ids).timeline;
  return { ...s, tl: valid(tl), v1: v1!, v2: v2!, v3: v3! };
}

describe('удаление дорожек', () => {
  it('удаляет дорожку вместе с клипами, остальные дорожки не трогает', () => {
    const { tl, v3 } = withTracks();
    const out = valid(deleteTrack(tl, v3.id));
    expect(tracksOfKind(out, 'video')).toHaveLength(2);
    expect(tracksOfKind(out, 'audio')).toHaveLength(2);
    expect(out.tracks.flatMap((t) => t.clips)).toHaveLength(2);
  });

  it('видео и звук удаляются раздельно; у оставшегося звука снимается связь', () => {
    const { tl, v1 } = withTracks();
    const audioClip = tracksOfKind(tl, 'audio')[0]!.clips[0]!;
    expect(withLinked(tl, [audioClip.id])).toHaveLength(2);
    const out = valid(deleteTrack(tl, v1.id));
    const left = tracksOfKind(out, 'audio')[0]!.clips[0]!;
    expect(left.id).toBe(audioClip.id);
    expect(left.linkId).toBeNull();
    expect(withLinked(out, [left.id])).toEqual([left.id]);
    // Номера дорожек пересчитываются: бывшая V2 стала V1.
    expect(trackName(out, tracksOfKind(out, 'video')[0]!.id)).toBe('V1');
  });

  it('последнюю дорожку вида удалить нельзя', () => {
    const s = setup();
    expect(() => deleteTrack(s.tl, s.v1)).toThrow(/хотя бы одна видеодорожка/);
    expect(() => deleteTrack(s.tl, s.a1)).toThrow(/хотя бы одна аудиодорожка/);
  });

  it('«удалить пустые» убирает только пустые дорожки своего вида', () => {
    const { tl } = withTracks();
    const v = valid(deleteEmptyTracks(tl, 'video'));
    expect(tracksOfKind(v, 'video').map((t) => t.clips.length)).toEqual([1, 1]);
    expect(tracksOfKind(v, 'audio')).toHaveLength(2);
    const a = valid(deleteEmptyTracks(v, 'audio'));
    expect(tracksOfKind(a, 'audio')).toHaveLength(1);
    expect(deleteEmptyTracks(a, 'audio')).toBe(a);
  });

  it('если пусты все дорожки вида, остаётся первая', () => {
    const s = setup();
    const tl = addTrack(addTrack(s.tl, 'video', s.ids), 'video', s.ids);
    const out = deleteEmptyTracks(tl, 'video');
    expect(tracksOfKind(out, 'video').map((t) => t.id)).toEqual([s.v1]);
  });
});
