import type { AudioInfo, MediaMetadata, VideoInfo } from '../domain/media';
import { snapToStandardFrameRate } from '../domain/time';
import { MediaInput } from './media-input';

/** Читает метаданные файла. Ошибку бросает с понятным текстом. */
export async function probeMedia(file: File): Promise<MediaMetadata> {
  const media = new MediaInput(file);
  try {
    if (!(await media.input.canRead())) throw new Error(`«${file.name}»: формат не поддерживается`);
    const [vt, at] = await Promise.all([media.video(), media.audio()]);
    if (!vt && !at) throw new Error(`«${file.name}»: нет ни видео, ни звука`);

    let video: VideoInfo | null = null;
    if (vt) {
      const metrics = await vt.computeFrameRateMetrics();
      const measured = metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate;
      video = {
        codec: (await vt.getCodec()) ?? 'unknown',
        width: await vt.getDisplayWidth(),
        height: await vt.getDisplayHeight(),
        frameRate: snapToStandardFrameRate(measured),
        variableFrameRate: !metrics.frameRateIsConstant,
        hdr: await vt.hasHighDynamicRange(),
        decodable: await vt.canDecode(),
      };
    }

    let audio: AudioInfo | null = null;
    if (at) {
      audio = {
        codec: (await at.getCodec()) ?? 'unknown',
        sampleRate: await at.getSampleRate(),
        channels: await at.getNumberOfChannels(),
        decodable: await at.canDecode(),
      };
    }

    // За начало и конец берём видео: звук AAC обычно чуть длиннее (добивка кадра кодера),
    // и по нему в конце клипа появился бы лишний повторённый кадр.
    const main = vt ?? at!;
    const startTime = await main.getFirstTimestamp();
    const end = await main.computeDuration();
    return {
      name: file.name,
      sizeBytes: file.size,
      startTime,
      duration: Math.max(0, end - startTime),
      video,
      audio,
    };
  } finally {
    media.dispose();
  }
}
