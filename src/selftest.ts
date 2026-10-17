import type { RenderEngine } from './application/ports';
import { outputSettings } from './domain/export-preset';
import type { RenderPlan } from './domain/render-plan';
import { frameRate } from './domain/time';
import { defaultTitle } from './domain/title';
import { probeMedia } from './engine/probe';

/**
 * Самопроверка приложения для Mac (запускается при VIBE_SELFTEST=1):
 * настоящий рендер секунды видео с титром через воркер и чтение результата.
 */
export async function selfTest(engine: RenderEngine): Promise<Record<string, unknown>> {
  const rate = frameRate(30);
  const output = outputSettings({ target: 'file' as never, width: 1280, height: 720, frameRate: rate });
  const support = await engine.check(output);
  const plan: RenderPlan = {
    output,
    fit: 'fit',
    frameRate: rate,
    totalFrames: 30,
    assets: [],
    video: [{ from: 0, to: 30, source: null, overlays: [{ clipId: 't' as never, title: defaultTitle('center'), offset: 0, length: 30 }] }],
    audio: [],
    includeAudio: true,
    warnings: [],
  };
  const { blob, stats } = await engine.render(plan, new Map(), { kind: 'memory' }, () => {}).done;
  const meta = await probeMedia(new File([blob!], 'selftest.mp4', { type: 'video/mp4' }));
  return {
    encodeSupport: support.ok,
    problems: support.problems,
    rendered: stats.frames === 30,
    bytes: blob?.size ?? 0,
    readBack: meta.video?.width === 1280 && Math.abs(meta.duration - 1) < 0.05 && meta.audio?.codec === 'aac',
  };
}
