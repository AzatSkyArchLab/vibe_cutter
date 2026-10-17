import type { Editor, EditorState } from '../application/editor';
import type { AssetId, MediaAsset } from '../domain/media';
import { formatTimecode, secondsToFrames } from '../domain/time';
import { MediaInput } from '../engine/media-input';
import { type PickedFile, pickFolderVideos, pickVideoFiles } from '../infrastructure/file-access';
import { h } from './dom';
import { formatBytes, formatFps } from './format';
import { ASSET_MIME } from './timeline-view';

/** Media Pool: список исходников, импорт, статус доступа к файлам. */
export class MediaPool {
  readonly el: HTMLElement;
  private readonly list: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly items = new Map<AssetId, HTMLElement>();
  private readonly thumbs = new Map<AssetId, string>();
  private thumbQueue: Promise<void> = Promise.resolve();
  private lastAssets: readonly MediaAsset[] | null = null;
  private lastMedia: EditorState['media'] | null = null;

  constructor(private readonly editor: Editor) {
    this.list = h('div', { class: 'pool-list' });
    this.banner = h('div', { class: 'pool-banner', style: 'display:none' });
    this.el = h(
      'div',
      { class: 'pool' },
      h('div', { class: 'panel-head' }, h('span', { class: 'grow' }, 'Медиа'), h('button', { onclick: () => this.import(), title: 'Импорт видео (⌘I)' }, '+ Импорт')),
      this.banner,
      this.list,
    );
    editor.subscribe((s) => this.update(s));
    this.update(editor.state);
  }

  async import(): Promise<void> {
    try {
      const files = await pickVideoFiles();
      if (files.length) await this.editor.importFiles(files);
    } catch (err) {
      this.editor.notify('error', `Импорт не удался: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Подключить недостающие исходники проекта, не импортируя лишнего. */
  private async relink(pick: () => Promise<PickedFile[] | null>): Promise<void> {
    try {
      const files = await pick();
      if (!files) return;
      const n = await this.editor.relinkFiles(files);
      this.editor.notify(n ? 'info' : 'error', n ? `Подключено файлов: ${n}` : 'Среди выбранных нет исходников этого проекта (сравниваются имя и размер)');
    } catch (err) {
      this.editor.notify('error', `Не удалось подключить файлы: ${err instanceof Error ? err.message : err}`);
    }
  }

  private update(s: EditorState): void {
    const assets = s.project.assets;
    if (assets !== this.lastAssets || s.media !== this.lastMedia) {
      this.lastAssets = assets;
      this.lastMedia = s.media;
      this.rebuild(s);
    }
    for (const [id, el] of this.items) el.classList.toggle('sel', id === s.selectedAsset);
  }

  private rebuild(s: EditorState): void {
    this.list.replaceChildren();
    this.items.clear();
    if (s.project.assets.length === 0) {
      this.list.append(h('div', { class: 'pool-empty' }, 'Перетащите сюда видео', h('br'), 'MP4 и MOV с iPhone, камеры, OBS'));
    }
    for (const a of s.project.assets) {
      const status = s.media.get(a.id) ?? 'offline';
      const el = this.item(a, status);
      this.items.set(a.id, el);
      this.list.append(el);
      if (status === 'online' && !this.thumbs.has(a.id)) this.queueThumb(a);
    }
    const missing = [...s.media.values()].filter((m) => m !== 'online').length;
    const needsPermission = [...s.media.values()].some((m) => m === 'needs-permission');
    const canPickFolder = typeof window.showDirectoryPicker === 'function';
    this.banner.style.display = missing ? '' : 'none';
    this.banner.replaceChildren(
      h('span', {}, `Не найдено исходников: ${missing}. Монтаж цел, но превью и рендер этих клипов недоступны, пока файлы не подключены.`),
      h(
        'div',
        {},
        needsPermission ? h('button', { onclick: () => this.editor.regrantAccess() }, 'Разрешить доступ') : null,
        h('button', { onclick: () => void this.relink(pickVideoFiles), title: 'Выберите те же файлы — они подключатся по имени и размеру' }, 'Найти файлы…'),
        canPickFolder && h('button', { onclick: () => void this.relink(pickFolderVideos), title: 'Исходники найдутся в папке и вложенных папках по имени и размеру' }, 'Указать папку…'),
      ),
    );
  }

  private item(a: MediaAsset, status: string): HTMLElement {
    const thumb = h('img', { class: 'thumb', alt: '', draggable: false });
    const cached = this.thumbs.get(a.id);
    if (cached) thumb.src = cached;
    const v = a.video;
    const meta = [
      v ? `${v.width}×${v.height}` : 'только звук',
      v ? `${formatFps(v.frameRate.num, v.frameRate.den)} к/с` : null,
      formatTimecode(secondsToFrames(a.duration, this.editor.rate), this.editor.rate),
      formatBytes(a.sizeBytes),
    ].filter(Boolean);
    const el = h(
      'div',
      {
        class: 'pool-item',
        draggable: true,
        title: `${a.name}\nДвойной щелчок — в конец таймлайна (⇧F12)\nПеретащите на таймлайн, чтобы поставить в нужное место`,
        onclick: () => this.editor.selectAsset(a.id),
        ondblclick: () => this.editor.appendAsset(a.id),
        ondragstart: (e: DragEvent) => {
          this.editor.selectAsset(a.id);
          e.dataTransfer!.setData(ASSET_MIME, a.id);
          e.dataTransfer!.effectAllowed = 'copy';
        },
      },
      thumb,
      h(
        'div',
        { style: 'min-width:0' },
        h('div', { class: 'name' }, a.name),
        h(
          'div',
          { class: 'meta' },
          status !== 'online' ? h('span', { class: 'badge off' }, 'нет доступа') : null,
          v?.hdr ? h('span', { class: 'badge hdr' }, 'HDR') : null,
          v?.variableFrameRate ? h('span', { class: 'badge', title: 'Переменная частота кадров — будет приведена к постоянной' }, 'VFR') : null,
          meta.join(' · '),
        ),
      ),
      h('button', { class: 'remove', title: 'Убрать из проекта', onclick: (e: Event) => (e.stopPropagation(), this.editor.removeAsset(a.id)) }, '×'),
    );
    return el;
  }

  /** Миниатюры строим по одной, чтобы не загружать декодер при импорте пачки файлов. */
  private queueThumb(a: MediaAsset): void {
    const file = this.editor.fileFor(a.id);
    if (!file || !a.video) return;
    this.thumbQueue = this.thumbQueue.then(async () => {
      const media = new MediaInput(file);
      try {
        const sink = await media.videoSamples();
        const sample = await sink?.getSample(a.startTime + Math.min(1, a.duration / 3));
        if (!sample) return;
        const c = new OffscreenCanvas(176, 100);
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 176, 100);
        sample.drawWithFit(ctx, { fit: 'contain' });
        sample.close();
        const url = URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
        this.thumbs.set(a.id, url);
        const img = this.items.get(a.id)?.querySelector('img');
        if (img) img.src = url;
      } catch (err) {
        console.warn('Миниатюра не построена', a.name, err);
      } finally {
        media.dispose();
      }
    });
  }
}
