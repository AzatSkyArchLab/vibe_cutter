import type { VideoCodecChoice, OutputSettings } from './export-preset';
import type { MediaAsset } from './media';
import type { RenderPlan } from './render-plan';
import { assetLengthInFrames } from './timeline';
import { fpsValue } from './time';

/**
 * Сжатие отдельного файла. Расчёты здесь чистые: по длительности и желаемому
 * размеру — битрейт, по битрейту — разрешение, при котором картинка ещё хорошая.
 * Само сжатие делает тот же движок, что и рендер таймлайна (план из одного клипа).
 */

export type CompressMode = 'size' | 'quality' | 'remux';
export type QualityLevel = 'high' | 'medium' | 'low';
/** Короткая сторона кадра на выходе; 'auto' — подобрать под размер, 'source' — как в исходнике. */
export type ResolutionChoice = 'auto' | 'source' | 2160 | 1440 | 1080 | 720 | 540 | 480 | 360;

export interface CompressRequest {
  readonly mode: CompressMode;
  /** Желаемый размер файла в мегабайтах (10^6 байт, как показывает Finder). */
  readonly targetMB: number;
  readonly quality: QualityLevel;
  readonly resolution: ResolutionChoice;
  readonly codec: VideoCodecChoice;
  /** Битрейт звука, кбит/с. */
  readonly audioKbps: number;
}

export type QualityGrade = 'excellent' | 'good' | 'fair' | 'poor';

export interface CompressPlan {
  readonly width: number;
  readonly height: number;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  readonly codec: VideoCodecChoice;
  /** Ожидаемый размер файла, байт. */
  readonly estimatedBytes: number;
  /** Для режима «до размера» — предел, который нельзя превышать. */
  readonly targetBytes: number | null;
  /** Битов на пиксель в кадре — мерило качества при данном битрейте. */
  readonly bitsPerPixel: number;
  readonly grade: QualityGrade;
  readonly warnings: readonly string[];
}

export class CompressError extends Error {}

export const RESOLUTION_STEPS: readonly Exclude<ResolutionChoice, 'auto' | 'source'>[] = [2160, 1440, 1080, 720, 540, 480, 360];

/** Доля размера на служебные данные MP4 (индекс, заголовки) — с запасом. */
const CONTAINER_OVERHEAD = 0.012;
/** Минимальный разумный битрейт видео — ниже картинка превращается в кашу при любом разрешении. */
const MIN_VIDEO_BITRATE = 120_000;

/**
 * Битов на пиксель для оценок качества H.264. HEVC даёт ту же картинку примерно
 * на 35% меньшем битрейте, поэтому его пороги ниже.
 */
const BPP: Record<QualityLevel, number> = { high: 0.1, medium: 0.065, low: 0.04 };
const hevcFactor = (codec: VideoCodecChoice) => (codec === 'hevc' ? 0.65 : 1);

export function gradeFor(bpp: number, codec: VideoCodecChoice): QualityGrade {
  const b = bpp / hevcFactor(codec);
  if (b >= 0.09) return 'excellent';
  if (b >= 0.06) return 'good';
  if (b >= 0.035) return 'fair';
  return 'poor';
}

export const GRADE_LABELS: Record<QualityGrade, string> = {
  excellent: 'отличное',
  good: 'хорошее',
  fair: 'приемлемое',
  poor: 'низкое',
};

/** Размер кадра с короткой стороной `short`, с сохранением пропорций и чётными сторонами. */
export function scaledSize(width: number, height: number, short: number): { width: number; height: number } {
  const s = Math.min(width, height);
  if (short >= s) return { width: even(width), height: even(height) };
  const k = short / s;
  return { width: even(width * k), height: even(height * k) };
}

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

