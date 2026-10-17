import type { FrameRate } from './time';

export type AssetId = string & { readonly __brand: 'AssetId' };

export interface VideoInfo {
  readonly codec: string;
  /** Размер кадра с учётом поворота (как его видит зритель). */
  readonly width: number;
  readonly height: number;
  readonly frameRate: FrameRate;
  /** Переменная частота кадров (типично для iPhone и записи экрана). */
  readonly variableFrameRate: boolean;
  readonly hdr: boolean;
  readonly decodable: boolean;
}

export interface AudioInfo {
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly decodable: boolean;
}

/** Исходный файл в проекте. Сам файл живёт в адаптере, домен знает только метаданные. */
export interface MediaAsset {
  readonly id: AssetId;
  readonly name: string;
  readonly sizeBytes: number;
  /** Время первого кадра в файле, секунды (бывает не нулём у mov с камер). */
  readonly startTime: number;
  readonly duration: number;
  readonly video: VideoInfo | null;
  readonly audio: AudioInfo | null;
}

export type MediaMetadata = Omit<MediaAsset, 'id'>;
