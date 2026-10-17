/**
 * Время на таймлайне хранится целыми кадрами — так резы и длительности
 * не накапливают ошибку округления. Секунды появляются только на границе
 * с медиа-движком.
 */

/** Частота кадров как дробь: 30000/1001 = 29.97. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

export const frameRate = (num: number, den = 1): FrameRate => ({ num, den });

export const STANDARD_FRAME_RATES: readonly FrameRate[] = [
  frameRate(24000, 1001),
  frameRate(24),
  frameRate(25),
  frameRate(30000, 1001),
  frameRate(30),
  frameRate(50),
  frameRate(60000, 1001),
  frameRate(60),
];

export const fpsValue = (rate: FrameRate): number => rate.num / rate.den;

export const sameFrameRate = (a: FrameRate, b: FrameRate): boolean => a.num * b.den === b.num * a.den;

export const framesToSeconds = (frames: number, rate: FrameRate): number => (frames * rate.den) / rate.num;

/**
 * Индекс кадра, который виден в момент `seconds`. Небольшой допуск нужен,
 * чтобы 1.0000000001 * fps не превращался в «следующий кадр минус эпсилон».
 */
export const secondsToFrames = (seconds: number, rate: FrameRate): number =>
  Math.floor((seconds * rate.num) / rate.den + 1e-6);

/** Ближайшая стандартная частота, если измеренная отличается не больше чем на 0.5%. */
export function snapToStandardFrameRate(measuredFps: number): FrameRate {
  let best: FrameRate | null = null;
  let bestErr = Infinity;
  for (const rate of STANDARD_FRAME_RATES) {
    const err = Math.abs(fpsValue(rate) - measuredFps) / measuredFps;
    if (err < bestErr) {
      best = rate;
      bestErr = err;
    }
  }
  if (best && bestErr <= 0.005) return best;
  return frameRate(Math.round(measuredFps * 1000), 1000);
}

/** Таймкод HH:MM:SS:FF (non-drop frame, номинальная частота округляется вверх). */
export function formatTimecode(frames: number, rate: FrameRate): string {
  const nominal = Math.ceil(fpsValue(rate) - 1e-9);
  const sign = frames < 0 ? '-' : '';
  let rest = Math.abs(frames);
  const ff = rest % nominal;
  rest = Math.floor(rest / nominal);
  const ss = rest % 60;
  rest = Math.floor(rest / 60);
  const mm = rest % 60;
  const hh = Math.floor(rest / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${sign}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

export const formatFrameRate = (rate: FrameRate): string => {
  const v = fpsValue(rate);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
};
