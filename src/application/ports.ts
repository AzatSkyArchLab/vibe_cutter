import type { CompressPlan } from '../domain/compress';
import type { AssetId, MediaAsset, MediaMetadata } from '../domain/media';
import type { OutputSettings } from '../domain/export-preset';
import type { Project } from '../domain/project';
import type { RenderPlan } from '../domain/render-plan';

/**
 * Порты — всё, что приложению нужно от внешнего мира. В браузере их
 * реализует WebCodecs + IndexedDB, в десктопной версии — нативный движок.
 *
 * Ссылка на исходник: в браузере это File. В десктопной версии адаптер
 * будет создавать File-совместимый объект поверх пути на диске.
 */
export type MediaRef = File;

export interface MediaProber {
  probe(file: MediaRef): Promise<MediaMetadata>;
}

export interface RenderProgress {
  readonly frame: number;
  readonly totalFrames: number;
  /** Скорость рендера, кадров в секунду. */
  readonly fps: number;
  readonly elapsedSec: number;
}

export interface RenderStats {
  readonly frames: number;
  readonly audioSamples: number;
  readonly elapsedSec: number;
}

export interface EncodeSupport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Куда писать результат: в выбранный файл на диске или в память (для скачивания). */
export type RenderTarget = { kind: 'file'; handle: FileSystemFileHandle } | { kind: 'memory' };

export interface RenderTask {
  readonly done: Promise<{ stats: RenderStats; blob: Blob | null }>;
  cancel(): void;
}

export interface RenderEngine {
  check(settings: OutputSettings): Promise<EncodeSupport>;
  render(
    plan: RenderPlan,
    media: ReadonlyMap<AssetId, MediaRef>,
    target: RenderTarget,
    onProgress: (p: RenderProgress) => void,
  ): RenderTask;
}

/** Как найти исходник после перезагрузки страницы. */
export type MediaHandle = FileSystemFileHandle;

/**
 * Файл проекта на диске. В браузере — ручка File System Access, в приложении
 * для Mac — путь. Без того и другого (браузер без API) сохранение — скачиванием.
 */
export interface ProjectFileRef {
  readonly name: string;
  readonly handle: FileSystemFileHandle | null;
  readonly path?: string;
}

/** Состояние рабочей сессии для восстановления после перезагрузки или сбоя вкладки. */
export interface SavedProject {
  readonly project: Project;
  readonly handles: ReadonlyMap<AssetId, MediaHandle>;
  readonly file: ProjectFileRef | null;
  /** Совпадает ли автосохранённая версия с файлом проекта на диске. */
  readonly fileInSync: boolean;
  readonly savedAt: number;
}

/** Автосохранение рабочей сессии (в браузере — IndexedDB). */
export interface ProjectRepository {
  load(): Promise<SavedProject | null>;
  save(session: Omit<SavedProject, 'savedAt'>): Promise<void>;
}

/** Файлы проекта на диске (.vcut). */
export interface ProjectFiles {
  /** Диалог «Сохранить как». null — пользователь отменил. */
  pickSaveTarget(suggestedName: string): Promise<ProjectFileRef | null>;
  /** Диалог «Открыть». null — пользователь отменил. */
  pickAndRead(): Promise<{ ref: ProjectFileRef; text: string } | null>;
  read(ref: ProjectFileRef): Promise<string>;
  /** Атомарная запись: при сбое на диске остаётся прежняя версия файла. */
  write(ref: ProjectFileRef, text: string): Promise<void>;
  /** Есть ли доступ; ask = true — запросить (только в обработчике действия пользователя). */
  permission(ref: ProjectFileRef, mode: 'read' | 'readwrite', ask: boolean): Promise<boolean>;
  /** Можно ли перезаписывать этот файл на месте (а не скачивать копию). */
  inPlace(ref: ProjectFileRef): boolean;
}

/** Ссылки на исходники по имени и размеру — чтобы открытый проект сам нашёл свои видео. */
export interface MediaLibrary {
  remember(name: string, size: number, handle: MediaHandle): Promise<void>;
  find(name: string, size: number): Promise<MediaHandle | null>;
}

export interface RecentProjects {
  list(): Promise<ProjectFileRef[]>;
  add(ref: ProjectFileRef): Promise<void>;
  remove(ref: ProjectFileRef): Promise<void>;
}

/** Предпросмотр таймлайна во вьюере: стоп-кадр и воспроизведение со звуком. */
export interface PreviewEngine {
  /** Показать кадр таймлайна. Частые вызовы схлопываются — рисуется последний запрошенный. */
  showFrame(project: Project, frame: number, media: ReadonlyMap<AssetId, MediaRef>): void;
  /**
   * Воспроизведение с кадра `from`. onFrame вызывается с текущим кадром,
   * onEnd — по достижении конца или при ошибке.
   */
  play(
    project: Project,
    from: number,
    media: ReadonlyMap<AssetId, MediaRef>,
    onFrame: (frame: number) => void,
    onEnd: (error?: Error) => void,
  ): void;
  stop(): void;
  readonly playing: boolean;
}

// ── Сжатие отдельного файла ──────────────────────────────────────────────

export interface CompressResult {
  readonly bytes: number;
  /** Сколько проходов понадобилось, чтобы попасть в размер. */
  readonly passes: number;
  readonly videoBitrate: number;
  readonly elapsedSec: number;
}

export interface RemuxResult {
  readonly bytes: number;
  readonly videoCopied: boolean;
  readonly audioCopied: boolean;
  readonly elapsedSec: number;
}

export interface Task<T> {
  readonly done: Promise<{ result: T; blob: Blob | null }>;
  cancel(): void;
}

export interface FileCompressor {
  compress(
    source: MediaAsset,
    file: MediaRef,
    plan: CompressPlan,
    target: RenderTarget,
    onProgress: (pass: number, p: RenderProgress) => void,
  ): Task<CompressResult>;
  /** Сменить контейнер без перекодирования видео. */
  remux(file: MediaRef, target: RenderTarget, onProgress: (fraction: number) => void): Task<RemuxResult>;
}
