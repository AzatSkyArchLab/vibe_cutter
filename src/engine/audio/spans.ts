import type { AssetId, MediaAsset } from '../../domain/media';
import { type RenderPlan, audioSourceTime } from '../../domain/render-plan';
import { framesToSeconds } from '../../domain/time';
import type { MediaInputs } from '../media-input';
import { openAudioFeed } from './feed';
import type { MixSpan } from './mixer';

/** Отсчёт выхода, с которого начинается кадр `frame`. */
export const frameToSample = (plan: RenderPlan, frame: number, outRate: number): number =>
  Math.round((frame * outRate * plan.frameRate.den) / plan.frameRate.num);

/** Куски звука плана для микшера — общие для рендера и воспроизведения. */
export function mixSpansFor(plan: RenderPlan, inputs: MediaInputs<AssetId>, outRate: number): MixSpan[] {
  const assets = new Map<AssetId, MediaAsset>(plan.assets.map((a) => [a.id, a]));
  return plan.audio.map((span) => {
    const asset = assets.get(span.assetId)!;
    const sourceTime = audioSourceTime(asset, span.sourceIn, plan.frameRate);
    const length = framesToSeconds(span.to - span.from, plan.frameRate);
    return {
      outStart: frameToSample(plan, span.from, outRate),
      outEnd: frameToSample(plan, span.to, outRate),
      sourceTime,
      // Небольшой запас по краям нужен окну ресемплера.
      open: async () => openAudioFeed(await inputs.get(span.assetId).audioSamples(), sourceTime - 0.05, sourceTime + length + 0.05),
    };
  });
}
