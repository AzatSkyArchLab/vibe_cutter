import { describe, expect, it } from 'vitest';
import { frameAtX, wheelZoomFactor, zoomAt } from '../src/ui/timeline-zoom';

const limits = { min: 0.02, max: 40, headerW: 64 };

describe('масштаб таймлайна колесом', () => {
  it('кадр под курсором остаётся под курсором при приближении и отдалении', () => {
    let v = { pxPerFrame: 2, scrollX: 500 };
    const x = 700;
    const frame = frameAtX(v, x, limits.headerW);
    for (const f of [1.25, 1.25, 1.25, 0.8, 0.8, 0.5, 3]) {
      v = zoomAt(v, f, x, limits);
      expect(frameAtX(v, x, limits.headerW)).toBeCloseTo(frame, 6);
    }
  });

  it('туда и обратно возвращает исходный вид', () => {
    const v0 = { pxPerFrame: 1.5, scrollX: 1234 };
    const there = zoomAt(v0, 1.25, 400, limits);
    const back = zoomAt(there, 1 / 1.25, 400, limits);
    expect(back.pxPerFrame).toBeCloseTo(v0.pxPerFrame, 9);
    expect(back.scrollX).toBeCloseTo(v0.scrollX, 6);
  });

  it('на пределе масштаба кадр под курсором тоже не уезжает', () => {
    const v = { pxPerFrame: 39, scrollX: 100 };
    const x = 300;
    const frame = frameAtX(v, x, limits.headerW);
    const z = zoomAt(v, 4, x, limits);
    expect(z.pxPerFrame).toBe(40);
    expect(frameAtX(z, x, limits.headerW)).toBeCloseTo(frame, 6);
  });

  it('над заголовками дорожек опора — левый край, без скачка', () => {
    const v = { pxPerFrame: 2, scrollX: 300 };
    const z = zoomAt(v, 1.25, 10, limits);
    expect(z.scrollX).toBeCloseTo(300, 6);
  });

  it('прокрутка не уходит левее нулевого кадра', () => {
    const z = zoomAt({ pxPerFrame: 2, scrollX: 5 }, 0.5, 900, limits);
    expect(z.scrollX).toBe(0);
  });

  it('колесо мыши: ровный шаг за щелчок в обе стороны', () => {
    expect(wheelZoomFactor({ deltaX: 0, deltaY: -100, deltaMode: 0 })).toBeCloseTo(1.25, 6);
    expect(wheelZoomFactor({ deltaX: 0, deltaY: 100, deltaMode: 0 })).toBeCloseTo(0.8, 6);
    // Windows/Firefox: прокрутка в строках (3 строки за щелчок)
    expect(wheelZoomFactor({ deltaX: 0, deltaY: -3, deltaMode: 1 })).toBeCloseTo(1.25, 1);
  });

  it('быстрое колесо не даёт скачков, щипок трекпада — плавный', () => {
    expect(wheelZoomFactor({ deltaX: 0, deltaY: -1000, deltaMode: 0 })).toBeCloseTo(1.25 ** 2, 6);
    const pinch = wheelZoomFactor({ deltaX: 0, deltaY: -4, deltaMode: 0 });
    expect(pinch).toBeGreaterThan(1);
    expect(pinch).toBeLessThan(1.02);
  });

  it('прокрутка, пришедшая в deltaX, тоже масштабирует', () => {
    expect(wheelZoomFactor({ deltaX: -100, deltaY: 0, deltaMode: 0 })).toBeCloseTo(1.25, 6);
  });
});
