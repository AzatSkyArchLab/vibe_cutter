import type { Editor, EditorState } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import type { RenderEngine } from '../application/ports';
import { RESOLUTIONS, type FitMode } from '../domain/project';
import { filesFromDrop } from '../infrastructure/file-access';
import { DeliverPage } from './deliver-page';
import { h, setText } from './dom';
import { formatFps } from './format';
import { MediaPool } from './media-pool';
import { SHORTCUTS, installShortcuts } from './shortcuts';
import { TimelineView } from './timeline-view';
import { Viewer } from './viewer';

/** Оболочка: верхняя панель, страницы «Монтаж» и «Рендер», уведомления, перетаскивание файлов. */
export function mountApp(root: HTMLElement, editor: Editor, playback: PlaybackController, viewer: Viewer, renderEngine: RenderEngine): void {
  const pool = new MediaPool(editor);

  // Панель инструментов таймлайна
  const toolBtn = (label: string, title: string, fn: () => void) => {
    const [icon, ...text] = label.split(' ');
    return h('button', { title, onclick: fn }, icon, text.length ? h('span', { class: 'lbl' }, ' ' + text.join(' ')) : null);
  };
  const selectBtn = toolBtn('↖ Выделение', 'Режим выделения (A)', () => editor.setTool('select'));
  const bladeBtn = toolBtn('✂ Лезвие', 'Режим лезвия (B)', () => editor.setTool('blade'));
  const snapBtn = toolBtn('🧲 Привязка', 'Привязка к точкам монтажа (N). ⌥ при перетаскивании — без привязки', () => editor.toggleSnapping());
  const linkBtn = toolBtn('🔗 Связь', 'Связанное выделение видео и звука (⇧⌘L)', () => editor.toggleLinkedSelection());
  const undoBtn = toolBtn('↶', 'Отменить (⌘Z)', () => (playback.stop(), editor.undo()));
  const redoBtn = toolBtn('↷', 'Вернуть (⇧⌘Z)', () => (playback.stop(), editor.redo()));
  const resSelect = h(
    'select',
    {
      title: 'Разрешение таймлайна',
      onchange: () => {
        const r = RESOLUTIONS[Number(resSelect.value)]!;
        editor.changeSettings({ ...editor.project.settings, width: r.width, height: r.height });
      },
    },
    ...RESOLUTIONS.map((r, i) => h('option', { value: String(i) }, r.label)),
  );
  const fitSelect = h(
    'select',
    { title: 'Как вписывать кадр другой пропорции', onchange: () => editor.changeSettings({ ...editor.project.settings, fit: fitSelect.value as FitMode }) },
    h('option', { value: 'fit' }, 'Вписать'),
    h('option', { value: 'fill' }, 'Заполнить (обрезать)'),
  );
  const fpsLabel = h('span', { class: 'spec', title: 'Частота кадров таймлайна задаётся по первому видео' });
  const toolbar = h(
    'div',
    { class: 'tl-toolbar' },
    selectBtn, bladeBtn,
    h('div', { class: 'sep' }),
    snapBtn, linkBtn,
    h('div', { class: 'sep' }),
    undoBtn, redoBtn,
    h('div', { class: 'sep' }),
    toolBtn('+V', 'Добавить видеодорожку', () => editor.addTrack('video')),
    toolBtn('+A', 'Добавить аудиодорожку', () => editor.addTrack('audio')),
    h('div', { class: 'grow' }),
    resSelect, fitSelect, fpsLabel,
    h('div', { class: 'sep' }),
    toolBtn('−', 'Уменьшить (⌘−)', () => timeline.zoomBy(1 / 1.5)),
    toolBtn('⤢', 'По размеру (⇧Z)', () => timeline.zoomToFit()),
    toolBtn('+', 'Увеличить (⌘=)', () => timeline.zoomBy(1.5)),
    h('button', { class: 'icon', title: SHORTCUTS.map((s) => `${s.keys} — ${s.label}`).join('\n') }, '⌨'),
  );
  const timeline = new TimelineView(editor, playback, toolbar);

  // Страницы. Вьюер один, переезжает между страницами.
  const viewerSlotEdit = h('div', { style: 'display:grid;min-height:0;min-width:0' });
  const viewerSlotDeliver = h('div', { style: 'display:grid;min-height:0;min-width:0' });
  const editPage = h('div', { class: 'page edit' }, h('div', { class: 'edit-top' }, pool.el, viewerSlotEdit), timeline.el);
  const deliver = new DeliverPage(editor, renderEngine, viewerSlotDeliver);

  const nameInput = h('input', {
    class: 'project-name',
    type: 'text',
    spellcheck: false,
    onchange: () => editor.rename(nameInput.value),
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && nameInput.blur(),
  });
  const saveState = h('div', { class: 'save-state' }, 'Автосохранение');
  const editTab = h('button', { onclick: () => editor.setPage('edit') }, 'Монтаж');
  const deliverTab = h('button', { onclick: () => (playback.stop(), editor.setPage('deliver')) }, 'Рендер');
  const toasts = h('div', { class: 'toasts' });
  const dropOverlay = h('div', { class: 'drop-overlay' }, 'Отпустите, чтобы добавить видео');

  root.replaceChildren(
    h(
      'div',
      { class: 'app' },
      h('div', { class: 'topbar' }, h('div', { class: 'logo' }, 'vibe', h('span', {}, '_'), 'cutter'), nameInput, saveState),
      h('div', { style: 'display:grid;min-height:0' }, editPage, deliver.el),
      h('div', { class: 'pagebar' }, editTab, deliverTab),
    ),
    toasts,
    dropOverlay,
  );

  installShortcuts(editor, playback, timeline, { importMedia: () => void pool.import() });

  // Уведомления
  editor.onNotice((n) => {
    const el = h('div', { class: `toast ${n.kind}` }, n.text);
    toasts.append(el);
    setTimeout(() => el.remove(), n.kind === 'error' ? 9000 : 3500);
  });

  // Файлы из Finder в любое место окна
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  window.addEventListener('dragenter', (e) => hasFiles(e) && (dragDepth++, dropOverlay.classList.add('on')));
  window.addEventListener('dragleave', (e) => hasFiles(e) && --dragDepth <= 0 && ((dragDepth = 0), dropOverlay.classList.remove('on')));
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('on');
    void filesFromDrop(e).then((files) => {
      if (files.length) void editor.importFiles(files);
      else editor.notify('error', 'Среди перетащенных файлов нет видео');
    });
  });

  window.addEventListener('beforeunload', (e) => {
    void editor.saveNow();
    if (deliver.busy) e.preventDefault();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void editor.saveNow());

  const update = (s: EditorState) => {
    const onEdit = s.page === 'edit';
    editPage.classList.toggle('on', onEdit);
    deliver.el.classList.toggle('on', !onEdit);
    editTab.classList.toggle('on', onEdit);
    deliverTab.classList.toggle('on', !onEdit);
    const slot = onEdit ? viewerSlotEdit : viewerSlotDeliver;
    if (viewer.el.parentElement !== slot) slot.append(viewer.el);
    selectBtn.classList.toggle('on', s.tool === 'select');
    bladeBtn.classList.toggle('on', s.tool === 'blade');
    snapBtn.classList.toggle('on', s.snapping);
    linkBtn.classList.toggle('on', s.linkedSelection);
    undoBtn.disabled = !s.canUndo;
    redoBtn.disabled = !s.canRedo;
    if (document.activeElement !== nameInput) nameInput.value = s.project.name;
    const { width, height, frameRate, fit } = s.project.settings;
    const ri = RESOLUTIONS.findIndex((r) => r.width === width && r.height === height);
    resSelect.value = String(Math.max(0, ri));
    fitSelect.value = fit;
    setText(fpsLabel, `${formatFps(frameRate.num, frameRate.den)} к/с`);
  };
  editor.subscribe(update);
  update(editor.state);
  void saveState;
}
