import type { MediaHandle, MediaLibrary, ProjectFileRef, ProjectRepository, RecentProjects, SavedProject } from '../application/ports';
import type { AssetId } from '../domain/media';
import { parseProjectFile, serializeProject } from '../domain/project';

/**
 * Хранилище браузера (IndexedDB):
 * - session — рабочая сессия (текущая и предыдущая версия) для восстановления после сбоя;
 * - media — ссылки на исходники по «имя|размер», чтобы открытый проект нашёл свои видео;
 * - recent — недавние файлы проектов.
 * Ссылки на файлы (FileSystemFileHandle) сохраняются как есть — браузер позволяет.
 */
const DB = 'vibe_cutter';
const VERSION = 2;
const SESSION = 'projects';
const MEDIA = 'media';
const RECENT = 'recent';
const CURRENT = 'current';
const PREVIOUS = 'previous';
const RECENT_LIMIT = 10;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of [SESSION, MEDIA, RECENT]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  }));
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    fn(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Транзакция прервана'));
  });
}

interface SessionRow {
  json: string;
  handles: [AssetId, MediaHandle][];
  file?: ProjectFileRef | null;
  fileInSync?: boolean;
  savedAt: number;
}

export class IdbProjectRepository implements ProjectRepository {
  async load(): Promise<SavedProject | null> {
    const [current, previous] = await Promise.all([get<SessionRow>(SESSION, CURRENT), get<SessionRow>(SESSION, PREVIOUS)]);
    for (const row of [current, previous]) {
      if (!row) continue;
      try {
        return {
          project: parseProjectFile(row.json),
          handles: new Map(row.handles),
          file: row.file ?? null,
          fileInSync: row.fileInSync ?? false,
          savedAt: row.savedAt,
        };
      } catch (err) {
        console.error('Сохранённая сессия повреждена, пробую предыдущую версию', err);
      }
    }
    return null;
  }

  /** Текущая версия и резервная копия меняются в одной транзакции. */
  async save(s: Omit<SavedProject, 'savedAt'>): Promise<void> {
    const row: SessionRow = { json: serializeProject(s.project), handles: [...s.handles], file: s.file, fileInSync: s.fileInSync, savedAt: Date.now() };
    await tx(SESSION, (store) => {
      const prev = store.get(CURRENT);
      prev.onsuccess = () => {
        if (prev.result) store.put(prev.result, PREVIOUS);
        store.put(row, CURRENT);
      };
    });
  }
}

const mediaKey = (name: string, size: number) => `${name}|${size}`;

export class IdbMediaLibrary implements MediaLibrary {
  async remember(name: string, size: number, handle: MediaHandle): Promise<void> {
    await tx(MEDIA, (s) => s.put(handle, mediaKey(name, size)));
  }

  async find(name: string, size: number): Promise<MediaHandle | null> {
    return (await get<MediaHandle>(MEDIA, mediaKey(name, size))) ?? null;
  }
}

interface RecentRow {
  name: string;
  handle: FileSystemFileHandle | null;
  path?: string;
  openedAt: number;
}

export class IdbRecentProjects implements RecentProjects {
  async list(): Promise<ProjectFileRef[]> {
    const rows = (await get<RecentRow[]>(RECENT, 'list')) ?? [];
    return rows.map((r) => ({ name: r.name, handle: r.handle ?? null, ...(r.path ? { path: r.path } : {}) }));
  }

  async add(ref: ProjectFileRef): Promise<void> {
    if (!ref.handle && !ref.path) return;
    const rows = (await get<RecentRow[]>(RECENT, 'list')) ?? [];
    const rest = await withoutSame(rows, ref);
    const row: RecentRow = { name: ref.name, handle: ref.handle, ...(ref.path ? { path: ref.path } : {}), openedAt: Date.now() };
    const next = [row, ...rest].slice(0, RECENT_LIMIT);
    await tx(RECENT, (s) => s.put(next, 'list'));
  }

  async remove(ref: ProjectFileRef): Promise<void> {
    const rows = (await get<RecentRow[]>(RECENT, 'list')) ?? [];
    const next = await withoutSame(rows, ref);
    await tx(RECENT, (s) => s.put(next, 'list'));
  }
}

async function withoutSame(rows: RecentRow[], ref: ProjectFileRef): Promise<RecentRow[]> {
  const out: RecentRow[] = [];
  for (const r of rows) {
    const same = ref.path
      ? r.path === ref.path
      : ref.handle && r.handle
        ? await r.handle.isSameEntry(ref.handle).catch(() => false)
        : false;
    if (!same) out.push(r);
  }
  return out;
}
