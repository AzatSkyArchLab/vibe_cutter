/**
 * Обработка звукового клипа: громкость, плавное появление и затухание
 * (ручки на клипе, как в Vegas), «телефон», реверберация. Хранится в клипе
 * и сохраняется в файле проекта; обработку выполняет микшер движка.
 */

export type ReverbPreset = 'room' | 'hall' | 'cathedral';

/** Форма кривой появления/затухания. */
export type FadeCurve = 'linear' | 'smooth' | 'fast' | 'slow';

export interface AudioFx {
  /** Громкость клипа, дБ. */
  readonly gainDb: number;
  /** Плавное появление в начале клипа, секунды. */
  readonly fadeIn: number;
  readonly fadeInCurve: FadeCurve;
  /** Плавное затухание в конце клипа, секунды. */
  readonly fadeOut: number;
  readonly fadeOutCurve: FadeCurve;
  /** Эффект «телефон»: 0 выключен, 1 полностью. */
  readonly phone: number;
  /** Реверберация; null выключена. */
  readonly reverb: { readonly preset: ReverbPreset; readonly mix: number } | null;
}

export const NO_FX: AudioFx = { gainDb: 0, fadeIn: 0, fadeInCurve: 'smooth', fadeOut: 0, fadeOutCurve: 'smooth', phone: 0, reverb: null };

export const REVERB_PRESETS: readonly { preset: ReverbPreset; label: string; tailSec: number }[] = [
  { preset: 'room', label: 'Комната', tailSec: 1.2 },
  { preset: 'hall', label: 'Зал', tailSec: 2.6 },
  { preset: 'cathedral', label: 'Собор', tailSec: 5 },
];

export const FADE_CURVES: readonly { curve: FadeCurve; label: string }[] = [
  { curve: 'smooth', label: 'Плавная' },
  { curve: 'linear', label: 'Линейная' },
  { curve: 'fast', label: 'Быстрая' },
  { curve: 'slow', label: 'Медленная' },
];

export const GAIN_MIN_DB = -40;
export const GAIN_MAX_DB = 12;
export const FADE_MAX_SEC = 600;

/**
 * Громкость на кривой появления в точке t ∈ [0, 1]: 0 тишина, 1 полная громкость.
 * Затухание использует ту же кривую по оставшейся доле: curve(1 − пройдено).
 */
export function fadeGain(curve: FadeCurve, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (curve) {
    case 'linear':
      return x;
    case 'smooth':
      return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case 'fast':
      return Math.sin((Math.PI / 2) * x);
    case 'slow':
      return 1 - Math.cos((Math.PI / 2) * x);
  }
}

/**
 * Огибающая громкости клипа в точке `pos` (секунды от начала клипа) при длине клипа `length`.
 * Если появление и затухание вместе длиннее клипа, они сжимаются пропорционально.
 */
export function fadeEnvelope(fx: AudioFx, pos: number, length: number): number {
  let fin = fx.fadeIn;
  let fout = fx.fadeOut;
  if (fin + fout > length && fin + fout > 0) {
    const k = length / (fin + fout);
    fin *= k;
    fout *= k;
  }
  let g = 1;
  if (fin > 0 && pos < fin) g *= fadeGain(fx.fadeInCurve, pos / fin);
  if (fout > 0 && pos > length - fout) g *= fadeGain(fx.fadeOutCurve, (length - pos) / fout);
  return g;
}

/** Есть ли у клипа хоть какая-то обработка. */
export const hasFx = (fx: AudioFx | undefined | null): fx is AudioFx =>
  !!fx && (fx.gainDb !== 0 || fx.fadeIn > 0 || fx.fadeOut > 0 || fx.phone > 0 || (fx.reverb !== null && fx.reverb.mix > 0));

export const hasFades = (fx: AudioFx | undefined | null): boolean => !!fx && (fx.fadeIn > 0 || fx.fadeOut > 0);

/** Сколько секунд эффект звучит после конца клипа (хвост реверберации). */
export const fxTailSec = (fx: AudioFx | null | undefined): number =>
  fx?.reverb && fx.reverb.mix > 0 ? (REVERB_PRESETS.find((p) => p.preset === fx.reverb!.preset)?.tailSec ?? 0) : 0;

export const sameFx = (a: AudioFx | null | undefined, b: AudioFx | null | undefined): boolean => {
  const x = hasFx(a) ? a : NO_FX;
  const y = hasFx(b) ? b : NO_FX;
  return (
    x.gainDb === y.gainDb &&
    x.fadeIn === y.fadeIn &&
    x.fadeOut === y.fadeOut &&
    x.fadeInCurve === y.fadeInCurve &&
    x.fadeOutCurve === y.fadeOutCurve &&
    x.phone === y.phone &&
    (x.reverb?.preset ?? null) === (y.reverb?.preset ?? null) &&
    (x.reverb?.mix ?? 0) === (y.reverb?.mix ?? 0)
  );
};

/** Значения из файла проекта или инспектора приводятся к допустимым (старые файлы без ручек тоже читаются). */
export function sanitizeFx(fx: Partial<AudioFx> | undefined | null): AudioFx {
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  const curve = (v: unknown): FadeCurve => (FADE_CURVES.some((c) => c.curve === v) ? (v as FadeCurve) : 'smooth');
  const r = fx?.reverb;
  const preset = REVERB_PRESETS.some((p) => p.preset === r?.preset) ? r!.preset : 'room';
  return {
    gainDb: Math.round(num(fx?.gainDb, 0, GAIN_MIN_DB, GAIN_MAX_DB) * 10) / 10,
    fadeIn: Math.round(num(fx?.fadeIn, 0, 0, FADE_MAX_SEC) * 1000) / 1000,
    fadeInCurve: curve(fx?.fadeInCurve),
    fadeOut: Math.round(num(fx?.fadeOut, 0, 0, FADE_MAX_SEC) * 1000) / 1000,
    fadeOutCurve: curve(fx?.fadeOutCurve),
    phone: num(fx?.phone, 0, 0, 1),
    reverb: r ? { preset, mix: num(r.mix, 0.3, 0, 1) } : null,
  };
}
