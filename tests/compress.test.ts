import { describe, expect, it } from 'vitest';
import {
  type CompressRequest, compressRenderPlan, correctedBitrate, gradeFor, planCompression, scaledSize,
} from '../src/domain/compress';
import { asset } from './helpers';

// 60 с, 4K 30 к/с, 600 МБ — типичный ролик с iPhone
const iphone = asset('clip', 60, {
  sizeBytes: 600e6,
  video: { codec: 'hevc', width: 3840, height: 2160, frameRate: { num: 30, den: 1 }, variableFrameRate: true, hdr: true, decodable: true },
});
const req = (r: Partial<CompressRequest>): CompressRequest => ({
  mode: 'size', targetMB: 50, quality: 'high', resolution: 'auto', codec: 'avc', audioKbps: 128, ...r,
});

describe('сжатие до размера', () => {
  it('битрейт выбран так, чтобы файл влез в размер с запасом на контейнер', () => {
    const p = planCompression(iphone, req({ targetMB: 50 }));
    expect(p.targetBytes).toBe(50e6);
    expect(p.estimatedBytes).toBeLessThanOrEqual(50e6);
    expect(p.estimatedBytes).toBeGreaterThan(49e6);
    expect(p.audioBitrate).toBe(128_000);
    // (50e6*8*0.988 - 128k*60)/60
    expect(p.videoBitrate).toBe(Math.floor((50e6 * 8 * 0.988 - 128_000 * 60) / 60));
  });

  it('авто-разрешение снижает кадр, пока качество не станет хорошим', () => {
    const p = planCompression(iphone, req({ targetMB: 50 }));
    // ~6.4 Мбит/с: для 4K мало, для 1080p — в самый раз
    expect([p.width, p.height]).toEqual([1920, 1080]);
    expect(['good', 'excellent']).toContain(p.grade);
    const big = planCompression(iphone, req({ targetMB: 400 }));
    expect([big.width, big.height]).toEqual([3840, 2160]);
    const tiny = planCompression(iphone, req({ targetMB: 8 }));
    expect(Math.min(tiny.width, tiny.height)).toBeLessThanOrEqual(540);
  });

  it('HEVC при том же размере позволяет кадр крупнее', () => {
    const avc = planCompression(iphone, req({ targetMB: 25 }));
    const hevc = planCompression(iphone, req({ targetMB: 25, codec: 'hevc' }));
    expect(hevc.height).toBeGreaterThanOrEqual(avc.height);
  });

  it('вертикальное видео масштабируется по короткой стороне, стороны чётные', () => {
    const vertical = asset('v', 30, { video: { ...iphone.video!, width: 1080, height: 1920, hdr: false } });
    const p = planCompression(vertical, req({ targetMB: 6, resolution: 720 }));
    expect([p.width, p.height]).toEqual([720, 1280]);
    expect(scaledSize(1081, 1921, 720)).toEqual({ width: 720, height: 1280 });
  });

  it('не увеличивает кадр сверх исходного', () => {
    const small = asset('s', 10, { video: { ...iphone.video!, width: 1280, height: 720 } });
    const p = planCompression(small, req({ targetMB: 500, resolution: 2160 }));
    expect([p.width, p.height]).toEqual([1280, 720]);
  });

  it('слишком маленький размер — понятная ошибка с минимумом', () => {
    expect(() => planCompression(iphone, req({ targetMB: 1 }))).toThrow(/Минимум ≈ \d+ МБ/);
  });

  it('предупреждает про HDR и про размер больше исходного', () => {
    const p = planCompression(iphone, req({ targetMB: 700 }));
    expect(p.warnings.join()).toMatch(/HDR/);
    expect(p.warnings.join()).toMatch(/уже меньше/);
  });

  it('без звука весь размер идёт на видео', () => {
    const silent = asset('m', 60, { audio: null, video: iphone.video });
    const p = planCompression(silent, req({ targetMB: 50 }));
    expect(p.audioBitrate).toBe(0);
    expect(compressRenderPlan(silent, p).includeAudio).toBe(false);
  });
});

describe('сжатие по качеству', () => {
  it('битрейт от числа пикселей и не выше исходного', () => {
    const p = planCompression(iphone, req({ mode: 'quality', quality: 'medium', resolution: 1080 }));
    expect([p.width, p.height]).toEqual([1920, 1080]);
    expect(p.videoBitrate).toBe(Math.round(1920 * 1080 * 30 * 0.065));
    expect(p.targetBytes).toBeNull();
    const already = asset('x', 60, { sizeBytes: 20e6, video: iphone.video });
    const q = planCompression(already, req({ mode: 'quality', quality: 'high', resolution: 'source' }));
    expect(q.videoBitrate).toBeLessThan((20e6 * 8) / 60);
    expect(q.warnings.join()).toMatch(/сильнее/);
  });
});

describe('поправка размера вторым проходом', () => {
  const p = planCompression(iphone, req({ targetMB: 50 }));
  it('превышение — снижаем битрейт пропорционально', () => {
    const next = correctedBitrate(p, p.videoBitrate, 55e6)!;
    expect(next).toBeLessThan(p.videoBitrate);
    expect(((next + p.audioBitrate) * 60) / 8).toBeLessThan(50e6);
  });
  it('в пределах 85–100% — повтор не нужен', () => {
    expect(correctedBitrate(p, p.videoBitrate, 48e6)).toBeNull();
    expect(correctedBitrate(p, p.videoBitrate, 43e6)).toBeNull();
    expect(correctedBitrate(p, p.videoBitrate, 50e6)).toBeNull();
  });
  it('сильный недобор — повышаем битрейт ради качества', () => {
    expect(correctedBitrate(p, p.videoBitrate, 35e6)!).toBeGreaterThan(p.videoBitrate);
  });
});

describe('план для движка', () => {
  it('весь файл — один кусок, выход с параметрами сжатия', () => {
    const p = planCompression(iphone, req({ targetMB: 50 }));
    const plan = compressRenderPlan(iphone, p);
    expect(plan.totalFrames).toBe(1800);
    expect(plan.video).toEqual([{ from: 0, to: 1800, source: { assetId: 'clip', sourceIn: 0 }, overlays: [] }]);
    expect(plan.output).toMatchObject({ target: 'file', width: 1920, height: 1080, video: { codec: 'avc', bitrate: p.videoBitrate } });
    expect(plan.audio).toHaveLength(1);
  });

  it('оценки качества', () => {
    expect(gradeFor(0.1, 'avc')).toBe('excellent');
    expect(gradeFor(0.05, 'avc')).toBe('fair');
    expect(gradeFor(0.05, 'hevc')).toBe('good');
  });
});
