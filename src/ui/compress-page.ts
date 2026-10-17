import type { Editor } from '../application/editor';
import type { FileCompressor, MediaProber, Task } from '../application/ports';
import {
  type CompressMode, type CompressPlan, type QualityLevel, type ResolutionChoice, GRADE_LABELS, RESOLUTION_STEPS, planCompression,
} from '../domain/compress';
import type { VideoCodecChoice } from '../domain/export-preset';
import type { AssetId, MediaAsset } from '../domain/media';
import { downloadBlob, pickRenderTarget, pickVideoFiles } from '../infrastructure/file-access';
import { h, setText } from './dom';
import { formatBytes, formatDuration, formatFps } from './format';

const SIZE_PRESETS = [10, 25, 50, 100, 250, 500];

/**
 * Сжатие отдельного файла: до нужного размера, по качеству или только смена
 * формата. Не трогает проект — работает с любым выбранным видео.
 */
export class CompressPage {
  readonly el: HTMLElement;
  private file: File | null = null;
  private source: MediaAsset | null = null;
  private mode: CompressMode = 'size';
  private targetMB = 50;
  private quality: QualityLevel = 'high';
  private resolution: ResolutionChoice = 'auto';
  private codec: VideoCodecChoice = 'avc';
  private audioKbps = 160;
  private task: Task<unknown> | null = null;
  private sourceUrl: string | null = null;
  private resultUrl: string | null = null;

  private readonly fileInfo: HTMLElement;
  private readonly settings: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly videoSwitch: HTMLElement;

