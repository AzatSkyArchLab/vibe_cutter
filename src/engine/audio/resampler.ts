/**
 * Потоковый ресемплер на оконном sinc (окно Блэкмана). Чистый TS — тестируется
 * без браузера. Работает с одним каналом; позиции задаются в отсчётах исходника,
 * поэтому выход можно точно выровнять по времени.
 *
 * Использование: push() добавляет отсчёты исходника по абсолютному индексу,
 * read() выдаёт отсчёты выхода, пока хватает входа; finish() разрешает
 * дочитать хвост, считая недостающие отсчёты тишиной.
 */
const HALF_TAPS = 24;

export class Resampler {
  private buf = new Float32Array(0);
  /** Абсолютный индекс исходника, соответствующий buf[0]. */
  private bufStart = 0;
  /** Сколько отсчётов в buf заполнено (buf[0 .. filled)). */
  private filled = 0;
  private finished = false;
  /** Позиция следующего выходного отсчёта в отсчётах исходника. */
  private pos: number;
  private readonly step: number;
  private readonly cutoff: number;
  private readonly passthrough: boolean;

  /**
   * @param startPos — дробная позиция в исходнике, соответствующая первому
   *   отсчёту выхода (отсчитывается от индекса 0 исходника).
   */
  constructor(
    readonly inRate: number,
    readonly outRate: number,
    startPos: number,
  ) {
    this.step = inRate / outRate;
    // При понижении частоты срезаем выше новой частоты Найквиста.
    this.cutoff = Math.min(1, outRate / inRate) * 0.98;
    this.passthrough = inRate === outRate && Number.isInteger(startPos);
    this.pos = startPos;
    this.bufStart = Math.max(0, Math.floor(startPos) - HALF_TAPS);
  }

  /** Отсчёты исходника, начиная с абсолютного индекса `at`. Пропуски заполняются тишиной. */
  push(samples: Float32Array, at: number): void {
    let src = samples;
    let index = at;
    if (index < this.bufStart) {
      const skip = this.bufStart - index;
      if (skip >= src.length) return;
      src = src.subarray(skip);
      index = this.bufStart;
    }
    const offset = index - this.bufStart;
    const needed = offset + src.length;
    if (needed > this.buf.length) {
      const grown = new Float32Array(Math.max(needed, this.buf.length * 2, 4096));
      grown.set(this.buf.subarray(0, this.filled));
      this.buf = grown;
    }
    this.buf.set(src, offset);
    this.filled = Math.max(this.filled, needed);
  }

  finish(): void {
    this.finished = true;
  }

  /** Выдаёт до `max` отсчётов выхода в `out` (с позиции `outOffset`), возвращает их число. */
  read(out: Float32Array, outOffset: number, max: number): number {
    let n = 0;
    const lastAvailable = this.bufStart + this.filled - 1;
    while (n < max) {
      const p = this.pos;
      const center = Math.floor(p);
      if (!this.finished && center + HALF_TAPS > lastAvailable) break;
      out[outOffset + n] = this.passthrough ? this.at(center) : this.interpolate(p);
      n++;
      this.pos += this.step;
    }
    this.compact();
    return n;
  }

  private at(i: number): number {
    const k = i - this.bufStart;
    return k >= 0 && k < this.filled ? this.buf[k]! : 0;
  }

  private interpolate(p: number): number {
    const center = Math.floor(p);
    const frac = p - center;
    let sum = 0;
    for (let t = -HALF_TAPS + 1; t <= HALF_TAPS; t++) {
      const x = t - frac;
      sum += this.at(center + t) * kernel(x, this.cutoff);
    }
    return sum;
  }

  /** Выбрасываем отсчёты, которые больше не понадобятся. */
  private compact(): void {
    const keepFrom = Math.floor(this.pos) - HALF_TAPS;
    const drop = keepFrom - this.bufStart;
    if (drop < 65536 || drop > this.filled) return;
    this.buf.copyWithin(0, drop, this.filled);
    this.filled -= drop;
    this.bufStart += drop;
  }
}

function kernel(x: number, cutoff: number): number {
  if (Math.abs(x) >= HALF_TAPS) return 0;
  const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
  // Окно Блэкмана на [-HALF_TAPS, HALF_TAPS].
  const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / HALF_TAPS) + 0.08 * Math.cos((2 * Math.PI * x) / HALF_TAPS);
  return sinc * w;
}
