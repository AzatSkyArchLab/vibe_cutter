import { type FrameRate, fpsValue } from './time';

export type ExportTarget = 'youtube' | 'kinescope';
/** Куда предназначен файл: хостинг или просто сжатый файл. */
export type OutputPurpose = ExportTarget | 'file';
export type VideoCodecChoice = 'avc' | 'hevc';

export interface OutputSettings {
  readonly target: OutputPurpose;
  readonly width: number;
  readonly height: number;
  readonly frameRate: FrameRate;
  readonly video: {
    readonly codec: VideoCodecChoice;
    readonly bitrate: number;
    /** Закрытая группа кадров длиной в полсекунды — рекомендация YouTube. */
    readonly keyFrameIntervalSec: number;
  };
  readonly audio: {
    readonly codec: 'aac';
    readonly sampleRate: 48000;
    readonly channels: 2;
    readonly bitrate: number;
  };
}

/**
 * Битрейт для загрузки на хостинг. Оба сервиса перекодируют видео, поэтому
 * отдаём с запасом относительно рекомендаций YouTube для SDR
 * (1080p: 8/12 Мбит/с, 4K: 35–45/53–68 Мбит/с для 30/60 fps).
 * Вертикальный кадр считается по площади, как горизонтальный.
 */
export function uploadBitrate(width: number, height: number, rate: FrameRate, codec: VideoCodecChoice): number {
  const pixels = width * height;
  const high = fpsValue(rate) > 30.5;
  let mbps: number;
  if (pixels <= 1920 * 1080) mbps = high ? 18 : 12;
  else if (pixels <= 2560 * 1440) mbps = high ? 36 : 24;
  else mbps = high ? 68 : 45;
  // HEVC даёт то же качество примерно на 35% меньшем битрейте.
  return Math.round(mbps * (codec === 'hevc' ? 0.65 : 1) * 1_000_000);
}

export function outputSettings(opts: {
  target: ExportTarget;
  width: number;
  height: number;
  frameRate: FrameRate;
  codec?: VideoCodecChoice;
}): OutputSettings {
  const codec = opts.codec ?? 'avc';
  return {
    target: opts.target,
    width: opts.width,
    height: opts.height,
    frameRate: opts.frameRate,
    video: {
      codec,
      bitrate: uploadBitrate(opts.width, opts.height, opts.frameRate, codec),
      keyFrameIntervalSec: 0.5,
    },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrate: 320_000 },
  };
}

export const TARGET_LABELS: Record<ExportTarget, string> = {
  youtube: 'YouTube',
  kinescope: 'Kinescope',
};
