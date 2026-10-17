// Оболочка vibe_cutter для macOS. Интерфейс и движок — те же, что на сайте;
// здесь только окно, меню, работа с файлами проекта по пути и проверка обновлений.
import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DIST = path.join(import.meta.dirname, '..', 'dist');
const REPO = 'AzatSkyArchLab/vibe_cutter';
const PROJECT_EXT = '.vcut';
const SELFTEST = process.env.VIBE_SELFTEST === '1';
const MAC = process.platform === 'darwin';

// Свой защищённый адрес app://vibe/: модульный воркер рендера, IndexedDB и
// File System Access работают как на https-сайте (с file:// они ломаются).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

/** @type {BrowserWindow | null} */
let win = null;
/** Файлы проекта, открытые до готовности окна (двойной щелчок в Finder / Проводнике). */
const pendingOpen = [];
// Windows: файл, по которому дважды щёлкнули, приходит аргументом запуска.
if (!MAC) for (const a of process.argv.slice(1)) if (a.toLowerCase().endsWith(PROJECT_EXT)) pendingOpen.push(a);
let rendererReady = false;

if (!SELFTEST && !app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', (_e, argv) => {
  const file = argv.find((a) => a.toLowerCase().endsWith(PROJECT_EXT));
  if (file) openProjectPath(file);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// macOS: открыть .vcut из Finder или перетащить на иконку в Dock.
app.on('open-file', (e, file) => {
  e.preventDefault();
  openProjectPath(file);
});

function openProjectPath(file) {
  if (!file.toLowerCase().endsWith(PROJECT_EXT)) return;
  if (win && rendererReady) void sendProject(file);
  else pendingOpen.push(file);
}

async function sendProject(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    app.addRecentDocument(file);
    win?.webContents.send('open-project', { path: file, name: path.basename(file), text });
  } catch (err) {
    dialog.showErrorBox('Не удалось открыть проект', `${file}\n\n${err.message}`);
  }
}

app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    // Никаких выходов за пределы папки приложения.
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // Разрешения: доступ к файлам (импорт видео, сохранение рендера) — да; остальное приложению не нужно.
  const allowed = new Set(['fileSystem', 'clipboard-sanitized-write', 'fullscreen', 'media']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(wc.getURL().startsWith('app://') && allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc?.getURL().startsWith('app://') && allowed.has(permission));

  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#161618',
    title: 'vibe_cutter',
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => {
    if (!SELFTEST) win.show();
  });
  // Ctrl/⌘ + колесо — масштаб таймлайна, а не всей страницы.
  void win.webContents.setVisualZoomLevelLimits(1, 1);
  win.on('closed', () => (win = null));

  // Внешние ссылки — в обычный браузер; уход со страницы приложения запрещён.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  // Страница просит подтвердить уход (идёт рендер) — спрашиваем по-человечески.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Остаться', 'Выйти'],
      defaultId: 0,
      cancelId: 0,
      message: 'Идёт рендер или сжатие',
      detail: 'Если выйти сейчас, недописанный файл не сохранится.',
    });
    if (choice === 1) e.preventDefault();
  });

  void win.loadURL('app://vibe/index.html');
  if (SELFTEST) win.webContents.once('did-finish-load', () => void runSelfTest());
  else setTimeout(() => void checkForUpdates(false), 4000);
}

// ── Мост для страницы ─────────────────────────────────────────────────────

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  for (const file of pendingOpen.splice(0)) void sendProject(file);
});

ipcMain.handle('info', () => ({ version: app.getVersion(), platform: process.platform, ...(SELFTEST ? { tmp: app.getPath('temp') } : {}) }));

ipcMain.handle('project:save-dialog', async (_e, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), String(suggestedName || `Без названия${PROJECT_EXT}`)),
    filters: [{ name: 'Проект vibe_cutter', extensions: ['vcut'] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.toLowerCase().endsWith(PROJECT_EXT) ? r.filePath : r.filePath + PROJECT_EXT;
});

