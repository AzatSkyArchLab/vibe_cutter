import {
  AudioSampleSink, AudioSample, AudioSampleSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality,
  VideoSampleSink, ALL_FORMATS, BlobSource, Input,
} from 'mediabunny';
import { aacEncoderDelay } from '../engine/audio/encoder-delay';

/**
 * Тестовые исходники и проверка рендера (только для разработки).
 *
 * В каждом кадре закодирован его номер: 14 клеток в полосе по центру,
 * клетка 0 — всегда белая (метка «кадр не чёрный»), клетки 1..13 — биты номера.
 * Звук: тихий тон 440 Гц, а в кадрах с номером, кратным 30, — громкий щелчок
 * длиной ровно в кадр. Это позволяет проверить и точность резов, и синхронизацию.
 */

const CELLS = 14;

export interface TestMediaOptions {
  width: number;
  height: number;
  fps: number;
  frames: number;
  sampleRate?: number;
  /** Дрожание меток времени, доля кадра — имитация переменной частоты iPhone. */
  jitter?: number;
  name?: string;
}

export async function makeTestVideo(o: TestMediaOptions): Promise<File> {
  const canvas = new OffscreenCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 8e6 }), keyFrameInterval: 1 });
  const audio = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 192e3 }) });
  output.addVideoTrack(video, { frameRate: o.fps });
  output.addAudioTrack(audio);
  await output.start();

  const rate = o.sampleRate ?? 48000;
  const delay = await aacEncoderDelay(rate, 2, 192e3);
  const perFrame = rate / o.fps;
  for (let i = 0; i < o.frames; i++) {
    drawFrame(ctx, o.width, o.height, i);
    const jitter = o.jitter && i > 0 ? (Math.sin(i * 12.9898) * o.jitter) / o.fps : 0;
    await video.add(i / o.fps + jitter, 1 / o.fps);

    const from = Math.round(i * perFrame);
    const to = Math.round((i + 1) * perFrame);
    const data = new Float32Array((to - from) * 2);
    for (let k = 0; k < to - from; k++) {
      const n = from + k;
      const v = i % 30 === 0 ? 0.8 * Math.sign(Math.sin((2 * Math.PI * 1000 * n) / rate)) : 0.05 * Math.sin((2 * Math.PI * 440 * n) / rate);
      data[k] = v;
      data[to - from + k] = v;
    }
    const s = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp: (from - delay) / rate });
    await audio.add(s);
    s.close();
  }
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer!;
  return new File([buf], o.name ?? `test_${o.width}x${o.height}_${o.fps}.mp4`, { type: 'video/mp4' });
}

function drawFrame(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, index: number) {
  ctx.fillStyle = `hsl(${(index * 7) % 360} 40% 25%)`;
  ctx.fillRect(0, 0, w, h);
  const band = cellRect(w, h);
  for (let c = 0; c < CELLS; c++) {
    const on = c === 0 || ((index >> (c - 1)) & 1) === 1;
    ctx.fillStyle = on ? '#fff' : '#000';
    ctx.fillRect(band.x + c * band.cell, band.y, band.cell, band.cell);
  }
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(h / 8)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText(`#${index}`, w / 2, h * 0.3);
}

/** Полоса с клетками — квадрат по центру кадра, одинаковая при любом вписывании «по ширине». */
function cellRect(w: number, h: number) {
  const size = Math.min(w, h) * 0.9;
  const cell = size / CELLS;
  return { x: (w - size) / 2, y: h / 2 - cell / 2, cell };
}

/** Читает номер кадра из закодированной полосы; −1 — кадр чёрный (метки нет). */
export function readFrameIndex(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): number {
  const band = cellRect(w, h);
  const lum = (c: number) => {
    const px = ctx.getImageData(Math.round(band.x + (c + 0.5) * band.cell), Math.round(band.y + band.cell / 2), 1, 1).data;
    return (px[0]! + px[1]! + px[2]!) / 3;
  };
  if (lum(0) < 128) return -1;
  let n = 0;
  for (let c = 1; c < CELLS; c++) if (lum(c) >= 128) n |= 1 << (c - 1);
  return n;
}

export interface DecodedCheck {
  frameIndices: number[];
  timestamps: number[];
  /** Номера выходных кадров, на которые приходится начало щелчка. */
  clickFrames: number[];
  audioDuration: number;
  videoDuration: number;
  audioSampleRate: number;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number;
  height: number;
  colorSpace: VideoColorSpaceInit;
  /** Положение moov относительно mdat — Fast Start. */
  moovBeforeMdat: boolean;
}

/** Декодирует результат рендера и извлекает всё нужное для проверки. */
export async function inspectRender(file: Blob, fps: number): Promise<DecodedCheck> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const vt = (await input.getPrimaryVideoTrack())!;
  const at = await input.getPrimaryAudioTrack();
  const w = await vt.getDisplayWidth();
  const h = await vt.getDisplayHeight();
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const frameIndices: number[] = [];
  const timestamps: number[] = [];
  for await (const s of new VideoSampleSink(vt).samples()) {
    s.draw(ctx, 0, 0, w, h);
    frameIndices.push(readFrameIndex(ctx, w, h));
    timestamps.push(s.timestamp);
    s.close();
  }

  const clickFrames: number[] = [];
  let audioDuration = 0;
  let audioSampleRate = 0;
  if (at) {
    let inClick = false;
    let quiet = 0;
    for await (const s of new AudioSampleSink(at).samples()) {
      audioSampleRate = s.sampleRate;
      const data = new Float32Array(s.numberOfFrames);
      s.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
      for (let k = 0; k < data.length; k++) {
        const loud = Math.abs(data[k]!) > 0.4;
        if (loud && !inClick) {
          inClick = true;
          clickFrames.push(Math.floor((s.timestamp + k / s.sampleRate) * fps + 1e-6));
        }
        if (!loud && inClick && ++quiet > s.sampleRate / fps / 2) (inClick = false), (quiet = 0);
        if (loud) quiet = 0;
      }
      audioDuration = s.timestamp + s.duration;
      s.close();
    }
  }

  const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
  const text = new TextDecoder('latin1').decode(head);
  const moov = text.indexOf('moov');
  const mdat = text.indexOf('mdat');

  const result: DecodedCheck = {
    frameIndices,
    timestamps,
    clickFrames,
    audioDuration,
    videoDuration: await vt.computeDuration(),
    audioSampleRate,
    videoCodec: await vt.getCodecParameterString(),
    audioCodec: at ? await at.getCodecParameterString() : null,
    width: w,
    height: h,
    colorSpace: await vt.getColorSpace(),
    moovBeforeMdat: moov !== -1 && (mdat === -1 || moov < mdat),
  };
  input.dispose();
  return result;
}
