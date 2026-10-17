import type { Editor, EditorState } from '../application/editor';
import type { RenderEngine, RenderTask } from '../application/ports';
import { type ExportTarget, type OutputSettings, type VideoCodecChoice, TARGET_LABELS, outputSettings } from '../domain/export-preset';
import { RESOLUTIONS, orientation } from '../domain/project';
import { buildRenderPlan } from '../domain/render-plan';
import { formatTimecode } from '../domain/time';
import { timelineEnd } from '../domain/timeline';
import { downloadBlob, pickRenderTarget } from '../infrastructure/file-access';
import { h, setText } from './dom';
import { formatBytes, formatDuration, formatFps } from './format';

type Range = 'all' | 'inout';

/** Страница рендера (Deliver): пресеты под YouTube/Kinescope, проверка, прогресс. */
export class DeliverPage {
  readonly el: HTMLElement;
  private target: ExportTarget = 'youtube';
  private codec: VideoCodecChoice = 'avc';
  private resolution: string | null = null; // «ширина×высота», null — как у таймлайна
  private range: Range = 'all';
  private task: RenderTask | null = null;
  private checkSeq = 0;

  private readonly targetSeg: HTMLElement;
  private readonly codecSeg: HTMLElement;
  private readonly rangeSeg: HTMLElement;
  private readonly resSelect: HTMLSelectElement;
  private readonly nameInput: HTMLInputElement;
  private readonly spec: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly renderBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;

  constructor(
    private readonly editor: Editor,
    private readonly engine: RenderEngine,
    viewerSlot: HTMLElement,
    modeSwitch: HTMLElement,
  ) {
    const seg = <T extends string>(options: [T, string][], get: () => T, set: (v: T) => void) => {
      const el = h('div', { class: 'seg' });
      const sync = () => [...el.children].forEach((b, i) => b.classList.toggle('on', options[i]![0] === get()));
      for (const [v, label] of options) el.append(h('button', { onclick: () => (set(v), sync(), this.refresh()) }, label));
      sync();
      return el;
    };
    this.targetSeg = seg<ExportTarget>([['youtube', TARGET_LABELS.youtube], ['kinescope', TARGET_LABELS.kinescope]], () => this.target, (v) => (this.target = v));
    this.codecSeg = seg<VideoCodecChoice>([['avc', 'H.264'], ['hevc', 'HEVC (H.265)']], () => this.codec, (v) => (this.codec = v));
    this.rangeSeg = seg<Range>([['all', 'Весь таймлайн'], ['inout', 'In – Out']], () => this.range, (v) => (this.range = v));
    this.resSelect = h('select', { onchange: () => ((this.resolution = this.resSelect.value || null), this.refresh()) });
    this.nameInput = h('input', { type: 'text', spellcheck: false });
    this.spec = h('div', { class: 'spec' });
    this.notes = h('div', { style: 'display:flex;flex-direction:column;gap:4px' });
    this.renderBtn = h('button', { class: 'primary', onclick: () => void this.start() }, 'Рендер');
    this.cancelBtn = h('button', { onclick: () => this.task?.cancel(), style: 'display:none' }, 'Отменить');
    this.bar = h('div');
    this.status = h('div', { class: 'render-status' });

    this.el = h(
      'div',
      { class: 'page deliver' },
      h(
        'div',
        { class: 'deliver-settings' },
        modeSwitch,
        h('section', {}, h('label', {}, 'Платформа', this.targetSeg), h('label', {}, 'Разрешение', this.resSelect), h('label', {}, 'Кодек', this.codecSeg)),
        h('section', {}, h('label', {}, 'Диапазон', this.rangeSeg), h('label', {}, 'Имя файла', this.nameInput)),
        h('section', {}, this.spec, this.notes),
        h(
          'section',
          {},
          h('div', { style: 'display:flex;gap:8px' }, this.renderBtn, this.cancelBtn),
          h('div', { class: 'progress' }, this.bar),
          this.status,
        ),
      ),
      h('div', { class: 'deliver-right' }, viewerSlot),
    );
    editor.subscribe((s) => this.onState(s));
    this.onState(editor.state);
  }

  get busy(): boolean {
    return this.task !== null;
  }

  private lastProject: EditorState['project'] | null = null;
  private lastMarks: EditorState['marks'] | null = null;

  private onState(s: EditorState): void {
    if (s.project === this.lastProject && s.marks === this.lastMarks) return;
    if (this.lastProject?.name !== s.project.name || !this.nameInput.value) this.nameInput.value = safeName(s.project.name);
    this.lastProject = s.project;
    this.lastMarks = s.marks;
    this.refresh();
  }

  private settings(): OutputSettings {
    const p = this.editor.project.settings;
    const [w, hgt] = this.resolution ? this.resolution.split('x').map(Number) : [p.width, p.height];
    return outputSettings({ target: this.target, width: w!, height: hgt!, frameRate: p.frameRate, codec: this.codec });
  }

  private rangeFrames(): { from: number; to: number } | undefined {
    if (this.range !== 'inout') return undefined;
    const { marks } = this.editor.state;
    return { from: marks.in ?? 0, to: marks.out ?? timelineEnd(this.editor.timeline) };
  }