ipcMain.handle('project:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Проект vibe_cutter', extensions: ['vcut'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  app.addRecentDocument(file);
  return { path: file, name: path.basename(file), text: await fs.readFile(file, 'utf8') };
});

ipcMain.handle('project:read', async (_e, file) => {
  assertProjectPath(file);
  const text = await fs.readFile(file, 'utf8');
  app.addRecentDocument(file);
  return text;
});

/** Атомарная запись: во временный файл рядом, затем переименование поверх. */
ipcMain.handle('project:write', async (_e, file, text) => {
  assertProjectPath(file);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
});

ipcMain.handle('project:exists', async (_e, file) => {
  assertProjectPath(file);
  return fs.access(file).then(() => true, () => false);
});

ipcMain.handle('check-updates', () => checkForUpdates(true));

function assertProjectPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.toLowerCase().endsWith(PROJECT_EXT))
    throw new Error('Недопустимый путь к файлу проекта');
}

// ── Меню ──────────────────────────────────────────────────────────────────

function buildMenu() {
  const send = (action) => () => win?.webContents.send('menu', action);
  const file = {
    label: 'Файл',
    submenu: [
      { label: 'Новый проект', click: send('new') },
      { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      ...(MAC ? [{ role: 'recentDocuments', label: 'Недавние', submenu: [{ role: 'clearRecentDocuments', label: 'Очистить' }] }] : []),
      { type: 'separator' },
      { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: 'Сохранить как…', accelerator: 'Shift+CmdOrCtrl+S', click: send('save-as') },
      { type: 'separator' },
      { label: 'Импорт видео…', accelerator: 'CmdOrCtrl+I', click: send('import') },
      ...(MAC ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Выход' }]),
    ],
  };
  const edit = {
    label: 'Правка',
    submenu: [
      // Отмена решается на странице: в поле ввода — текст, иначе — монтаж.
      { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { label: 'Вернуть', accelerator: MAC ? 'Shift+CmdOrCtrl+Z' : 'Ctrl+Y', click: send('redo') },
      // На Windows привычны оба сочетания для «Вернуть».
      ...(MAC ? [] : [{ label: 'Вернуть', accelerator: 'Ctrl+Shift+Z', visible: false, click: send('redo') }]),
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выбрать всё' },
    ],
  };
  const view = {
    label: 'Вид',
    submenu: [
      { role: 'togglefullscreen', label: 'Полный экран' },
      { type: 'separator' },
      { role: 'reload', label: 'Перезагрузить' },
      { role: 'toggleDevTools', label: 'Инструменты разработчика' },
    ],
  };
  const about = () =>
    info(`vibe_cutter ${app.getVersion()}`, 'Видеоредактор: монтаж, титры, рендер под YouTube и Kinescope, сжатие видео.');
  const template = MAC
    ? [
        {
          label: 'vibe_cutter',
          submenu: [
            { role: 'about', label: 'О vibe_cutter' },
            { label: 'Проверить обновления…', click: () => void checkForUpdates(true) },
            { type: 'separator' },
            { role: 'hide', label: 'Скрыть vibe_cutter' },
            { role: 'hideOthers', label: 'Скрыть остальные' },
            { type: 'separator' },
            { role: 'quit', label: 'Завершить vibe_cutter' },
          ],
        },
        file,
        edit,
        view,
        { role: 'windowMenu', label: 'Окно' },
      ]
    : [
        file,
        edit,
        view,
        {
          label: 'Справка',
          submenu: [
            { label: 'Проверить обновления…', click: () => void checkForUpdates(true) },
            { label: 'О программе', click: () => void about() },
          ],
        },
      ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Обновления ────────────────────────────────────────────────────────────

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/**
 * Сверяет версию с последним релизом на GitHub. Без подписи Apple автообновление
 * невозможно, поэтому предлагаем скачать установщик. Автоматически — не чаще раза в сутки.
 */
async function checkForUpdates(manual) {
  const stamp = path.join(app.getPath('userData'), 'update-check.json');
  if (!manual) {
    const last = await fs.readFile(stamp, 'utf8').then((t) => JSON.parse(t).at ?? 0, () => 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;
  }
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    await fs.writeFile(stamp, JSON.stringify({ at: Date.now() })).catch(() => {});
    if (res.status === 404) {
      if (manual) await info('Пока нет опубликованных версий', `У вас vibe_cutter ${app.getVersion()}.`);
      return;
    }
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    const release = await res.json();
    const latest = String(release.tag_name ?? '');
    if (latest && newer(latest, app.getVersion())) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Скачать', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        message: `Доступна версия ${latest.replace(/^v/, '')}`,
        detail: MAC
          ? `У вас ${app.getVersion()}. Скачайте .dmg и перетащите vibe_cutter в «Программы» поверх старой версии — проекты и настройки сохранятся.`
          : `У вас ${app.getVersion()}. Скачайте установщик vibe_cutter-…-setup.exe и запустите его — старая версия обновится, проекты и настройки сохранятся.`,
      });
      if (response === 0) void shell.openExternal(release.html_url);
    } else if (manual) {
      await info('У вас последняя версия', `vibe_cutter ${app.getVersion()}`);
    }
  } catch (err) {
    if (manual) await info('Не удалось проверить обновления', String(err?.message ?? err));
  }
}

const info = (message, detail) => dialog.showMessageBox(win, { type: 'info', message, detail, buttons: ['OK'] });

// ── Самопроверка собранного приложения (VIBE_SELFTEST=1) ───────────────────

async function runSelfTest() {
  const out = (obj, code) => {
    process.stdout.write(`VIBE_SELFTEST ${JSON.stringify(obj)}\n`);
    app.exit(code);
  };
  const timer = setTimeout(() => out({ ok: false, error: 'timeout' }, 2), 60_000);
  try {
    const result = await win.webContents.executeJavaScript(`(${selfTestInPage.toString()})()`, true);
    clearTimeout(timer);
    out(result, result.ok ? 0 : 1);
  } catch (err) {
    clearTimeout(timer);
    out({ ok: false, error: String(err) }, 1);
  }
}

/** Выполняется в странице приложения. */
async function selfTestInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  const r = {
    url: location.href,
    secure: isSecureContext,
    webcodecs: typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function',
    fsAccess: typeof showOpenFilePicker === 'function' && typeof showSaveFilePicker === 'function',
    bridge: typeof window.vibeNative?.info === 'function',
    ui: !!document.querySelector('.timeline canvas') && !!document.querySelector('.pagebar'),
  };
  r.info = r.bridge ? await window.vibeNative.info() : null;
  // Настоящий рендер через воркер приложения и чтение результата.
  try {
    r.render = await Promise.race([window.__vibeSelfTest(), sleep(30000).then(() => ({ error: 'render timeout' }))]);
  } catch (e) {
    r.render = { error: String(e) };
  }
  // Запись файлов через File System Access (в хранилище приложения).
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('selftest.bin', { create: true });
    const ws = await fh.createWritable();
    await ws.write(new Uint8Array([1, 2, 3]));
    await ws.close();
    r.fsWrite = (await fh.getFile()).size === 3;
    await root.removeEntry('selftest.bin');
  } catch (e) {
    r.fsWrite = String(e);
  }
  // Атомарная запись файла проекта через мост.
  if (r.bridge) {
    const p = `${r.info.tmp}/vibe-selftest.vcut`;
    try {
      await window.vibeNative.writeProject(p, '{"x":1}');
      r.projectWrite = (await window.vibeNative.readProject(p)) === '{"x":1}';
    } catch (e) {
      r.projectWrite = String(e);
    }
  }
  r.ok = r.secure && r.webcodecs && r.fsAccess && r.bridge && r.ui && r.render?.encodeSupport === true && r.render?.rendered === true && r.render?.readBack === true && r.fsWrite === true && r.projectWrite === true;
  return r;
}
