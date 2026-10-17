import {
  AudioSample,
  AudioSampleSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type StreamTargetChunk,
  VideoSample,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import type { EncodeSupport, RenderProgress, RenderStats } from '../application/ports';
import type { AssetId, MediaAsset } from '../domain/media';
import type { OutputSettings } from '../domain/export-preset';
import { type RenderPlan, videoSourceTime } from '../domain/render-plan';
import { framesToSeconds } from '../domain/time';
import { Mixer } from './audio/mixer';
import { mixSpansFor } from './audio/spans';
import { aacEncoderDelay } from './audio/encoder-delay';
import { Compositor } from './compositor';
import { MediaInputs } from './media-input';

/** Проверка до старта: умеет ли браузер кодировать с такими настройками. */
export async function checkEncodeSupport(s: OutputSettings): Promise<EncodeSupport> {
  const problems: string[] = [];
  const videoOk = await canEncodeVideo(s.video.codec, {
    width: s.width,
    height: s.height,
    bitrate: s.video.bitrate,
    frameRate: s.frameRate.num / s.frameRate.den,
  });
  if (!videoOk) {
    const name = s.video.codec === 'avc' ? 'H.264' : 'HEVC';
    problems.push(
      `Браузер не может кодировать ${name} ${s.width}×${s.height}.` +
        (s.video.codec === 'avc' ? ' Для вертикального 4K выберите HEVC.' : ''),
    );
  }
  const audioOk = await canEncodeAudio('aac', {
    numberOfChannels: s.audio.channels,
    sampleRate: s.audio.sampleRate,
    bitrate: s.audio.bitrate,
  });
  if (!audioOk) problems.push('Браузер не может кодировать звук AAC');
  return { ok: problems.length === 0, problems };
}

const AUDIO_BLOCK = 4096;
/** Звук пишется с опережением видео на столько секунд — для чередования в файле. */
const AUDIO_LEAD = 0.5;

/**
 * Рендер плана в поток. Файл пишется с Fast Start (индекс в начале файла,
 * место под него резервируется заранее), видео и звук чередуются — память
 * не растёт с длиной ролика. При ошибке или отмене выход отменяется,
 * а поток закрывается с ошибкой, так что недописанный файл не сохранится.
 */
export async function renderPlan(
  plan: RenderPlan,
  files: ReadonlyMap<AssetId, Blob>,
  writable: WritableStream<StreamTargetChunk>,
  onProgress: (p: RenderProgress) => void,
  signal: AbortSignal,
): Promise<RenderStats> {
  const started = performance.now();
  const { output: settings, frameRate: rate, totalFrames } = plan;
  const assets = new Map<AssetId, MediaAsset>(plan.assets.map((a) => [a.id, a]));
  const inputs = new MediaInputs<AssetId>((id) => {
    const f = files.get(id);
    if (!f) throw new Error(`Нет доступа к файлу ${assets.get(id)?.name ?? id}`);
    return f;
  });

  const outRate = settings.audio.sampleRate;
  const toAudioIndex = (frame: number) => Math.round((frame * outRate * rate.den) / rate.num);
  const totalSamples = toAudioIndex(totalFrames);
  const frameDuration = framesToSeconds(1, rate);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target: new StreamTarget(writable, { chunked: true }),
  });
  const videoSource = new VideoSampleSource({
    codec: settings.video.codec,
    quality: new Quality({ bitrate: settings.video.bitrate, bitrateMode: 'variable' }),
    keyFrameInterval: settings.video.keyFrameIntervalSec,
    latencyMode: 'quality',
  });
  const audioSource = new AudioSampleSource({
    codec: 'aac',
    quality: new Quality({ bitrate: settings.audio.bitrate }),
  });
  output.addVideoTrack(videoSource, { frameRate: rate.num / rate.den, maximumPacketCount: totalFrames + 16 });
  output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(totalSamples / 1024) + 64 });

  const mixSpans = mixSpansFor(plan, inputs, outRate);
  const mixer = new Mixer(mixSpans, outRate, totalSamples);
  const encoderDelay = await aacEncoderDelay(outRate, settings.audio.channels, settings.audio.bitrate);
  const compositor = new Compositor(settings.width, settings.height, plan.fit, rate.num / rate.den);

  let frame = 0;
  let lastReport = 0;

  const writeAudioUntil = async (seconds: number) => {
    const target = Math.min(totalSamples, Math.round(seconds * outRate));
    while (mixer.samplesWritten < target) {
      const block = await mixer.nextBlock(AUDIO_BLOCK);
      if (!block) break;
      const len = block.channels[0].length;
      const data = new Float32Array(len * 2);
      data.set(block.channels[0], 0);
      data.set(block.channels[1], len);
      const sample = new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate: outRate,
        // Сдвиг на задержку кодера: контейнер получит edit list, звук совпадёт с видео.
        timestamp: (block.start - encoderDelay) / outRate,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
    }
  };

  const emitFrame = async (image: OffscreenCanvas) => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Рендер отменён', 'AbortError');
    const t = framesToSeconds(frame, rate);
    await writeAudioUntil(t + frameDuration + AUDIO_LEAD);
    const sample = new VideoSample(image, { timestamp: t, duration: frameDuration });
    try {
      await videoSource.add(sample);
    } finally {
      sample.close();
    }
    frame++;
    const now = performance.now();
    if (now - lastReport > 250 || frame === totalFrames) {
      lastReport = now;
      const elapsedSec = (now - started) / 1000;
      onProgress({ frame, totalFrames, fps: frame / Math.max(elapsedSec, 1e-3), elapsedSec });
    }
  };

  try {
    await output.start();
    for (const span of plan.video) {
      const count = span.to - span.from;
      compositor.black();
      if (!span.source) {
        for (let i = 0; i < count; i++) await emitFrame(compositor.frame(span.overlays, i));
        continue;
      }
      const asset = assets.get(span.source.assetId)!;
      const sink = await inputs.get(asset.id).videoSamples();
      if (!sink) throw new Error(`В «${asset.name}» нет видео`);
      const sourceIn = span.source.sourceIn;
      function* times() {
        for (let i = 0; i < count; i++) yield videoSourceTime(asset, sourceIn + i, rate);
      }
      let emitted = 0;
      for await (const sample of sink.samplesAtTimestamps(times())) {
        // null — время раньше первого кадра: остаётся предыдущее содержимое холста (чёрный в начале куска).
        if (sample) {
          try {
            compositor.draw(sample);
          } finally {
            sample.close();
          }
        }
        await emitFrame(compositor.frame(span.overlays, emitted));
        emitted++;
      }
      if (emitted !== count) throw new Error(`«${asset.name}»: декодер выдал ${emitted} кадров вместо ${count}`);
    }
    if (frame !== totalFrames) throw new Error(`Собрано ${frame} кадров вместо ${totalFrames}`);
    await writeAudioUntil(Infinity);
    if (mixer.samplesWritten !== totalSamples) throw new Error('Звук записан не полностью');
    await output.finalize();
    return { frames: frame, audioSamples: totalSamples, elapsedSec: (performance.now() - started) / 1000 };
  } catch (err) {
    await output.cancel().catch(() => {});
    await writable.abort(err).catch(() => {});
    throw err;
  } finally {
    mixer.close();
    inputs.dispose();
  }
}
