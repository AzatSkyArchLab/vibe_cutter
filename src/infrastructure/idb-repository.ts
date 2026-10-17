import type { MediaHandle, ProjectRepository, SavedProject } from '../application/ports';
import type { AssetId } from '../domain/media';
import { type Project, parseProject, serializeProject } from '../domain/project';

const DB = 'vibe_cutter';
const STORE = 'projects';
const KEY = 'current';
/** Предыдущая версия хранится отдельно: если текущая окажется битой, откатимся на неё. */
const BACKUP_KEY = 'previous';

interface Row {
  json: string;
  handles: [AssetId, MediaHandle][];
  savedAt: number;
}

/**
 * Автосохранение в IndexedDB. Ссылки на файлы (FileSystemFileHandle)
 * сохраняются там же — после перезагрузки достаточно подтвердить доступ.
 * Запись атомарна: текущая версия и резервная копия меняются в одной транзакции.
 */
export class IdbProjectRepository implements ProjectRepository {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  async load(): Promise<SavedProject | null> {
    const db = await this.open();
    const [current, previous] = await Promise.all([get<Row>(db, KEY), get<Row>(db, BACKUP_KEY)]);
    for (const row of [current, previous]) {
      if (!row) continue;
      try {
        return { project: parseProject(row.json), handles: new Map(row.handles), savedAt: row.savedAt };
      } catch (err) {
        console.error('Сохранённый проект повреждён, пробую резервную копию', err);
      }
    }
    return null;
  }

  async save(project: Project, handles: ReadonlyMap<AssetId, MediaHandle>): Promise<void> {
    const db = await this.open();
    const row: Row = { json: serializeProject(project), handles: [...handles], savedAt: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const prev = store.get(KEY);
      prev.onsuccess = () => {
        if (prev.result) store.put(prev.result, BACKUP_KEY);
        store.put(row, KEY);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Транзакция прервана'));
    });
  }
}

function get<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}
