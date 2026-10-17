import type { AssetId, MediaAsset } from '../src/domain/media';
import { frameRate } from '../src/domain/time';
import { type Ids, type Timeline, emptyTimeline, validateTimeline } from '../src/domain/timeline';
import { sequentialIds } from '../src/domain/ids';
import { expect } from 'vitest';

export const R30 = frameRate(30);

export function asset(id: string, seconds: number, opts: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: id as AssetId,
    name: `${id}.mp4`,
    sizeBytes: 1,
    startTime: 0,
    duration: seconds,
    video: { codec: 'avc', width: 1920, height: 1080, frameRate: R30, variableFrameRate: false, hdr: false, decodable: true },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, decodable: true },
    ...opts,
  };
}

export function setup(): { ids: Ids; tl: Timeline; v1: Timeline['tracks'][number]['id']; a1: Timeline['tracks'][number]['id'] } {
  const ids = sequentialIds();
  const tl = emptyTimeline(R30, ids);
  return { ids, tl, v1: tl.tracks[0]!.id, a1: tl.tracks[1]!.id };
}

export function valid(tl: Timeline): Timeline {
  expect(validateTimeline(tl)).toEqual([]);
  return tl;
}

/** Компактная запись дорожки: [start, sourceIn, length] для каждого клипа. */
export const shape = (tl: Timeline, i: number) => tl.tracks[i]!.clips.map((c) => [c.start, c.sourceIn, c.length]);
