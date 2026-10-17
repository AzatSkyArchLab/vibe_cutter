import type { AssetId, MediaAsset } from './media';
import type { OutputSettings } from './export-preset';
import { type FitMode, type Project, findAsset } from './project';
import { type FrameRate, framesToSeconds } from './time';
import { type Clip, type ClipId, clipEnd, tracksOfKind } from './timeline';

/**
 * План рендера — плоское описание того, что движок должен сделать.
 * Не зависит от браузера: его же получит нативный движок на Mac.
 */

/** Кадры [from, to) выходного файла берутся подряд из одного исходника или чёрные. */
export interface VideoSpan {
  readonly from: number;
  readonly to: number;
  readonly source: { readonly assetId: AssetId; readonly sourceIn: number } | null;
}

/** Звук клипа, который нужно подмешать в [from, to) выходного файла. */
export interface AudioSpan {
  readonly clipId: ClipId;
  readonly assetId: AssetId;
  readonly from: number;
  readonly to: number;
  readonly sourceIn: number;
}

export interface RenderPlan {
  readonly output: OutputSettings;
  readonly fit: FitMode;
  readonly frameRate: FrameRate;
  readonly totalFrames: number;
  readonly assets: readonly MediaAsset[];
  readonly video: readonly VideoSpan[];
  readonly audio: readonly AudioSpan[];
  readonly warnings: readonly string[];
}

export class RenderPlanError extends Error {}

/**
 * Время в исходнике, кадр которого показывается в кадре таймлайна `frame`
 * (считая от начала исходника). Берём середину периода кадра: так переменная
 * частота iPhone и исходники с другой частотой дают стабильный выбор кадра,
 * а погрешность float не «проваливает» в предыдущий кадр. Превью и рендер
 * обязаны использовать именно эту функцию, чтобы показывать одно и то же.
 */
export const videoSourceTime = (asset: MediaAsset, sourceFrame: number, rate: FrameRate): number =>
  asset.startTime + framesToSeconds(sourceFrame + 0.5, rate);

/** Время в исходнике, с которого начинается звук кадра `sourceFrame`. */
export const audioSourceTime = (asset: MediaAsset, sourceFrame: number, rate: FrameRate): number =>
  asset.startTime + framesToSeconds(sourceFrame, rate);

export function buildRenderPlan(
  project: Project,
  output: OutputSettings,
  range?: { from: number; to: number },
): RenderPlan {
  const tl = project.timeline;
  const rate = tl.frameRate;
  if (output.frameRate.num * rate.den !== rate.num * output.frameRate.den)
    throw new RenderPlanError('Частота кадров рендера должна совпадать с таймлайном');

  const end = Math.max(0, ...tl.tracks.flatMap((t) => t.clips.map(clipEnd)));
  const from = Math.max(0, range?.from ?? 0);
  const to = Math.min(end, range?.to ?? end);
  if (to <= from) throw new RenderPlanError('Таймлайн пуст — рендерить нечего');

  // Видео: в каждом кадре виден верхний клип. Режем таймлайн по всем границам клипов.
  const videoTracks = tracksOfKind(tl, 'video');
  const cuts = new Set([from, to]);
  for (const t of videoTracks)
    for (const c of t.clips) {
      if (c.start > from && c.start < to) cuts.add(c.start);
      if (clipEnd(c) > from && clipEnd(c) < to) cuts.add(clipEnd(c));
    }
  const bounds = [...cuts].sort((a, b) => a - b);
  const video: VideoSpan[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    let top: Clip | null = null;
    for (let ti = videoTracks.length - 1; ti >= 0 && !top; ti--)
      top = videoTracks[ti]!.clips.find((c) => c.start <= a && clipEnd(c) >= b) ?? null;
    const source = top ? { assetId: top.assetId, sourceIn: top.sourceIn + (a - top.start) } : null;
    const prev = video[video.length - 1];
    const continues =
      prev &&
      ((prev.source === null && source === null) ||
        (prev.source && source && prev.source.assetId === source.assetId && prev.source.sourceIn + (prev.to - prev.from) === source.sourceIn));
    if (continues) video[video.length - 1] = { ...prev, to: b };
    else video.push({ from: a, to: b, source });
  }

  // Звук: все клипы аудиодорожек, пересекающие диапазон, — их смешает микшер.
  const audio: AudioSpan[] = [];
  // Соседние куски одного исходника без разрыва сливаются — иначе на месте
  // «пустого» реза микшер сделал бы лишнее затухание.
  for (const t of tracksOfKind(tl, 'audio')) {
    const trackFirst = audio.length;
    for (const c of t.clips) {
      const a = Math.max(c.start, from);
      const b = Math.min(clipEnd(c), to);
      if (b <= a) continue;
      const sourceIn = c.sourceIn + (a - c.start);
      const last = audio.length > trackFirst ? audio[audio.length - 1]! : null;
      if (last && last.assetId === c.assetId && last.to === a && last.sourceIn + (last.to - last.from) === sourceIn)
        audio[audio.length - 1] = { ...last, to: b };
      else audio.push({ clipId: c.id, assetId: c.assetId, from: a, to: b, sourceIn });
    }
  }

  // Сдвигаем всё к нулю выходного файла.
  const shiftedVideo = video.map((s) => ({ ...s, from: s.from - from, to: s.to - from }));
  const shiftedAudio = audio.map((s) => ({ ...s, from: s.from - from, to: s.to - from }));

  const used = new Set<AssetId>([
    ...shiftedVideo.flatMap((s) => (s.source ? [s.source.assetId] : [])),
    ...shiftedAudio.map((s) => s.assetId),
  ]);
  const assets: MediaAsset[] = [];
  const warnings: string[] = [];
  for (const id of used) {
    const asset = findAsset(project, id);
    if (!asset) throw new RenderPlanError(`Нет файла ${id}`);
    assets.push(asset);
    if (asset.video && !asset.video.decodable)
      throw new RenderPlanError(`Браузер не умеет декодировать видео «${asset.name}» (${asset.video.codec})`);
    if (shiftedAudio.some((s) => s.assetId === id) && asset.audio && !asset.audio.decodable)
      throw new RenderPlanError(`Браузер не умеет декодировать звук «${asset.name}» (${asset.audio.codec})`);
    if (asset.video?.hdr) warnings.push(`«${asset.name}»: HDR будет переведён в SDR`);
    if (asset.video?.variableFrameRate) warnings.push(`«${asset.name}»: переменная частота кадров будет приведена к постоянной`);
  }

  return {
    output,
    fit: project.settings.fit,
    frameRate: rate,
    totalFrames: to - from,
    assets,
    video: shiftedVideo,
    audio: shiftedAudio,
    warnings,
  };
}
