import type { MediaHandle, ProjectFileRef, ProjectFiles } from '../application/ports';

export interface PickedFile {
  file: File;
  handle: MediaHandle | null;
}

const VIDEO_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Видео',
    accept: { 'video/mp4': ['.mp4', '.m4v'], 'video/quicktime': ['.mov'], 'video/webm': ['.webm'], 'video/x-matroska': ['.mkv'] },
  },
];

export const hasFileSystemAccess = (): boolean => typeof window.showOpenFilePicker === 'function';

/** Диалог выбора видео. С File System Access доступ к файлам переживает перезагрузку. */
export async function pickVideoFiles(): Promise<PickedFile[]> {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true, types: VIDEO_TYPES, id: 'media' });
      return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return [];
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,.mov,.mp4,.m4v,.mkv,.webm';
    input.onchange = () => resolve([...(input.files ?? [])].map((file) => ({ file, handle: null })));
    input.click();
  });
}

/** Файлы из перетаскивания (Finder → окно). Ручки нужно забрать синхронно в обработчике drop. */
export function filesFromDrop(e: DragEvent): Promise<PickedFile[]> {
  const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
  const pending = items.map((item) => {
    const file = item.getAsFile();
    const handle = item.getAsFileSystemHandle?.() ?? Promise.resolve(null);
    return handle
      .catch(() => null)
      .then((h) => (file ? { file, handle: h && h.kind === 'file' ? (h as FileSystemFileHandle) : null } : null));
  });
  return Promise.all(pending).then((r) => r.filter((x): x is PickedFile => x !== null && isVideo(x.file)));
}

/** Файл проекта .vcut из перетаскивания (первый найденный). */
export function projectFileFromDrop(e: DragEvent): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === 'file' && /\.vcut$/i.test(i.getAsFile()?.name ?? ''));
  if (!item) return Promise.resolve(null);
  const file = item.getAsFile()!;
  const handle = item.getAsFileSystemHandle?.() ?? Promise.resolve(null);
  return handle.catch(() => null).then((h) => ({ file, handle: h && h.kind === 'file' ? (h as FileSystemFileHandle) : null }));
}

const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mov|mp4|m4v|mkv|webm)$/i.test(f.name);

/** Выбор файла для рендера. null — пользователь отказался или API нет (тогда рендер в память и скачивание). */
export async function pickRenderTarget(suggestedName: string): Promise<FileSystemFileHandle | null | 'canceled'> {
  if (!window.showSaveFilePicker) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }],
      id: 'render',
    });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return 'canceled';
    throw err;
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── Файл проекта (.vcut) ──────────────────────────────────────────────────

const PROJECT_TYPES: FilePickerAcceptType[] = [{ description: 'Проект vibe_cutter', accept: { 'application/json': ['.vcut'] } }];

/**
 * Файлы проекта через File System Access API. Запись идёт во временный файл
 * и заменяет основной только при успешном close() — оборванная запись
 * не портит проект. Без API (не Chrome) «сохранить» скачивает файл.
 */
export class FsProjectFiles implements ProjectFiles {
  async pickSaveTarget(suggestedName: string): Promise<ProjectFileRef | null> {
    if (!window.showSaveFilePicker) return { name: suggestedName, handle: null };
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: PROJECT_TYPES, id: 'project' });
      return { name: handle.name, handle };
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      throw err;
    }
  }

  async pickAndRead(): Promise<{ ref: ProjectFileRef; text: string } | null> {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ types: PROJECT_TYPES, id: 'project' });
        if (!handle) return null;
        return { ref: { name: handle.name, handle }, text: await (await handle.getFile()).text() };
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return null;
        throw err;
      }
    }
    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.vcut';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    return file ? { ref: { name: file.name, handle: null }, text: await file.text() } : null;
  }

  async read(ref: ProjectFileRef): Promise<string> {
    if (!ref.handle) throw new Error('Файл недоступен');
    return (await ref.handle.getFile()).text();
  }

  async write(ref: ProjectFileRef, text: string): Promise<void> {
    if (!ref.handle) {
      downloadBlob(new Blob([text], { type: 'application/json' }), ref.name);
      return;
    }
    const w = await ref.handle.createWritable({ keepExistingData: false });
    try {
      await w.write(text);
      await w.close();
    } catch (err) {
      await w.abort().catch(() => {});
      throw err;
    }
  }

  async permission(ref: ProjectFileRef, mode: 'read' | 'readwrite', ask: boolean): Promise<boolean> {
    if (!ref.handle) return mode === 'read' ? false : true;
    if ((await ref.handle.queryPermission({ mode })) === 'granted') return true;
    return ask && (await ref.handle.requestPermission({ mode })) === 'granted';
  }
}

/**
 * Видеофайлы из выбранной папки (с вложенными, до 4 уровней) — для поиска
 * переехавших исходников. null — пользователь отменил или API нет.
 */
export async function pickFolderVideos(): Promise<PickedFile[] | null> {
  if (!window.showDirectoryPicker) return null;
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker({ id: 'media-folder', mode: 'read' });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return null;
    throw err;
  }
  const out: PickedFile[] = [];
  const walk = async (d: FileSystemDirectoryHandle, depth: number) => {
    for await (const entry of d.values()) {
      if (entry.kind === 'file' && /\.(mov|mp4|m4v|mkv|webm)$/i.test(entry.name)) {
        const handle = entry as FileSystemFileHandle;
        out.push({ file: await handle.getFile(), handle });
      } else if (entry.kind === 'directory' && depth < 4 && !entry.name.startsWith('.')) {
        await walk(entry as FileSystemDirectoryHandle, depth + 1);
      }
    }
  };
  await walk(dir, 0);
  return out;
}
