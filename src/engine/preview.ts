import type { MediaRef, PreviewEngine } from '../application/ports';
import { outputSettings } from '../domain/export-preset';
import type { AssetId, MediaAsset } from '../domain/media';
import { type Project, findAsset } from '../domain/project';
import { buildRenderPlan, videoSourceTime } from '../domain/render-plan';
import { framesToSeconds } from '../domain/time';
import { clipEnd, clipOnTrackAt, timelineEnd, tracksOfKind } from '../domain/timeline';
import { Mixer } from './audio/mixer';
import { mixSpansFor } from './audio/spans';
import { MediaInputs } from './media-input';

/** Сколько секунд звука держим запланированным впереди. */
const AUDIO_AHEAD = 0.4;
const AUDIO_BLOCK = 2048;

/**
 * Вьюер в браузере. Рисует в обычный холст тем же способом, что и рендер
 * (вписывание + приведение к sRGB), поэтому превью совпадает с результатом.
 * Часы воспроизведения — AudioContext: видео догоняет звук, отставшие кадры
 * пропускаются, а звук не рвётся.
 */
export class BrowserPreview implements PreviewEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private inputs: MediaInputs<AssetId> | null = null;
  private inputFiles = new Map<AssetId, MediaRef>();
  private pendingFrame: { project: Project; frame: number; media: ReadonlyMap<AssetId, MediaRef> } | null = null;
  private drawing = false;
  private session: PlaybackSession | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (!ctx) throw new Error('Не удалось создать холст вьюера');
    this.ctx = ctx;
  }

  get playing(): boolean {
    return this.session !== null;
  }

  /** Холст вьюера подстраивается под пропорции таймлайна (ограничиваем размер ради скорости). */
  private fitCanvas(project: Project): void {
    const { width, height } = project.settings;
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Открытые исходники переиспользуются, пока файл тот же. */
  private inputsFor(media: ReadonlyMap<AssetId, MediaRef>): MediaInputs<AssetId> {
    let same = this.inputs !== null && this.inputFiles.size === media.size;
    if (same) for (const [id, f] of media) if (this.inputFiles.get(id) !== f) same = false;
    if (!same) {
      this.inputs?.dispose();
      this.inputFiles = new Map(media);
      this.inputs = new MediaInputs<AssetId>((id) => {
        const f = this.inputFiles.get(id);
        if (!f) throw new Error('Файл недоступен');
        return f;
      });
    }
    return this.inputs!;
  }

  showFrame(project: Project, frame: number, media: ReadonlyMap<AssetId, MediaRef>): void {
    this.pendingFrame = { project, frame, media };
    if (!this.drawing) void this.drainFrames();
  }

  private async drainFrames(): Promise<void> {
    this.drawing = true;
    try {
      while (this.pendingFrame) {
        const req = this.pendingFrame;
        this.pendingFrame = null;
        if (this.session) continue;
        try {
          await this.drawStill(req.project, req.frame, req.media);
        } catch (err) {
          console.warn('Кадр превью не отрисован', err);
          this.drawMessage('Не удалось показать кадр');
        }
      }
    } finally {
      this.drawing = false;
    }
  }

  private async drawStill(project: Project, frame: number, media: ReadonlyMap<AssetId, MediaRef>): Promise<void> {
    this.fitCanvas(project);
    const tl = project.timeline;
    const tracks = tracksOfKind(tl, 'video');
    for (let i = tracks.length - 1; i >= 0; i--) {
      const clip = clipOnTrackAt(tracks[i]!, frame);
      if (!clip) continue;
      const asset = findAsset(project, clip.assetId);
      if (!asset) break;
      if (!media.has(asset.id)) return this.drawMessage(`Нет доступа: ${asset.name}`);
      const sink = await this.inputsFor(media).get(asset.id).videoSamples();
      const sample = await sink?.getSample(videoSourceTime(asset, clip.sourceIn + (frame - clip.start), tl.frameRate));
      if (this.pendingFrame) {
        sample?.close();
        return; // уже запрошен другой кадр
      }
      this.clear();
      if (sample) {
        sample.drawWithFit(this.ctx, { fit: project.settings.fit === 'fill' ? 'cover' : 'contain' });
        sample.close();
      }
      return;
    }
    this.clear();
  }

  private clear(): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawMessage(text: string): void {
    this.clear();
    this.ctx.fillStyle = '#c44';
    this.ctx.font = `${Math.round(this.canvas.height / 20)}px system-ui`;
    this.ctx.textAlign = 'center';
    this.ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
  }

  play(
    project: Project,
    from: number,
    media: ReadonlyMap<AssetId, MediaRef>,
    onFrame: (frame: number) => void,
    onEnd: (error?: Error) => void,
  ): void {
    this.stop();
    const end = timelineEnd(project.timeline);
    if (from >= end) return onEnd();
    for (const t of project.timeline.tracks)
      for (const c of t.clips)
        if (clipEnd(c) > from && !media.has(c.assetId)) {
          const name = findAsset(project, c.assetId)?.name ?? c.assetId;
          return onEnd(new Error(`Нет доступа к файлу «${name}»`));
        }
    this.fitCanvas(project);
    const session = new PlaybackSession(project, from, end, this.inputsFor(media), this.ctx, onFrame, (err) => {
      if (this.session === session) this.session = null;
      onEnd(err);
    });
    this.session = session;
    void session.start();
  }

  stop(): void {
    this.session?.stop();
    this.session = null;
  }
}

