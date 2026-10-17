import { type VideoSample } from 'mediabunny';
import type { FitMode } from '../domain/project';

/**
 * Собирает выходной кадр: чёрный фон + исходник, вписанный в кадр таймлайна.
 * Рисование VideoFrame в sRGB-холст заставляет браузер привести цвет к SDR
 * (в том числе HLG/PQ с iPhone), поэтому любой исходник на выходе — Rec.709 SDR.
 */
export class Compositor {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly fit: FitMode,
  ) {
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext('2d', { alpha: false, colorSpace: 'srgb', desynchronized: true });
    if (!ctx) throw new Error('Не удалось создать холст для сборки кадра');
    this.ctx = ctx;
    this.ctx.imageSmoothingQuality = 'high';
  }

  black(): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  draw(sample: VideoSample): void {
    this.black();
    sample.drawWithFit(this.ctx, { fit: this.fit === 'fill' ? 'cover' : 'contain' });
  }
}
