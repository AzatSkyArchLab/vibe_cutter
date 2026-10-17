import { type VideoSample } from 'mediabunny';
import type { FitMode } from '../domain/project';
import type { TitleOverlay } from '../domain/render-plan';
import { titleOpacity } from '../domain/title';
import { drawTitle } from './title-render';

/**
 * Собирает выходной кадр: основа (чёрный фон + исходник, вписанный в кадр)
 * и титры поверх. Рисование VideoFrame в sRGB-холст заставляет браузер
 * привести цвет к SDR (в том числе HLG/PQ с iPhone), поэтому любой исходник
 * на выходе — Rec.709 SDR.
 *
 * Основа хранится отдельно от итогового кадра: исходный кадр может длиться
 * несколько выходных кадров, а титры меняются каждый кадр (появление).
 */
export class Compositor {
  private readonly base: OffscreenCanvas;
  private readonly baseCtx: OffscreenCanvasRenderingContext2D;
  private readonly out: OffscreenCanvas;
  private readonly outCtx: OffscreenCanvasRenderingContext2D;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly fit: FitMode,
    private readonly fps: number,
  ) {
    [this.base, this.baseCtx] = canvas(width, height);
    [this.out, this.outCtx] = canvas(width, height);
  }

  black(): void {
    this.baseCtx.fillStyle = '#000';
    this.baseCtx.fillRect(0, 0, this.width, this.height);
  }

  draw(sample: VideoSample): void {
    this.black();
    sample.drawWithFit(this.baseCtx, { fit: this.fit === 'fill' ? 'cover' : 'contain' });
  }

  /** Итоговый кадр; `index` — номер кадра от начала куска плана. */
  frame(overlays: readonly TitleOverlay[], index: number): OffscreenCanvas {
    if (overlays.length === 0) return this.base;
    this.outCtx.drawImage(this.base, 0, 0);
    for (const o of overlays) {
      const local = o.offset + index;
      drawTitle(this.outCtx, this.width, this.height, o.title, titleOpacity(o.title, local, o.length, this.fps));
    }
    return this.out;
  }
}

function canvas(w: number, h: number): [OffscreenCanvas, OffscreenCanvasRenderingContext2D] {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { alpha: false, colorSpace: 'srgb', desynchronized: true });
  if (!ctx) throw new Error('Не удалось создать холст для сборки кадра');
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}
