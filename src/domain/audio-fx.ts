/**
 * Эффекты звукового клипа (аналог Fairlight FX в Resolve). Хранятся в клипе
 * и сохраняются в файле проекта; обработку выполняет микшер движка.
 */

export type ReverbPreset = 'room' | 'hall' | 'cathedral';

export interface AudioFx {
  /** Громкость клипа, дБ. */
  readonly gainDb: number;
  /** Эффект «телефон»: 0 выключен, 1 полностью. */
  readonly phone: number;
  /** Реверберация; null выключена. */
  readonly reverb: { readonly preset: ReverbPreset; readonly mix: number } | null;
}

export const NO_FX: AudioFx = { gainDb: 0, phone: 0, reverb: null };

export const REVERB_PRESETS: readonly { preset: ReverbPreset; label: string; tailSec: number }[] = [
  { preset: 'room', label: 'Комната', tailSec: 1.2 },
  { preset: 'hall', label: 'Зал', tailSec: 2.6 },
  { preset: 'cathedral', label: 'Собор', tailSec: 5 },
];

export const GAIN_MIN_DB = -40;
export const GAIN_MAX_DB = 12;

/** Есть ли у клипа хоть какая-то обработка. */
export const hasFx = (fx: AudioFx | undefined | null): fx is AudioFx =>
  !!fx && (fx.gainDb !== 0 || fx.phone > 0 || (fx.reverb !== null && fx.reverb.mix > 0));

/** Сколько секунд эффект звучит после конца клипа (хвост реверберации). */
export const fxTailSec = (fx: AudioFx | null | undefined): number =>
  fx?.reverb && fx.reverb.mix > 0 ? (REVERB_PRESETS.find((p) => p.preset === fx.reverb!.preset)?.tailSec ?? 0) : 0;

export const sameFx = (a: AudioFx | null | undefined, b: AudioFx | null | undefined): boolean => {
  const x = hasFx(a) ? a : NO_FX;
  const y = hasFx(b) ? b : NO_FX;
  return (
    x.gainDb === y.gainDb &&
    x.phone === y.phone &&
    (x.reverb?.preset ?? null) === (y.reverb?.preset ?? null) &&
    (x.reverb?.mix ?? 0) === (y.reverb?.mix ?? 0)
  );
};

/** Значения из файла проекта или инспектора приводятся к допустимым. */
export function sanitizeFx(fx: Partial<AudioFx> | undefined | null): AudioFx {
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  const r = fx?.reverb;
  const preset = REVERB_PRESETS.some((p) => p.preset === r?.preset) ? r!.preset : 'room';
  return {
    gainDb: Math.round(num(fx?.gainDb, 0, GAIN_MIN_DB, GAIN_MAX_DB) * 10) / 10,
    phone: num(fx?.phone, 0, 0, 1),
    reverb: r ? { preset, mix: num(r.mix, 0.3, 0, 1) } : null,
  };
}
