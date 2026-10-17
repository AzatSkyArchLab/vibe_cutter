import { Resampler } from './resampler';

/**
 * Микшер собирает выходной звук (стерео, фиксированная частота) из кусков
 * исходников. Каждый кусок — источник отсчётов в своей частоте; микшер
 * ресемплирует их и складывает в выходной буфер блок за блоком.
 *
 * Модуль не знает про декодер: отсчёты ему подаёт `SourceFeed`.
 */

export const OUT_CHANNELS = 2;

/** Порция декодированного звука исходника, уже в стерео planar float. */
export interface PcmChunk {
  /** Абсолютный индекс первого отсчёта в частоте исходника. */
  readonly index: number;
  readonly channels: readonly [Float32Array, Float32Array];
}

export interface SourceFeed {
  readonly sampleRate: number;
  /** Следующая порция или null, если исходник кончился. */
  next(): Promise<PcmChunk | null>;
  close(): void;
}

export interface MixSpan {
  /** Отсчёты выхода [outStart, outEnd). */
  readonly outStart: number;
  readonly outEnd: number;
  /** Время в исходнике (секунды от нуля файла), соответствующее outStart. */
  readonly sourceTime: number;
  readonly open: () => Promise<SourceFeed>;
}

/** Длина плавного входа/выхода на краях куска — убирает щелчки на резах. */
const EDGE_FADE = 96;

class ActiveSpan {
  private readonly resamplers: [Resampler, Resampler];
  private written: number;
  private done = false;

  constructor(
    readonly span: MixSpan,
    private readonly feed: SourceFeed,
    outRate: number,
  ) {
    // Целая позиция при совпадающих частотах даёт побитовое копирование.
    const raw = span.sourceTime * feed.sampleRate;
    const pos = Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : raw;
    this.resamplers = [new Resampler(feed.sampleRate, outRate, pos), new Resampler(feed.sampleRate, outRate, pos)];
    this.written = span.outStart;
  }

  /** Подмешивает отсчёты куска в block, покрывающий выход [blockStart, blockStart + len). */
  async mixInto(block: readonly [Float32Array, Float32Array], blockStart: number, scratch: Float32Array): Promise<void> {
    const from = Math.max(blockStart, this.written);
    const to = Math.min(blockStart + block[0].length, this.span.outEnd);
    if (to <= from) return;
    const need = to - from;
    // Подаём вход, пока ресемплер не сможет выдать нужное количество.
    for (let ch = 0; ch < OUT_CHANNELS; ch++) {
      let got = 0;
      while (got < need) {
        const n = this.resamplers[ch]!.read(scratch, got, need - got);
        got += n;
        if (got < need && n === 0) {
          if (!(await this.pull())) continue;
        }
      }
      const dst = block[ch]!;
      for (let i = 0; i < need; i++) {
        const outIndex = from + i;
        dst[outIndex - blockStart]! += scratch[i]! * this.gain(outIndex);
      }
    }
    this.written = to;
  }

  /** Подаёт следующую порцию входа в оба канала; false — входа больше нет. */
  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const chunk = await this.feed.next();
    if (!chunk) {
      this.done = true;
      for (const r of this.resamplers) r.finish();
      return true;
    }
    this.resamplers[0].push(chunk.channels[0], chunk.index);
    this.resamplers[1].push(chunk.channels[1], chunk.index);
    return true;
  }

  private gain(outIndex: number): number {
    const fromStart = outIndex - this.span.outStart;
    const toEnd = this.span.outEnd - 1 - outIndex;
    const edge = Math.min(fromStart, toEnd);
    return edge >= EDGE_FADE ? 1 : (edge + 1) / (EDGE_FADE + 1);
  }

  get finished(): boolean {
    return this.written >= this.span.outEnd;
  }

  close(): void {
    this.feed.close();
  }
}

export class Mixer {
  private readonly pending: MixSpan[];
  private active: ActiveSpan[] = [];
  private position = 0;
  private scratch = new Float32Array(0);

  constructor(
    spans: readonly MixSpan[],
    readonly outRate: number,
    readonly totalSamples: number,
  ) {
    this.pending = [...spans].sort((a, b) => a.outStart - b.outStart);
  }

  get done(): boolean {
    return this.position >= this.totalSamples;
  }

  /** Сколько отсчётов выхода уже выдано. */
  get samplesWritten(): number {
    return this.position;
  }

  /** Следующий блок выхода длиной до `size` отсчётов (planar стерео). */
  async nextBlock(size: number): Promise<{ start: number; channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] } | null> {
    if (this.done) return null;
    const start = this.position;
    const len = Math.min(size, this.totalSamples - start);
    const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(len), new Float32Array(len)];
    if (this.scratch.length < len) this.scratch = new Float32Array(len);

    while (this.pending.length && this.pending[0]!.outStart < start + len) {
      const span = this.pending.shift()!;
      if (span.outEnd <= span.outStart) continue;
      this.active.push(new ActiveSpan(span, await span.open(), this.outRate));
    }
    for (const a of this.active) await a.mixInto(channels, start, this.scratch);
    for (const a of this.active.filter((x) => x.finished)) a.close();
    this.active = this.active.filter((x) => !x.finished);

    // Перегруз при сложении дорожек: жёсткое ограничение вместо переполнения в кодеке.
    for (const ch of channels) for (let i = 0; i < len; i++) ch[i] = Math.max(-1, Math.min(1, ch[i]!));

    this.position = start + len;
    return { start, channels };
  }

  close(): void {
    for (const a of this.active) a.close();
    this.active = [];
  }
}
