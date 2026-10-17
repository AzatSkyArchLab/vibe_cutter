import type { AssetId } from './media';
import type { ClipId, Ids, LinkId, TrackId } from './timeline';

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export const randomIds: Ids = {
  clip: () => uid('c') as ClipId,
  link: () => uid('l') as LinkId,
  track: () => uid('t') as TrackId,
};

export const newAssetId = (): AssetId => uid('a') as AssetId;

/** Предсказуемые id для тестов. */
export function sequentialIds(): Ids {
  let n = 0;
  return {
    clip: () => `c${++n}` as ClipId,
    link: () => `l${++n}` as LinkId,
    track: () => `t${++n}` as TrackId,
  };
}
