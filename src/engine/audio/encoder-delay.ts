/**
 * Задержка AAC-кодера (priming): кодер выдаёт в начале потока несколько
 * сотен–тысяч отсчётов тишины, и без поправки звук в файле отстаёт от
 * видео (у AudioToolbox на Mac — 2112 отсчётов, ≈44 мс).
 *
 * WebCodecs эту величину не сообщает, поэтому меряем её один раз: кодируем
 * щелчок, декодируем обратно и смотрим, на сколько он сдвинулся. Затем
 * звук подаётся в кодер с отрицательным сдвигом — контейнер запишет edit list,
 * и плееры (и YouTube) отбросят тишину кодера.
 */
const cache = new Map<string, Promise<number>>();

export function aacEncoderDelay(sampleRate: number, channels: number, bitrate: number): Promise<number> {
  const key = `${sampleRate}/${channels}/${bitrate}`;
  let p = cache.get(key);
  if (!p) {
    p = measure(sampleRate, channels, bitrate);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** Битрейты AAC, которые понимают все системные кодеры (Windows Media Foundation — только они). */
const AAC_FALLBACK_BITRATES = [192_000, 160_000, 128_000, 96_000];

export interface AacProfile {
  readonly bitrate: number;
  /** Задержка кодера в отсчётах. */
  readonly delay: number;
}

/**
 * Битрейт AAC, который реально принимает кодер этой системы, и его задержка.
 * На Mac кодер берёт и 320 кбит/с, на Windows — только 96…192, поэтому
 * при отказе спускаемся к ближайшему поддерживаемому значению.
 */
export async function aacProfile(sampleRate: number, channels: number, desired: number): Promise<AacProfile> {
  const candidates = [desired, ...AAC_FALLBACK_BITRATES.filter((b) => b < desired)];
  let lastError: unknown = null;
  for (const bitrate of candidates) {
    try {
      return { bitrate, delay: await aacEncoderDelay(sampleRate, channels, bitrate) };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Кодер AAC недоступен: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function measure(sampleRate: number, channels: number, bitrate: number): Promise<number> {
  const total = sampleRate; // 1 с
  const onset = Math.round(sampleRate * 0.25);
  const burst = Math.round(sampleRate * 0.01);

  const chunks: EncodedAudioChunk[] = [];
  let decoderConfig: AudioDecoderConfig | undefined;
  let error: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e) => (error = e),
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate });
  if (error) throw error;
  const block = 1024;
  for (let from = 0; from < total; from += block) {
    const n = Math.min(block, total - from);
    const data = new Float32Array(n * channels);
    for (let i = 0; i < n; i++) {
      const k = from + i;
      const v = k >= onset && k < onset + burst ? (Math.floor(k / 12) % 2 ? 0.8 : -0.8) : 0;
      for (let c = 0; c < channels; c++) data[c * n + i] = v;
    }
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((from / sampleRate) * 1e6), data });
    encoder.encode(ad);
    ad.close();
  }
  try {
    await encoder.flush();
  } catch (err) {
    throw error ?? err;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (error) throw error;
  if (!decoderConfig) throw new Error('AAC-кодер не выдал конфигурацию');

  const decoded: Float32Array[] = [];
  const decoder = new AudioDecoder({
    output: (ad) => {
      const out = new Float32Array(ad.numberOfFrames);
      ad.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(out);
      ad.close();
    },
    error: (e) => (error = e),
  });
  decoder.configure(decoderConfig);
  for (const c of chunks) decoder.decode(c);
  await decoder.flush();
  decoder.close();
  if (error) throw error;

  let pos = 0;
  for (const block of decoded) {
    for (let i = 0; i < block.length; i++) if (Math.abs(block[i]!) > 0.4) return Math.max(0, pos + i - onset);
    pos += block.length;
  }
  throw new Error('Не удалось измерить задержку AAC-кодера');
}
