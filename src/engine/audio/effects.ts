import type { AudioFx, ReverbPreset } from '../../domain/audio-fx';

/**
 * Обработка звука клипа: громкость, «телефон», реверберация. Чистый TS без
 * Web Audio, поэтому одинаково работает в рендере (воркер), в превью и в тестах.
 * Состояние фильтров хранится в объекте: блоки можно подавать любой длины подряд.
 */

/** Биквадратный фильтр (формулы RBJ Audio EQ Cookbook), одна цепочка состояния на канал. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(type: 'lowpass' | 'highpass' | 'peaking', freq: number, sampleRate: number, q: number, gainDb = 0) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else {
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  /** Прямая форма II (транспонированная). */
  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * «Телефон»: моно, полоса 300–3400 Гц (фильтры 4-го порядка), подъём середины
 * и мягкий перегруз, как у динамика трубки.
 */
class Phone {
  private readonly chain: Biquad[];
  private readonly drive: number;
  private readonly norm: number;

  constructor(
    private readonly amount: number,
    sampleRate: number,
  ) {
    this.chain = [
      new Biquad('highpass', 300, sampleRate, BUTTERWORTH_Q),
      new Biquad('highpass', 300, sampleRate, BUTTERWORTH_Q),
      new Biquad('lowpass', 3400, sampleRate, BUTTERWORTH_Q),
      new Biquad('lowpass', 3400, sampleRate, BUTTERWORTH_Q),
      new Biquad('peaking', 1600, sampleRate, 1, 5),
    ];
    this.drive = 1 + 5 * amount;
    this.norm = Math.tanh(this.drive);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const a = this.amount;
    // Узкая полоса заметно тише исходника, поэтому поднимаем уровень.
    const makeup = 1.8;
    for (let i = 0; i < n; i++) {
      let m = (l[i]! + r[i]!) * 0.5;
      for (const f of this.chain) m = f.tick(m);
      const wet = (Math.tanh(this.drive * m * makeup) / this.norm) * 0.9;
      l[i] = l[i]! * (1 - a) + wet * a;
      r[i] = r[i]! * (1 - a) + wet * a;
    }
  }
}

/** Гребенчатый фильтр с затуханием высоких (Freeverb). */
class Comb {
  private readonly buf: Float32Array;
  private idx = 0;
  private store = 0;

  constructor(
    size: number,
    private readonly feedback: number,
    private readonly damp: number,
  ) {
    this.buf = new Float32Array(size);
  }

  tick(x: number): number {
    const y = this.buf[this.idx]!;
    this.store = y * (1 - this.damp) + this.store * this.damp;
    this.buf[this.idx] = x + this.store * this.feedback;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return y;
  }
}

class Allpass {
  private readonly buf: Float32Array;
  private idx = 0;

  constructor(size: number) {
    this.buf = new Float32Array(size);
  }

  tick(x: number): number {
    const b = this.buf[this.idx]!;
    this.buf[this.idx] = x + b * 0.5;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return b - x;
  }
}

const REVERB: Record<ReverbPreset, { room: number; damp: number; preDelayMs: number }> = {
  room: { room: 0.55, damp: 0.5, preDelayMs: 5 },
  hall: { room: 0.84, damp: 0.3, preDelayMs: 20 },
  cathedral: { room: 0.95, damp: 0.18, preDelayMs: 40 },
};

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

/** Реверберация Freeverb (Schroeder–Moorer): 8 гребенчатых и 4 всепропускающих фильтра на канал. */
class Reverb {
  private readonly combs: [Comb[], Comb[]];
  private readonly allpasses: [Allpass[], Allpass[]];
  private readonly pre: Float32Array;
  private preIdx = 0;

  constructor(
    preset: ReverbPreset,
    private readonly mix: number,
    sampleRate: number,
  ) {
    const p = REVERB[preset];
    const k = sampleRate / 44100;
    const feedback = p.room * 0.28 + 0.7;
    const damp = p.damp * 0.4;
    this.combs = [0, SPREAD].map((s) => COMBS.map((c) => new Comb(Math.round((c + s) * k), feedback, damp))) as [Comb[], Comb[]];
    this.allpasses = [0, SPREAD].map((s) => ALLPASSES.map((a) => new Allpass(Math.round((a + s) * k)))) as [Allpass[], Allpass[]];
    this.pre = new Float32Array(Math.max(1, Math.round((p.preDelayMs / 1000) * sampleRate)));
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const mix = this.mix;
    for (let i = 0; i < n; i++) {
      // Моно-вход с предзадержкой, как в классическом Freeverb.
      const delayed = this.pre[this.preIdx]!;
      this.pre[this.preIdx] = (l[i]! + r[i]!) * 0.015;
      if (++this.preIdx >= this.pre.length) this.preIdx = 0;
      let wl = 0;
      let wr = 0;
      for (const c of this.combs[0]) wl += c.tick(delayed);
      for (const c of this.combs[1]) wr += c.tick(delayed);
      for (const a of this.allpasses[0]) wl = a.tick(wl);
      for (const a of this.allpasses[1]) wr = a.tick(wr);
      // Сухой сигнал убывает медленнее, чем растёт влажный: при mix 0.5 слышны оба.
      const dry = 1 - mix * mix;
      l[i] = l[i]! * dry + wl * 3 * mix;
      r[i] = r[i]! * dry + wr * 3 * mix;
    }
  }
}

/** Цепочка эффектов клипа: громкость → телефон → реверберация. */
export class FxChain {
  private readonly gain: number;
  private readonly phone: Phone | null;
  private readonly reverb: Reverb | null;

  constructor(fx: AudioFx, sampleRate: number) {
    this.gain = Math.pow(10, fx.gainDb / 20);
    this.phone = fx.phone > 0 ? new Phone(fx.phone, sampleRate) : null;
    this.reverb = fx.reverb && fx.reverb.mix > 0 ? new Reverb(fx.reverb.preset, fx.reverb.mix, sampleRate) : null;
  }

  /** Обработка блока на месте. */
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.gain !== 1)
      for (let i = 0; i < n; i++) {
        l[i] = l[i]! * this.gain;
        r[i] = r[i]! * this.gain;
      }
    this.phone?.process(l, r, n);
    this.reverb?.process(l, r, n);
  }
}
