import { newAssetId, randomIds } from '../domain/ids';
import type { AssetId, MediaAsset } from '../domain/media';
import { outputSettings, type VideoCodecChoice } from '../domain/export-preset';
import { newProject, type FitMode, type Project } from '../domain/project';
import { buildRenderPlan } from '../domain/render-plan';
import { frameRate } from '../domain/time';
import { addTrack, appendAtEnd, lift, overwrite, placementsForAsset, splitAt, withLinked } from '../domain/timeline';
import { probeMedia } from '../engine/probe';
import { WorkerRenderEngine } from '../engine/render-client';
import { inspectRender, makeTestVideo } from './test-media';

/**
 * Сквозная проверка рендера: тестовые исходники → таймлайн с резами,
 * пустотой и верхней дорожкой → рендер в воркере → покадровая сверка.
 */
export async function runRenderCheck(opts: { width?: number; height?: number; codec?: VideoCodecChoice; fit?: FitMode } = {}) {
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const rate = frameRate(30);
  const t0 = performance.now();

  const fileA = await makeTestVideo({ width: 1920, height: 1080, fps: 30, frames: 150, name: 'A.mp4' });
  const fileB = await makeTestVideo({ width: 1280, height: 720, fps: 30, frames: 120, sampleRate: 44100, jitter: 0.2, name: 'B_vfr_44k.mp4' });
  const genSec = (performance.now() - t0) / 1000;

  const files = new Map<AssetId, File>();
  const assets: MediaAsset[] = [];
  for (const f of [fileA, fileB]) {
    const asset: MediaAsset = { id: newAssetId(), ...(await probeMedia(f)) };
    assets.push(asset);
    files.set(asset.id, f);
  }
  const [A, B] = assets as [MediaAsset, MediaAsset];

  const ids = randomIds;
  let p: Project = newProject('check', { width, height, frameRate: rate, fit: opts.fit ?? 'fit' }, ids);
  p = { ...p, assets };
  const [v1, a1] = [p.timeline.tracks[0]!.id, p.timeline.tracks[1]!.id];
  let tl = appendAtEnd(p.timeline, placementsForAsset(p.timeline, A, { video: v1, audio: a1 }, { sourceIn: 0, length: 70 }), ids).timeline;
  tl = appendAtEnd(tl, placementsForAsset(tl, B, { video: v1, audio: a1 }, { sourceIn: 25, length: 50 }), ids).timeline;
  tl = appendAtEnd(tl, placementsForAsset(tl, A, { video: v1, audio: a1 }, { sourceIn: 95, length: 50 }), ids).timeline;
  // Дыра 100..110 и клип B поверх на V2 в 140..155.
  tl = splitAt(splitAt(tl, 100, ids), 110, ids);
  tl = lift(tl, withLinked(tl, [tl.tracks[0]!.clips.find((c) => c.start === 100)!.id]));
  tl = addTrack(tl, 'video', ids);
  tl = overwrite(tl, 140, [{ trackId: tl.tracks[1]!.id, assetId: B.id, sourceIn: 3, length: 15 }], ids).timeline;
  p = { ...p, timeline: tl };

  const settings = outputSettings({ target: 'youtube', width, height, frameRate: rate, codec: opts.codec });
  const plan = buildRenderPlan(p, settings);
  const engine = new WorkerRenderEngine();
  const support = await engine.check(settings);
  if (!support.ok) return { ok: false, problems: support.problems };

  const r0 = performance.now();
  const { stats, blob } = await engine.render(plan, files, { kind: 'memory' }, () => {}).done;
  const renderSec = (performance.now() - r0) / 1000;
  const out = await inspectRender(blob!, 30);

  // Ожидаемый номер кадра исходника в каждом выходном кадре.
  const expected: number[] = [];
  for (const s of plan.video) for (let i = 0; i < s.to - s.from; i++) expected.push(s.source ? s.source.sourceIn + i : -1);
  const mismatches = expected.flatMap((e, k) => (out.frameIndices[k] === e ? [] : [{ k, expected: e, got: out.frameIndices[k] }]));

  // Ожидаемые щелчки: начало звука каждого кадра исходника с номером, кратным 30.
  const expectedClicks: number[] = [];
  for (const s of plan.audio) for (let i = 0; i < s.to - s.from; i++) if ((s.sourceIn + i) % 30 === 0) expectedClicks.push(s.from + i);

  return {
    ok: mismatches.length === 0 && out.frameIndices.length === plan.totalFrames && JSON.stringify(out.clickFrames) === JSON.stringify(expectedClicks),
    totalFrames: plan.totalFrames,
    decodedFrames: out.frameIndices.length,
    mismatches: mismatches.slice(0, 10),
    expectedClicks,
    clickFrames: out.clickFrames,
    videoDuration: out.videoDuration,
    audioDuration: out.audioDuration,
    audioSampleRate: out.audioSampleRate,
    codecs: [out.videoCodec, out.audioCodec],
    size: [out.width, out.height],
    colorSpace: out.colorSpace,
    moovBeforeMdat: out.moovBeforeMdat,
    probedB: { fps: B.video?.frameRate, vfr: B.video?.variableFrameRate, audioRate: B.audio?.sampleRate },
    warnings: plan.warnings,
    genSec,
    renderSec,
    renderFps: stats.frames / renderSec,
    bytes: blob!.size,
  };
}