  constructor(
    private readonly editor: Editor,
    private readonly prober: MediaProber,
    private readonly compressor: FileCompressor,
    modeSwitch: HTMLElement,
  ) {
    this.fileInfo = h('div', { class: 'spec' });
    this.settings = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    this.summary = h('div', { style: 'display:flex;flex-direction:column;gap:4px' });
    this.nameInput = h('input', { type: 'text', spellcheck: false });
    this.runBtn = h('button', { class: 'primary', onclick: () => void this.run() }, 'Сжать');
    this.cancelBtn = h('button', { onclick: () => this.task?.cancel(), style: 'display:none' }, 'Отменить');
    this.bar = h('div');
    this.status = h('div', { class: 'render-status' });
    this.video = h('video', { controls: true, playsInline: true, class: 'compress-video' });
    this.videoSwitch = h('div', { class: 'seg', style: 'display:none' });
    const drop = h('div', { class: 'compress-drop' }, h('div', {}, 'Перетащите видео сюда'), h('div', { class: 'spec' }, 'MP4, MOV, M4V, MKV, WebM'));

    this.el = h(
      'div',
      { class: 'page deliver' },
      h(
        'div',
        { class: 'deliver-settings' },
        modeSwitch,
        h('section', {}, h('div', { style: 'display:flex;gap:8px;align-items:center' }, h('button', { onclick: () => void this.choose() }, 'Выбрать видео…')), this.fileInfo),
        h('section', {}, this.settings),
        h('section', {}, this.summary, h('label', {}, 'Имя файла', this.nameInput)),
        h('section', {}, h('div', { style: 'display:flex;gap:8px' }, this.runBtn, this.cancelBtn), h('div', { class: 'progress' }, this.bar), this.status),
      ),
      h('div', { class: 'compress-right' }, this.videoSwitch, this.video, drop),
    );
    // Перетаскивание файла на страницу сжатия — выбор исходника, а не импорт в проект.
    this.el.addEventListener('dragover', (e) => e.dataTransfer?.types.includes('Files') && (e.preventDefault(), e.stopPropagation()));
    this.el.addEventListener('drop', (e) => {
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('video/') || /\.(mov|mp4|m4v|mkv|webm)$/i.test(x.name));
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      void this.setFile(f);
    });
    this.render();
  }

  get busy(): boolean {
    return this.task !== null;
  }

  private async choose(): Promise<void> {
    const [picked] = await pickVideoFiles().catch(() => []);
    if (picked) await this.setFile(picked.file);
  }

  private async setFile(file: File): Promise<void> {
    if (this.busy) return;
    this.setStatus('Читаю файл…');
    try {
      const meta = await this.prober.probe(file);
      this.file = file;
      this.source = { id: 'compress-source' as AssetId, ...meta };
      this.resolution = 'auto';
      // Цель по умолчанию — примерно треть исходника, округлённая до «красивого» числа.
      this.targetMB = niceSize(file.size / 1e6 / 3);
      this.setStatus('');
      this.bar.style.width = '0%';
      if (this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);
      if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
      this.sourceUrl = URL.createObjectURL(file);
      this.resultUrl = null;
      delete this.nameInput.dataset.touched;
      this.setVideo('source');
    } catch (err) {
      this.setStatus(`Не удалось прочитать файл: ${err instanceof Error ? err.message : err}`, 'err');
    }
    this.render();
  }

  private plan(): { plan: CompressPlan | null; error: string | null } {
    if (!this.source || this.mode === 'remux') return { plan: null, error: null };
    try {
      return {
        plan: planCompression(this.source, {
          mode: this.mode,
          targetMB: this.targetMB,
          quality: this.quality,
          resolution: this.resolution,
          codec: this.codec,
          audioKbps: this.audioKbps,
        }),
        error: null,
      };
    } catch (err) {
      return { plan: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private render(): void {
    const s = this.source;
    const v = s?.video;
    this.fileInfo.replaceChildren(
      ...(s && this.file
        ? [
            h('div', {}, h('b', {}, s.name)),
            h('div', {}, `${formatBytes(this.file.size)} · ${formatDuration(s.duration)} · ${v ? `${v.width}×${v.height} · ${formatFps(v.frameRate.num, v.frameRate.den)} к/с` : 'без видео'}`),
            h('div', {}, `Видео: ${v?.codec ?? '—'}${v?.hdr ? ' · HDR' : ''}${v?.variableFrameRate ? ' · VFR' : ''} · звук: ${s.audio?.codec ?? 'нет'}`),
          ]
        : [h('div', {}, 'Выберите или перетащите видео — проект при этом не меняется.')]),
    );

    const seg = <T extends string | number>(options: [T, string][], get: () => T, set: (v: T) => void) =>
      h('div', { class: 'seg' }, ...options.map(([val, label]) => h('button', { class: get() === val ? 'on' : '', onclick: () => (set(val), this.render()) }, label)));

    const rows: HTMLElement[] = [
      h('label', {}, 'Что сделать', seg<CompressMode>([['size', 'До размера'], ['quality', 'По качеству'], ['remux', 'Сменить формат']], () => this.mode, (m) => (this.mode = m))),
    ];
    if (this.mode === 'size') {
      const input = h('input', {
        type: 'number',
        min: 1,
        step: 1,
        value: String(this.targetMB),
        class: 'num',
        onchange: () => {
          const n = Number(input.value);
          if (n > 0) this.targetMB = n;
          this.render();
        },
      });
      rows.push(
        h(
          'label',
          {},
          'Размер файла, МБ',
          h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, input, ...SIZE_PRESETS.map((mb) => h('button', { class: `chip ${mb === this.targetMB ? 'on' : ''}`, onclick: () => ((this.targetMB = mb), this.render()) }, String(mb)))),
        ),
      );
    }
    if (this.mode === 'quality')
      rows.push(h('label', {}, 'Качество', seg<QualityLevel>([['high', 'Высокое'], ['medium', 'Среднее'], ['low', 'Экономное']], () => this.quality, (q) => (this.quality = q))));
    if (this.mode !== 'remux') {
      const short = v ? Math.min(v.width, v.height) : 2160;
      const res = h(
        'select',
        { onchange: () => ((this.resolution = (isNaN(Number(res.value)) ? res.value : Number(res.value)) as ResolutionChoice), this.render()) },
        ...(this.mode === 'size' ? [h('option', { value: 'auto' }, 'Авто — под размер файла')] : []),
        h('option', { value: 'source' }, `Как в исходнике${v ? ` (${v.width}×${v.height})` : ''}`),
        ...RESOLUTION_STEPS.filter((r) => r < short).map((r) => h('option', { value: String(r) }, `${r}p`)),
      );
      if (this.mode !== 'size' && this.resolution === 'auto') this.resolution = 'source';
      res.value = String(this.resolution);
      rows.push(
        h('label', {}, 'Разрешение', res),
        h('label', {}, 'Кодек', seg<VideoCodecChoice>([['avc', 'H.264 — открывается везде'], ['hevc', 'HEVC — меньше файл']], () => this.codec, (c) => (this.codec = c))),
        h('label', {}, 'Звук', seg<number>([[96, '96'], [128, '128'], [160, '160'], [256, '256 кбит/с']], () => this.audioKbps, (k) => (this.audioKbps = k))),
      );
    }
    this.settings.replaceChildren(...rows);

    // Итог
    const { plan, error } = this.plan();
    const notes: HTMLElement[] = [];
    if (this.mode === 'remux' && s) {
      const copyAudio = !s.audio || ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac'].includes(s.audio.codec);
      notes.push(
        h('div', { class: 'spec' }, 'Видео: ', h('b', {}, 'копируется без потерь и без перекодирования')),
        h('div', { class: 'spec' }, 'Звук: ', h('b', {}, copyAudio ? 'копируется как есть' : `${s.audio!.codec} → AAC 192 кбит/с`)),
        h('div', { class: 'spec' }, 'Размер: ', h('b', {}, `≈ ${this.file ? formatBytes(this.file.size) : '—'}`), copyAudio ? '' : ' (меньше за счёт звука)'),
      );
      if (!v || !['avc', 'hevc', 'av1', 'vp9'].includes(v.codec)) notes.push(h('div', { class: 'err' }, `Видео ${v?.codec ?? ''} нельзя переложить в MP4 без перекодирования — выберите «До размера» или «По качеству».`));
    }
    if (plan) {
      notes.push(
        h('div', { class: 'spec' }, 'Результат: ', h('b', {}, `${plan.width}×${plan.height} · ${plan.codec === 'avc' ? 'H.264' : 'HEVC'} · видео ${(plan.videoBitrate / 1e6).toFixed(2)} Мбит/с`)),
        h('div', { class: 'spec' }, 'Размер: ', h('b', {}, `≈ ${formatBytes(plan.estimatedBytes)}`), plan.targetBytes ? ` · не больше ${formatBytes(plan.targetBytes)}` : ''),
        h('div', { class: 'spec' }, 'Качество: ', h('b', { class: `grade ${plan.grade}` }, GRADE_LABELS[plan.grade])),
        ...plan.warnings.map((w) => h('div', { class: 'warn' }, '• ' + w)),
      );
    }
    if (error) notes.push(h('div', { class: 'err' }, error));
    if (s && v && !v.decodable && this.mode !== 'remux') notes.push(h('div', { class: 'err' }, `Браузер не умеет декодировать видео ${v.codec}`));
    this.summary.replaceChildren(...notes);

    if (s && !this.nameInput.dataset.touched) this.nameInput.value = `${s.name.replace(/\.[^.]+$/, '')}${this.mode === 'remux' ? '' : '_сжато'}`;
    this.nameInput.oninput = () => (this.nameInput.dataset.touched = '1');
    setText(this.runBtn, this.mode === 'remux' ? 'Сменить формат' : 'Сжать');
    const remuxBlocked = this.mode === 'remux' && (!v || !['avc', 'hevc', 'av1', 'vp9'].includes(v.codec));
    this.runBtn.disabled = this.busy || !s || (this.mode !== 'remux' && (!plan || !v?.decodable)) || remuxBlocked;
  }

  private async run(): Promise<void> {
    if (!this.file || !this.source || this.busy) return;
    const { plan } = this.plan();
    if (this.mode !== 'remux' && !plan) return;
    const name = `${this.nameInput.value.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'video'}.mp4`;
    const handle = await pickRenderTarget(name);
    if (handle === 'canceled') return;
    const target = handle ? ({ kind: 'file', handle } as const) : ({ kind: 'memory' } as const);

    this.setBusy(true);
    this.bar.style.width = '0%';
    this.setStatus('Подготовка…');
    const started = performance.now();
    try {
      let bytes: number;
      let blob: Blob | null;
      let extra = '';
      if (this.mode === 'remux') {
        const task = this.compressor.remux(this.file, target, (f) => {
          this.bar.style.width = `${(f * 100).toFixed(1)}%`;
          this.setStatus(`Перекладываю в MP4 · ${(f * 100).toFixed(0)}%`);
        });
        this.task = task;
        const r = await task.done;
        bytes = r.result.bytes;
        blob = r.blob;
      } else {
        const task = this.compressor.compress(this.source, this.file, plan!, target, (pass, p) => {
          const pct = (p.frame / p.totalFrames) * 100;
          this.bar.style.width = `${pct.toFixed(1)}%`;
          const left = p.fps > 0 ? (p.totalFrames - p.frame) / p.fps : 0;
          this.setStatus(`${pass > 1 ? `Проход ${pass}: подгоняю размер · ` : ''}кадр ${p.frame} из ${p.totalFrames} · ${p.fps.toFixed(0)} к/с · осталось ${formatDuration(left)}`);
        });
        this.task = task;
        const r = await task.done;
        bytes = r.result.bytes;
        blob = r.blob;
        if (r.result.passes > 1) extra = ` · проходов: ${r.result.passes}`;
      }
      this.bar.style.width = '100%';
      const ratio = this.file.size / Math.max(1, bytes);
      this.setStatus(
        `Готово: ${formatBytes(bytes)}${ratio > 1.05 ? ` — в ${ratio.toFixed(1)} раза меньше` : ''} · за ${formatDuration((performance.now() - started) / 1000)}${extra}`,
        'ok',
      );
      const resultFile = blob ?? (handle ? await handle.getFile() : null);
      if (blob) downloadBlob(blob, name);
      if (resultFile) {
        if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
        this.resultUrl = URL.createObjectURL(resultFile);
        this.setVideo('result');
      }
      this.editor.notify('info', `Готово: ${handle ? handle.name : name}`);
    } catch (err) {
      const canceled = err instanceof Error && err.name === 'AbortError';
      this.bar.style.width = '0%';
      this.setStatus(canceled ? 'Отменено' : `Ошибка: ${err instanceof Error ? err.message : err}`, canceled ? '' : 'err');
    } finally {
      this.task = null;
      this.setBusy(false);
    }
  }

  /** Плеер справа: исходник или результат — для сравнения на глаз. */
  private setVideo(which: 'source' | 'result'): void {
    const url = which === 'source' ? this.sourceUrl : this.resultUrl;
    if (url && this.video.src !== url) {
      const t = this.video.currentTime;
      this.video.src = url;
      this.video.currentTime = t;
    }
    this.videoSwitch.style.display = this.resultUrl ? '' : 'none';
    this.videoSwitch.replaceChildren(
      h('button', { class: which === 'source' ? 'on' : '', onclick: () => this.setVideo('source') }, 'Исходник'),
      h('button', { class: which === 'result' ? 'on' : '', onclick: () => this.setVideo('result') }, 'Результат'),
    );
    this.el.classList.toggle('has-video', !!url);
  }

  private setBusy(b: boolean): void {
    this.cancelBtn.style.display = b ? '' : 'none';
    this.render();
  }

  private setStatus(text: string, cls = ''): void {
    this.status.className = `render-status ${cls}`;
    setText(this.status, text);
  }
}

/** 1, 2, 5, 10, 20, 25, 50, 100… — ближайшее «круглое» значение не больше x. */
function niceSize(x: number): number {
  const steps = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
  return [...steps].reverse().find((s) => s <= x) ?? 1;
}
