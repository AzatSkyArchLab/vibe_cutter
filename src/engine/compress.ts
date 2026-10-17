import {
  ALL_FORMATS, type AudioSample, BlobSource, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget, type StreamTargetChunk,
} from 'mediabunny';
import type { CompressResult, RemuxResult, RenderProgress } from '../application/ports';
import { type CompressPlan, compressRenderPlan, correctedBitrate } from '../domain/compress';
import type { MediaAsset } from '../domain/media';
import { aacEncoderDelay } from './audio/encoder-delay';
import { renderPlan } from './render';

/** Поток записи с подсчётом итогового размера файла. */
export interface CountedWritable {
  readonly writable: WritableStream<StreamTargetChunk>;
  size(): number;
}

export function counted(inner: WritableStream<StreamTargetChunk>): CountedWritable {
  const writer = inner.getWriter();
  let size = 0;
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      size = Math.max(size, chunk.position + chunk.data.byteLength);
      await writer.write(chunk);
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });
  return { writable, size: () => size };
}

export interface CompressProgress {
  readonly pass: number;
  readonly progress: RenderProgress;
}

const MAX_PASSES = 3;

/**
 * Сжатие файла тем же движком, что и рендер. Аппаратный кодер держит средний
 * битрейт не идеально, поэтому после прохода сверяем размер: превышение цели
 * или заметный недобор — ещё один проход с поправленным битрейтом.
 * Каждый проход пишется в файл заново; на диске остаётся только последний.
 */
export async function compressFile(
  source: MediaAsset,
  file: Blob,
  plan: CompressPlan,
  open: () => Promise<WritableStream<StreamTargetChunk>>,
  onProgress: (p: CompressProgress) => void,
  signal: AbortSignal,
): Promise<CompressResult> {
  const started = performance.now();
  let bitrate = plan.videoBitrate;
  let best: { bytes: number; bitrate: number; pass: number } | null = null;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const out = counted(await open());
    await renderPlan(
      compressRenderPlan(source, plan, bitrate),
      new Map([[source.id, file]]),
      out.writable,
      (progress) => onProgress({ pass, progress }),
      signal,
    );
    const bytes = out.size();
    best = { bytes, bitrate, pass };
    const next = correctedBitrate(plan, bitrate, bytes);
    // Повтор, только если он что-то даёт: недобор поправляем один раз, превышение — до победного.
    const over = plan.targetBytes !== null && bytes > plan.targetBytes;
    if (next === null || (pass >= 2 && !over) || Math.abs(next - bitrate) < bitrate * 0.02) break;
    bitrate = next;
  }
  return { bytes: best!.bytes, passes: best!.pass, videoBitrate: best!.bitrate, elapsedSec: (performance.now() - started) / 1000 };
}

/** Кодеки, которые можно положить в MP4 без перекодирования. */
const MP4_AUDIO = new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac']);
const MP4_VIDEO = new Set(['avc', 'hevc', 'av1', 'vp9']);

/**
 * Смена контейнера (MOV → MP4 и т.п.) без перекодирования видео: быстро
 * и без потерь. Звук в формате, который MP4 не поддерживает (PCM из камеры),
 * перекодируется в AAC 48 кГц с компенсацией задержки кодера.
 */
export async function remuxFile(
  file: Blob,
  open: () => Promise<WritableStream<StreamTargetChunk>>,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<RemuxResult> {
  const started = performance.now();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const videoCodec = videoTrack ? await videoTrack.getCodec() : null;
    if (!videoTrack || !videoCodec || !MP4_VIDEO.has(videoCodec))
      throw new Error(`Видео ${videoCodec ?? ''} нельзя переложить в MP4 без перекодирования — используйте сжатие`.replace('  ', ' '));
    const audioTrack = await input.getPrimaryAudioTrack();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
    const copyAudio = !audioTrack || (audioCodec !== null && MP4_AUDIO.has(audioCodec));
    const delay = copyAudio ? 0 : await aacEncoderDelay(48000, 2, 192_000);

    const out = counted(await open());
    // Индекс в начало файла: в памяти для файлов до ~1.5 ГБ, иначе в конце (иначе не хватит памяти).
    const fastStart = file.size < 1.5e9 ? 'in-memory' : false;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new StreamTarget(out.writable, { chunked: true }) });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      audio: copyAudio
        ? undefined
        : {
            codec: 'aac',
            quality: new Quality({ bitrate: 192_000 }),
            sampleRate: 48000,
            numberOfChannels: 2,
            process: (s: AudioSample) => {
              s.setTimestamp(s.timestamp - delay / 48000);
              return s;
            },
          },
    });
    if (!conversion.isValid || conversion.discardedTracks.some((d) => d.track.isVideoTrack()))
      throw new Error('Этот файл нельзя переложить в MP4 без перекодирования — используйте сжатие');
    conversion.onProgress = (p) => onProgress(p);
    const abort = () => void conversion.cancel();
    signal.addEventListener('abort', abort);
    try {
      await conversion.execute();
      if (signal.aborted) throw signal.reason;
    } catch (err) {
      await out.writable.abort(err).catch(() => {});
      throw signal.aborted ? (signal.reason ?? err) : err;
    } finally {
      signal.removeEventListener('abort', abort);
    }
    return { bytes: out.size(), videoCopied: true, audioCopied: copyAudio, elapsedSec: (performance.now() - started) / 1000 };
  } finally {
    input.dispose();
  }
}
