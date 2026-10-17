import type { MediaHandle } from '../application/ports';

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
