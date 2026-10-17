import type { AudioSample, AudioSampleSink } from 'mediabunny';
import type { PcmChunk, SourceFeed } from './mixer';

/**
 * Поток декодированного звука исходника [from, to) в стерео planar float.
 * Частота берётся из первой декодированной порции (у HE-AAC она бывает
 * вдвое выше заявленной в контейнере). Индекс отсчёта считается от нуля
 * файла по метке времени каждой порции, поэтому пропуски не сдвигают звук.
 */
export async function openAudioFeed(sink: AudioSampleSink | null, from: number, to: number): Promise<SourceFeed> {
  if (!sink) return silentFeed();
  const iterator = sink.samples(Math.max(0, from), to);
  const first = await iterator.next();
  if (first.done || !first.value) return silentFeed();
  const sampleRate = first.value.sampleRate;
  let pending: AudioSample | null = first.value;
  let closed = false;
  return {
    sampleRate,
    async next(): Promise<PcmChunk | null> {
      if (closed) return null;
      let sample = pending;
      pending = null;
      if (!sample) {
        const r = await iterator.next();
        if (r.done || !r.value) return null;
        sample = r.value;
      }
      try {
        return toStereo(sample, sampleRate);
      } finally {
        sample.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      pending?.close();
      void iterator.return(undefined);
    },
  };
}

const silentFeed = (): SourceFeed => ({ sampleRate: 48000, next: async () => null, close() {} });

function toStereo(sample: AudioSample, rate: number): PcmChunk {
  const frames = sample.numberOfFrames;
  const plane = (i: number) => {
    const out = new Float32Array(frames);
    sample.copyTo(out, { planeIndex: i, format: 'f32-planar' });
    return out;
  };
  const left = plane(0);
  // Моно дублируем; из многоканального берём фронтальные L/R.
  const right = sample.numberOfChannels > 1 ? plane(1) : left.slice();
  return { index: Math.round(sample.timestamp * rate), channels: [left, right] };
}