class PlaybackSession {
  private stopped = false;
  private audio: AudioContext | null = null;
  private startAt = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private raf = 0;
  private shownFrame = -1;

  constructor(
    private readonly project: Project,
    private readonly from: number,
    private readonly end: number,
    private readonly inputs: MediaInputs<AssetId>,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly onFrame: (frame: number) => void,
    private readonly onEnd: (err?: Error) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const { settings } = this.project;
      const plan = buildRenderPlan(
        this.project,
        outputSettings({ target: 'youtube', width: settings.width, height: settings.height, frameRate: settings.frameRate }),
        { from: this.from, to: this.end },
      );
      this.audio = new AudioContext({ latencyHint: 'playback' });
      // Без жеста пользователя браузер держит звук на паузе — тогда и часы стоят.
      await Promise.race([this.audio.resume(), sleep(500)]);
      if (this.audio.state !== 'running') throw new Error('браузер не разрешил звук — нажмите пробел ещё раз');
      const mixer = new Mixer(mixSpansFor(plan, this.inputs, this.audio.sampleRate), this.audio.sampleRate, Math.round(framesToSeconds(plan.totalFrames, plan.frameRate) * this.audio.sampleRate));
      // Небольшая задержка старта, чтобы успеть подготовить первые блоки звука и кадр.
      this.startAt = this.audio.currentTime + 0.15;
      const audioLoop = this.pumpAudio(mixer);
      this.tick();
      await Promise.all([audioLoop, this.pumpVideo(plan)]);
      mixer.close();
      // Дожидаемся конца звука.
      while (!this.stopped && this.elapsed() < framesToSeconds(plan.totalFrames, plan.frameRate)) await sleep(30);
      this.finish();
    } catch (err) {
      this.finish(err instanceof Error ? err : new Error(String(err)));
    }
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
  }

  private finish(err?: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.onEnd(err);
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* уже остановлен */
      }
    }
    this.sources.clear();
    void this.audio?.close().catch(() => {});
  }

  private elapsed(): number {
    return this.audio ? this.audio.currentTime - this.startAt : 0;
  }

  private tick = (): void => {
    if (this.stopped) return;
    const frame = this.from + Math.max(0, Math.floor(this.elapsed() * this.project.timeline.frameRate.num / this.project.timeline.frameRate.den));
    if (frame !== this.shownFrame) {
      this.shownFrame = frame;
      this.onFrame(Math.min(frame, this.end));
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private async pumpAudio(mixer: Mixer): Promise<void> {
    const audio = this.audio!;
    const rate = audio.sampleRate;
    while (!this.stopped && !mixer.done) {
      if (mixer.samplesWritten / rate > this.elapsed() + AUDIO_AHEAD) {
        await sleep(20);
        continue;
      }
      const block = await mixer.nextBlock(AUDIO_BLOCK);
      if (!block || this.stopped) break;
      const buffer = audio.createBuffer(2, block.channels[0].length, rate);
      buffer.copyToChannel(block.channels[0], 0);
      buffer.copyToChannel(block.channels[1], 1);
      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(audio.destination);
      node.onended = () => this.sources.delete(node);
      this.sources.add(node);
      node.start(Math.max(audio.currentTime, this.startAt + block.start / rate));
    }
  }

  private async pumpVideo(plan: ReturnType<typeof buildRenderPlan>): Promise<void> {
    const rate = plan.frameRate;
    const fit = this.project.settings.fit === 'fill' ? 'cover' : 'contain';
    const assets = new Map<AssetId, MediaAsset>(plan.assets.map((a) => [a.id, a]));
    for (const span of plan.video) {
      if (this.stopped) return;
      const count = span.to - span.from;
      if (!span.source) {
        await this.waitFor(framesToSeconds(span.from, rate));
        this.black();
        continue;
      }
      const asset = assets.get(span.source.assetId)!;
      const sink = await this.inputs.get(asset.id).videoSamples();
      if (!sink) continue;
      const sourceIn = span.source.sourceIn;
      // Пропускаем кадры, на которые уже опоздали к моменту старта куска.
      const skip = Math.max(0, Math.min(count - 1, Math.floor(this.elapsed() * rate.num / rate.den) - span.from));
      function* times() {
        for (let i = skip; i < count; i++) yield videoSourceTime(asset, sourceIn + i, rate);
      }
      let i = skip;
      for await (const sample of sink.samplesAtTimestamps(times())) {
        const at = framesToSeconds(span.from + i, rate);
        i++;
        if (this.stopped) {
          sample?.close();
          return;
        }
        const late = this.elapsed() - at > framesToSeconds(1, rate);
        if (sample && !late) {
          await this.waitFor(at);
          if (!this.stopped) {
            this.black();
            sample.drawWithFit(this.ctx, { fit });
          }
        }
        sample?.close();
      }
    }
  }

  private async waitFor(seconds: number): Promise<void> {
    while (!this.stopped) {
      const left = seconds - this.elapsed();
      if (left <= 0.002) return;
      await (left > 0.02 ? sleep(Math.min(left * 1000 - 10, 50)) : nextFrame());
    }
  }

  private black(): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
