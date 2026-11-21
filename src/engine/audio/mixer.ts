import { type AudioFx, fadeEnvelope, fxTailSec, hasFades, hasFx } from '../../domain/audio-fx';
import { FxChain } from './effects';
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
  /** Эффекты клипа; их хвост звучит после outEnd. */
  readonly fx?: AudioFx | null;
  /** Границы всего клипа в отсчётах выхода: от них считаются появление и затухание. */
  readonly clipStart?: number;
  readonly clipEnd?: number;
}

/** Длина плавного входа/выхода на краях куска — убирает щелчки на резах. */
const EDGE_FADE = 96;

class ActiveSpan {
  private readonly resamplers: [Resampler, Resampler];
  private written: number;
  private done = false;
  private feedClosed = false;
  private readonly chain: FxChain | null;
  /** Конец звучания: конец клипа плюс хвост эффекта. */
  private readonly end: number;
  private tmp: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];

  constructor(
    readonly span: MixSpan,
    private readonly feed: SourceFeed,
    private readonly outRate: number,
  ) {
    // Целая позиция при совпадающих частотах даёт побитовое копирование.
    const raw = span.sourceTime * feed.sampleRate;
    const pos = Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : raw;
    this.resamplers = [new Resampler(feed.sampleRate, outRate, pos), new Resampler(feed.sampleRate, outRate, pos)];
    this.written = span.outStart;
    this.chain = hasFx(span.fx) ? new FxChain(span.fx, outRate) : null;
    this.end = span.outEnd + Math.round(fxTailSec(span.fx) * outRate);
  }

  /** Подмешивает отсчёты куска в block, покрывающий выход [blockStart, blockStart + len). */
  async mixInto(block: readonly [Float32Array, Float32Array], blockStart: number): Promise<void> {
    const from = Math.max(blockStart, this.written);
    const to = Math.min(blockStart + block[0].length, this.end);
    if (to <= from) return;
    const need = to - from;
    // Из исходника берём только до конца клипа; дальше тишина, на которой звучит хвост эффекта.
    const fromSource = Math.max(0, Math.min(to, this.span.outEnd) - from);
    if (this.tmp[0].length < need) this.tmp = [new Float32Array(need), new Float32Array(need)];
    const [l, r] = this.tmp;
    for (let ch = 0; ch < OUT_CHANNELS; ch++) {
      const buf = this.tmp[ch]!;
      let got = 0;
      // Подаём вход, пока ресемплер не сможет выдать нужное количество.
      while (got < fromSource) {
        const n = this.resamplers[ch]!.read(buf, got, fromSource - got);
        got += n;
        if (got < fromSource && n === 0) {
          if (!(await this.pull())) continue;
        }
      }
      for (let i = 0; i < fromSource; i++) buf[i] = buf[i]! * this.edgeGain(from + i) * this.envelope(from + i);
      buf.fill(0, fromSource, need);
    }
    this.chain?.process(l, r, need);
    for (let i = 0; i < need; i++) {
      block[0][from - blockStart + i]! += l[i]!;
      block[1][from - blockStart + i]! += r[i]!;
    }
    this.written = to;
    if (this.written >= this.span.outEnd) this.closeFeed();
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

  /** Ручки появления и затухания клипа (до эффектов: хвост реверберации затухает естественно). */
  private envelope(outIndex: number): number {
    const fx = this.span.fx;
    if (!fx || !hasFades(fx)) return 1;
    const start = this.span.clipStart ?? this.span.outStart;
    const end = this.span.clipEnd ?? this.span.outEnd;
    return fadeEnvelope(fx, (outIndex - start) / this.outRate, (end - start) / this.outRate);
  }

  private edgeGain(outIndex: number): number {
    const fromStart = outIndex - this.span.outStart;
    const toEnd = this.span.outEnd - 1 - outIndex;
    const edge = Math.min(fromStart, toEnd);
    return edge >= EDGE_FADE ? 1 : (edge + 1) / (EDGE_FADE + 1);
  }

  get finished(): boolean {
    return this.written >= this.end;
  }

  private closeFeed(): void {
    if (this.feedClosed) return;
    this.feedClosed = true;
    this.feed.close();
  }

  close(): void {
    this.closeFeed();
  }
}

export class Mixer {
  private readonly pending: MixSpan[];
  private active: ActiveSpan[] = [];
  private position = 0;

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

    while (this.pending.length && this.pending[0]!.outStart < start + len) {
      const span = this.pending.shift()!;
      if (span.outEnd <= span.outStart) continue;
      this.active.push(new ActiveSpan(span, await span.open(), this.outRate));
    }
    for (const a of this.active) await a.mixInto(channels, start);
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
