import type { Editor, EditorState } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import type { FileCompressor, MediaProber, RenderEngine } from '../application/ports';
import { RESOLUTIONS, type FitMode } from '../domain/project';
import { filesFromDrop, projectFileFromDrop } from '../infrastructure/file-access';
import { native } from '../infrastructure/native';
import { ProjectMenu } from './project-menu';
import { CompressPage } from './compress-page';
import { DeliverPage } from './deliver-page';
import { h, setText } from './dom';
import { formatFps } from './format';
import { MediaPool } from './media-pool';
import { TitleInspector } from './title-inspector';
import { TitlesLibrary } from './titles-library';
import { SHORTCUTS, installShortcuts } from './shortcuts';
import { TimelineView } from './timeline-view';
import { Viewer } from './viewer';

/** Оболочка: верхняя панель, страницы «Монтаж» и «Рендер», уведомления, перетаскивание файлов. */
export function mountApp(
  root: HTMLElement,
  editor: Editor,
  playback: PlaybackController,
  viewer: Viewer,
  renderEngine: RenderEngine & FileCompressor,
  prober: MediaProber,
): void {
  const pool = new MediaPool(editor);
  const titles = new TitlesLibrary(editor, playback);
  const inspector = new TitleInspector(editor);
  const mediaTab = h('button', { onclick: () => showLib('media') }, 'Медиа');
  const titlesTab = h('button', { onclick: () => showLib('titles') }, 'Титры');
  const libBody = h('div', { class: 'pool-body' });
  const showLib = (tab: 'media' | 'titles') => {
    mediaTab.classList.toggle('on', tab === 'media');
    titlesTab.classList.toggle('on', tab === 'titles');
    pool.importButton.style.visibility = tab === 'media' ? '' : 'hidden';
    libBody.replaceChildren(tab === 'media' ? pool.el : titles.el);
  };
  const library = h(
    'div',
    { class: 'pool' },
    h('div', { class: 'panel-head' }, h('div', { class: 'lib-tabs grow' }, mediaTab, titlesTab), pool.importButton),
    libBody,
  );
  showLib('media');

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
  const editTop = h('div', { class: 'edit-top' }, library, viewerSlotEdit, inspector.el);
  const editPage = h('div', { class: 'page edit' }, editTop, timeline.el);
  // Страница «Рендер»: таймлайн или сжатие отдельного файла.
  let deliverMode: 'timeline' | 'compress' = 'timeline';
  const modeSwitch = () => {
    const el = h(
      'div',
      { class: 'panel-head deliver-switch' },
      h('button', { 'data-mode': 'timeline', onclick: () => setDeliverMode('timeline') }, 'Рендер таймлайна'),
      h('button', { 'data-mode': 'compress', onclick: () => setDeliverMode('compress') }, 'Сжать файл'),
    );
    switches.push(el);
    return el;
  };
  const switches: HTMLElement[] = [];
  const deliver = new DeliverPage(editor, renderEngine, viewerSlotDeliver, modeSwitch());
  const compress = new CompressPage(editor, prober, renderEngine, modeSwitch());
  const setDeliverMode = (m: 'timeline' | 'compress') => {
    deliverMode = m;
    if (m === 'compress') playback.stop();
    update(editor.state);
  };

  const nameInput = h('input', {
    class: 'project-name',
    type: 'text',
    spellcheck: false,
    onchange: () => editor.rename(nameInput.value),
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && nameInput.blur(),
  });
  const projectMenu = new ProjectMenu(editor, playback);
  const editTab = h('button', { onclick: () => editor.setPage('edit') }, 'Монтаж');
  const deliverTab = h('button', { onclick: () => (playback.stop(), editor.setPage('deliver')) }, 'Рендер');
  const toasts = h('div', { class: 'toasts' });
  const dropOverlay = h('div', { class: 'drop-overlay' }, 'Отпустите, чтобы добавить видео');

  root.replaceChildren(
    h(
      'div',
      { class: 'app' },
      h('div', { class: 'topbar' }, h('div', { class: 'logo' }, 'vibe', h('span', {}, '_'), 'cutter'), projectMenu.button, nameInput, projectMenu.status),
      h('div', { style: 'display:grid;min-height:0' }, editPage, deliver.el, compress.el),
      h('div', { class: 'pagebar' }, editTab, deliverTab),
    ),
    toasts,
    dropOverlay,
  );

  installShortcuts(
    editor,
    playback,
    timeline,
    {
      importMedia: () => void pool.import(),
      save: (as) => void projectMenu.save(as),
      open: () => void projectMenu.open(),
    },
    !!native,
  );

  // Приложение для Mac: меню и открытие проектов из Finder.
  if (native) {
    const inText = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    native.onMenu((action) => {
      switch (action) {
        case 'new':
          return void projectMenu.newProject();
        case 'open':
          return void projectMenu.open();
        case 'save':
          return void projectMenu.save(false);
        case 'save-as':
          return void projectMenu.save(true);
        case 'import':
          return void pool.import();
        case 'undo':
          // В поле ввода — отмена набранного текста, иначе — шаг монтажа.
          if (inText()) document.execCommand('undo');
          else (playback.stop(), editor.undo());
          return;
        case 'redo':
          if (inText()) document.execCommand('redo');
          else (playback.stop(), editor.redo());
          return;
      }
    });
    native.onOpenProject((p) => void projectMenu.openExternal(p.text, { name: p.name, handle: null, path: p.path }));
  }

  // Уведомления
  editor.onNotice((n) => {
    const el = h('div', { class: `toast ${n.kind}` }, n.text);
    toasts.append(el);
    setTimeout(() => el.remove(), n.kind === 'error' ? 9000 : 3500);
  });

  // Файлы из Finder в любое место окна
  let dragDepth = 0;
  // На странице сжатия файлы выбираются для сжатия, а не импортируются в проект.
  const hasFiles = (e: DragEvent) => (e.dataTransfer?.types.includes('Files') ?? false) && !compress.el.classList.contains('on');
  window.addEventListener('dragenter', (e) => hasFiles(e) && (dragDepth++, dropOverlay.classList.add('on')));
  window.addEventListener('dragleave', (e) => hasFiles(e) && --dragDepth <= 0 && ((dragDepth = 0), dropOverlay.classList.remove('on')));
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('on');
    // Файл проекта открывается, видео — импортируются. Ручки забираем синхронно, до первого await.
    const projectFile = projectFileFromDrop(e);
    const videos = filesFromDrop(e);
    void (async () => {
      const pf = await projectFile;
      if (pf) return projectMenu.openDropped(pf.file, pf.handle);
      const files = await videos;
      if (files.length) void editor.importFiles(files);
      else editor.notify('error', 'Среди перетащенных файлов нет видео или проекта .vcut');
    })();
  });

  window.addEventListener('beforeunload', (e) => {
    void editor.saveNow();
    if (deliver.busy || compress.busy) e.preventDefault();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void editor.saveNow());

  const update = (s: EditorState) => {
    const onEdit = s.page === 'edit';
    editPage.classList.toggle('on', onEdit);
    deliver.el.classList.toggle('on', !onEdit && deliverMode === 'timeline');
    compress.el.classList.toggle('on', !onEdit && deliverMode === 'compress');
    for (const sw of switches) for (const b of sw.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === deliverMode);
    editTab.classList.toggle('on', onEdit);
    deliverTab.classList.toggle('on', !onEdit);
    const slot = onEdit ? viewerSlotEdit : viewerSlotDeliver;
    if (viewer.el.parentElement !== slot) slot.append(viewer.el);
    editTop.classList.toggle('with-inspector', inspector.visible);
    inspector.el.style.display = inspector.visible ? '' : 'none';
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
}