export function planCompression(source: MediaAsset, req: CompressRequest): CompressPlan {
  const v = source.video;
  if (!v) throw new CompressError('В файле нет видео');
  if (!(source.duration > 0)) throw new CompressError('Не удалось определить длительность файла');
  const fps = fpsValue(v.frameRate);
  const duration = source.duration;
  const audioBitrate = source.audio ? Math.round(req.audioKbps * 1000) : 0;
  const warnings: string[] = [];
  const pixelsPerSec = (w: number, h: number) => w * h * fps;
  const shortSide = Math.min(v.width, v.height);
  const sizes = (choice: ResolutionChoice) =>
    choice === 'source' || choice === 'auto' ? scaledSize(v.width, v.height, shortSide) : scaledSize(v.width, v.height, choice);

  let width: number;
  let height: number;
  let videoBitrate: number;
  let targetBytes: number | null = null;

  if (req.mode === 'size') {
    if (!(req.targetMB > 0)) throw new CompressError('Укажите размер файла');
    targetBytes = Math.floor(req.targetMB * 1e6);
    const budgetBits = targetBytes * 8 * (1 - CONTAINER_OVERHEAD) - audioBitrate * duration;
    videoBitrate = Math.floor(budgetBits / duration);
    if (videoBitrate < MIN_VIDEO_BITRATE) {
      const minMB = ((MIN_VIDEO_BITRATE + audioBitrate) * duration) / 8 / (1 - CONTAINER_OVERHEAD) / 1e6;
      throw new CompressError(`Слишком маленький размер для ${Math.round(duration)} с видео. Минимум ≈ ${Math.ceil(minMB)} МБ`);
    }
    if (req.resolution === 'auto') {
      // Самое большое разрешение (не больше исходного), при котором качество не ниже «хорошего».
      const candidates = [shortSide, ...RESOLUTION_STEPS.filter((s) => s < shortSide)];
      const good = candidates.find((s) => {
        const sz = scaledSize(v.width, v.height, s);
        return videoBitrate / pixelsPerSec(sz.width, sz.height) >= 0.06 * hevcFactor(req.codec);
      });
      ({ width, height } = scaledSize(v.width, v.height, good ?? candidates[candidates.length - 1]!));
    } else ({ width, height } = sizes(req.resolution));
    if (targetBytes >= source.sizeBytes) warnings.push('Исходный файл уже меньше этого размера — сжимать не обязательно. Чтобы только сменить формат, выберите «Сменить формат».');
  } else if (req.mode === 'quality') {
    ({ width, height } = sizes(req.resolution === 'auto' ? 'source' : req.resolution));
    videoBitrate = Math.round(pixelsPerSec(width, height) * BPP[req.quality] * hevcFactor(req.codec));
    // Не раздуваем файл: битрейт не выше исходного (с учётом звука).
    const sourceVideoBitrate = (source.sizeBytes * 8) / duration - audioBitrate;
    if (sourceVideoBitrate > 0 && videoBitrate > sourceVideoBitrate * 0.92) {
      videoBitrate = Math.max(MIN_VIDEO_BITRATE, Math.round(sourceVideoBitrate * 0.92));
      warnings.push('Исходник уже сжат сильнее выбранного качества — битрейт оставлен чуть ниже исходного.');
    }
  } else {
    throw new CompressError('Смена формата не требует расчёта битрейта');
  }

  if (Math.min(width, height) > shortSide) ({ width, height } = scaledSize(v.width, v.height, shortSide));
  const bpp = videoBitrate / pixelsPerSec(width, height);
  const grade = gradeFor(bpp, req.codec);
  if (grade === 'poor') warnings.push('При таком размере качество будет низким. Уменьшите разрешение или увеличьте размер файла.');
  if (v.hdr) warnings.push('HDR будет переведён в SDR — так видео одинаково выглядит на любых экранах.');
  const estimatedBytes = Math.round(((videoBitrate + audioBitrate) * duration) / 8 / (1 - CONTAINER_OVERHEAD));
  return { width, height, videoBitrate, audioBitrate, codec: req.codec, estimatedBytes, targetBytes, bitsPerPixel: bpp, grade, warnings };
}

/** Новый битрейт для повторного прохода, если файл вышел не того размера. */
export function correctedBitrate(plan: CompressPlan, videoBitrate: number, actualBytes: number): number | null {
  if (plan.targetBytes === null) return null;
  const target = plan.targetBytes;
  // Превышение недопустимо; заметный недобор — потерянное качество.
  if (actualBytes <= target && actualBytes >= target * 0.85) return null;
  const audioBits = plan.audioBitrate;
  const ratio = (target * 0.985) / actualBytes;
  const next = Math.round((videoBitrate + audioBits) * ratio - audioBits);
  return Math.max(MIN_VIDEO_BITRATE, next);
}

/** План движка: весь файл как один клип, выход — с параметрами сжатия. */
export function compressRenderPlan(source: MediaAsset, plan: CompressPlan, videoBitrate = plan.videoBitrate): RenderPlan {
  const v = source.video!;
  const frames = assetLengthInFrames(source, v.frameRate);
  if (frames <= 0) throw new CompressError('Файл короче одного кадра');
  const output: OutputSettings = {
    target: 'file',
    width: plan.width,
    height: plan.height,
    frameRate: v.frameRate,
    // Длинная группа кадров (2 с) экономит битрейт по сравнению с рендером под хостинг.
    video: { codec: plan.codec, bitrate: videoBitrate, keyFrameIntervalSec: 2 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrate: Math.max(64_000, plan.audioBitrate) },
  };
  return {
    output,
    fit: 'fit',
    frameRate: v.frameRate,
    totalFrames: frames,
    assets: [source],
    video: [{ from: 0, to: frames, source: { assetId: source.id, sourceIn: 0 }, overlays: [] }],
    audio: source.audio ? [{ clipId: 'compress' as never, assetId: source.id, from: 0, to: frames, sourceIn: 0 }] : [],
    includeAudio: source.audio !== null,
    warnings: [],
  };
}