  private refresh(): void {
    const p = this.editor.project.settings;
    // Разрешения той же ориентации, что и таймлайн.
    const options = RESOLUTIONS.filter((r) => orientation(r) === orientation(p));
    const current = this.resolution;
    this.resSelect.replaceChildren(
      h('option', { value: '' }, `Как у таймлайна — ${p.width}×${p.height}`),
      ...options.filter((r) => r.width !== p.width || r.height !== p.height).map((r) => h('option', { value: `${r.width}x${r.height}` }, `${r.label} — ${r.width}×${r.height}`)),
    );
    this.resSelect.value = current && options.some((r) => `${r.width}x${r.height}` === current) ? current : '';
    if (!this.resSelect.value) this.resolution = null;

    const s = this.settings();
    const rate = p.frameRate;
    const notes: HTMLElement[] = [];
    let frames = 0;
    try {
      const plan = buildRenderPlan(this.editor.project, s, this.rangeFrames());
      frames = plan.totalFrames;
      for (const w of plan.warnings) notes.push(h('div', { class: 'warn' }, '• ' + w));
      const offline = plan.assets.filter((a) => this.editor.state.media.get(a.id) !== 'online');
      for (const a of offline) notes.push(h('div', { class: 'err' }, `• Нет доступа к «${a.name}» — подключите файл в Media Pool`));
      this.renderBtn.disabled = this.busy || offline.length > 0;
    } catch (err) {
      notes.push(h('div', { class: 'err' }, err instanceof Error ? err.message : String(err)));
      this.renderBtn.disabled = true;
    }
    this.spec.replaceChildren(
      h('div', {}, 'Видео: ', h('b', {}, `${s.video.codec === 'avc' ? 'H.264 High' : 'HEVC Main'} · ${s.width}×${s.height} · ${formatFps(rate.num, rate.den)} к/с · ${(s.video.bitrate / 1e6).toFixed(0)} Мбит/с`)),
      h('div', {}, 'Звук: ', h('b', {}, `AAC-LC · 48 кГц · стерео · до ${s.audio.bitrate / 1000} кбит/с`)),
      h('div', {}, 'Файл: ', h('b', {}, 'MP4 · Fast Start · ключевой кадр каждые 0.5 с · Rec.709 SDR')),
      h('div', {}, 'Длительность: ', h('b', {}, `${formatTimecode(frames, rate)} · ≈ ${formatBytes((frames / (rate.num / rate.den)) * (s.video.bitrate + s.audio.bitrate) / 8)}`)),
    );
    this.notes.replaceChildren(...notes);
    // Проверка кодека в фоне; устаревшие ответы игнорируем.
    const seq = ++this.checkSeq;
    void this.engine.check(s).then((support) => {
      if (seq !== this.checkSeq || support.ok) return;
      this.notes.append(...support.problems.map((p) => h('div', { class: 'err' }, '• ' + p)));
      this.renderBtn.disabled = true;
    });
  }

  private async start(): Promise<void> {
    if (this.task) return;
    const s = this.settings();
    let plan;
    try {
      plan = buildRenderPlan(this.editor.project, s, this.rangeFrames());
    } catch (err) {
      return this.editor.notify('error', err instanceof Error ? err.message : String(err));
    }
    const name = `${safeName(this.nameInput.value) || 'render'}.mp4`;
    const handle = await pickRenderTarget(name);
    if (handle === 'canceled') return;

    this.setBusy(true);
    this.setStatus('Подготовка…');
    this.bar.style.width = '0%';
    const task = this.engine.render(plan, this.editor.onlineFiles(), handle ? { kind: 'file', handle } : { kind: 'memory' }, (p) => {
      const pct = (p.frame / p.totalFrames) * 100;
      this.bar.style.width = `${pct.toFixed(1)}%`;
      const left = p.fps > 0 ? (p.totalFrames - p.frame) / p.fps : 0;
      this.setStatus(`Кадр ${p.frame} из ${p.totalFrames} · ${p.fps.toFixed(0)} к/с · осталось ${formatDuration(left)}`);
    });
    this.task = task;
    try {
      const { stats, blob } = await task.done;
      const size = blob ? blob.size : (await handle!.getFile()).size;
      this.bar.style.width = '100%';
      this.setStatus(`Готово: ${handle ? handle.name : name} · ${formatBytes(size)} · за ${formatDuration(stats.elapsedSec)}`, 'ok');
      if (blob) downloadBlob(blob, name);
      this.editor.notify('info', `Рендер завершён: ${handle ? handle.name : name}`);
    } catch (err) {
      const canceled = err instanceof Error && err.name === 'AbortError';
      this.bar.style.width = '0%';
      this.setStatus(canceled ? 'Рендер отменён' : `Ошибка: ${err instanceof Error ? err.message : err}`);
      if (!canceled) this.editor.notify('error', `Рендер не удался: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.task = null;
      this.setBusy(false);
    }
  }

  private setBusy(b: boolean): void {
    this.cancelBtn.style.display = b ? '' : 'none';
    this.renderBtn.disabled = b;
    if (!b) this.refresh();
  }

  private setStatus(text: string, cls = ''): void {
    this.status.className = `render-status ${cls}`;
    setText(this.status, text);
  }
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim();
