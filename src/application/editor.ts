import { newAssetId, randomIds } from '../domain/ids';
import type { AssetId, MediaAsset } from '../domain/media';
import {
  PROJECT_EXT, type Project, type TimelineSettings, changeSettings, findAsset, isTimelineEmpty, nameFromFile, newProject,
  parseProjectFile, serializeProjectFile,
} from '../domain/project';
import { type FrameRate, fpsValue, frameRate, sameFrameRate } from '../domain/time';
import { type TitleStyle, type TitleTemplate, defaultTitle, sanitizeTitle } from '../domain/title';
import {
  type ClipId, type Ids, type Timeline, type TrackId, type TrackKind,
  addTrack, allClips, appendAtEnd, assetLengthInFrames, clipEnd, findClip, insert, lift, overwrite,
  placementsForAsset, deleteEmptyTracks, deleteTrack, rippleDelete, rippleDeleteRange, splitAt, splitClipsAt, timelineEnd,
  tracksOfKind, validateTimeline, withLinked,
} from '../domain/timeline';
import type { MediaHandle, MediaLibrary, MediaProber, MediaRef, ProjectFileRef, ProjectFiles, ProjectRepository, RecentProjects } from './ports';

/**
 * Состояние редактора и все команды монтажа. Интерфейс только читает
 * состояние и вызывает команды; вся логика монтажа — в домене.
 *
 * Каждая команда, меняющая проект, проходит через commit(): он проверяет
 * инварианты таймлайна (битое состояние не попадает ни в историю, ни в
 * автосохранение) и кладёт снимок в историю отмены.
 */

export type Tool = 'select' | 'blade';
export type Page = 'edit' | 'deliver';

export interface Marks {
  readonly in: number | null;
  readonly out: number | null;
}

/** Доступность исходника в этой сессии браузера. */
export type MediaStatus = 'online' | 'needs-permission' | 'offline';

/**
 * Состояние файла проекта на диске:
 * none — проект ещё не сохранялся в файл; saved — файл совпадает с монтажом;
 * unsaved — есть изменения, которые ещё не записаны; saving — идёт запись;
 * needs-permission — браузер просит подтвердить запись (⌘S); error — запись не удалась.
 */
export type FileState = 'none' | 'saved' | 'unsaved' | 'saving' | 'needs-permission' | 'error';

export interface EditorState {
  readonly project: Project;
  readonly page: Page;
  readonly playhead: number;
  readonly selection: readonly ClipId[];
  readonly selectedAsset: AssetId | null;
  readonly marks: Marks;
  readonly tool: Tool;
  readonly snapping: boolean;
  readonly linkedSelection: boolean;
  readonly media: ReadonlyMap<AssetId, MediaStatus>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Имя файла проекта (.vcut), если проект сохранён на диск. */
  readonly projectFile: string | null;
  readonly fileState: FileState;
}

export interface Notice {
  readonly kind: 'info' | 'error';
  readonly text: string;
}

interface MediaEntry {
  file: MediaRef | null;
  handle: MediaHandle | null;
}

const HISTORY_LIMIT = 300;
const UNTITLED = 'Без названия';
const DEFAULT_SETTINGS: TimelineSettings = { width: 1920, height: 1080, frameRate: frameRate(30), fit: 'fit' };

export class Editor {
  private s: EditorState;
  private readonly listeners = new Set<(s: EditorState) => void>();
  private readonly noticeListeners = new Set<(n: Notice) => void>();
  private past: Project[] = [];
  private future: Project[] = [];
  private readonly mediaFiles = new Map<AssetId, MediaEntry>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** В этой вкладке есть изменения, которых ещё нет в автосохранении. */
  private sessionDirty = false;
  private readonly ids: Ids = randomIds;
  private fileRef: ProjectFileRef | null = null;
  /** Номер версии монтажа; растёт с каждым изменением проекта. */
  private revision = 0;
  /** Версия, записанная в файл проекта. */
  private fileRevision = 0;
  private lastCoalesce: string | undefined;
  private lastCommitAt = 0;
  /** Записи в файл идут строго по очереди. */
  private fileWrites: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prober: MediaProber,
    private readonly repo: ProjectRepository,
    private readonly files: ProjectFiles,
    private readonly library: MediaLibrary,
    private readonly recent: RecentProjects,
  ) {
    this.s = {
      project: newProject(UNTITLED, DEFAULT_SETTINGS, this.ids),
      page: 'edit',
      playhead: 0,
      selection: [],
      selectedAsset: null,
      marks: { in: null, out: null },
      tool: 'select',
      snapping: true,
      linkedSelection: true,
      media: new Map(),
      canUndo: false,
      canRedo: false,
      projectFile: null,
      fileState: 'none',
    };
  }

  get state(): EditorState {
    return this.s;
  }

  get project(): Project {
    return this.s.project;
  }

  get timeline(): Timeline {
    return this.s.project.timeline;
  }

  get rate(): FrameRate {
    return this.s.project.timeline.frameRate;
  }

  subscribe(fn: (s: EditorState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onNotice(fn: (n: Notice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  notify(kind: Notice['kind'], text: string): void {
    for (const fn of this.noticeListeners) fn({ kind, text });
  }

  /** Файл исходника, если он доступен в этой сессии. */
  fileFor(id: AssetId): MediaRef | null {
    return this.mediaFiles.get(id)?.file ?? null;
  }

  onlineFiles(): Map<AssetId, MediaRef> {
    const out = new Map<AssetId, MediaRef>();
    for (const [id, e] of this.mediaFiles) if (e.file) out.set(id, e.file);
    return out;
  }

  assetLength = (id: AssetId): number => {
    const a = findAsset(this.s.project, id);
    return a ? assetLengthInFrames(a, this.rate) : 0;
  };

  // ── Рабочая сессия (автосохранение в браузере) ──────────────────────────

  /** Восстановление после перезагрузки страницы или сбоя вкладки. */
  async restore(): Promise<void> {
    let saved;
    try {
      saved = await this.repo.load();
    } catch (err) {
      this.notify('error', `Не удалось открыть сохранённый проект: ${message(err)}`);
      return;
    }
    if (!saved) return;
    await this.linkMedia(saved.project, saved.handles);
    this.fileRef = saved.file;
    this.revision = saved.fileInSync ? 0 : 1;
    this.fileRevision = 0;
    this.set({ project: saved.project, playhead: 0, selection: [], ...this.fileStatePatch() }, false);
    this.refreshMedia();
  }

  /** Повторный запрос доступа к файлам после перезагрузки (нужен жест пользователя). */
  async regrantAccess(): Promise<void> {
    for (const [id, entry] of this.mediaFiles) {
      if (entry.file || !entry.handle) continue;
      try {
        if ((await entry.handle.requestPermission({ mode: 'read' })) !== 'granted') continue;
        const file = await safeGetFile(entry.handle);
        const asset = findAsset(this.s.project, id);
        if (file && asset && file.size === asset.sizeBytes) entry.file = file;
        else entry.handle = null;
      } catch {
        /* пользователь отказал — файл останется недоступным */
      }
    }
    this.refreshMedia();
  }

  private scheduleSave(): void {
    this.sessionDirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 400);
  }

  /**
   * Автосохранение: сначала файл проекта (если он есть и запись разрешена),
   * затем рабочая сессия в браузере — она же страховка, если файл недоступен.
   */
  async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const ref = this.fileRef;
    if (ref && this.files.inPlace(ref) && this.revision !== this.fileRevision) {
      if (await this.files.permission(ref, 'readwrite', false).catch(() => false)) await this.writeFile(ref);
      else if (this.fileRef === ref) this.set({ fileState: 'needs-permission' });
    }
    // Сессию пишем, только если в этой вкладке что-то менялось: иначе вторая
    // открытая вкладка при закрытии затёрла бы свежий монтаж своей старой копией.
    if (!this.sessionDirty) return;
    const handles = new Map<AssetId, MediaHandle>();
    for (const [id, e] of this.mediaFiles) if (e.handle) handles.set(id, e.handle);
    try {
      this.sessionDirty = false;
      await this.repo.save({ project: this.s.project, handles, file: this.fileRef, fileInSync: this.revision === this.fileRevision });
    } catch (err) {
      this.sessionDirty = true;
      this.notify('error', `Автосохранение не удалось: ${message(err)}`);
    }
  }

  // ── Файл проекта (.vcut) ────────────────────────────────────────────────

  /** Есть ли работа, которой нет в файле проекта (пустой проект не в счёт). */
  hasUnsavedWork(): boolean {
    const p = this.s.project;
    if (p.assets.length === 0 && isTimelineEmpty(p)) return false;
    return !this.fileRef || this.revision !== this.fileRevision;
  }

  /**
   * ⌘S — сохранить в текущий файл, ⇧⌘S (as) — выбрать новый.
   * Вызывать из обработчика действия пользователя: браузер может спросить разрешение.
   */
  async saveToFile(opts: { as?: boolean } = {}): Promise<boolean> {
    let ref = this.fileRef;
    try {
      if (!ref || opts.as || !this.files.inPlace(ref)) {
        const picked = await this.files.pickSaveTarget(safeFileName(this.s.project.name) + PROJECT_EXT);
        if (!picked) return false;
        ref = picked;
      } else if (!(await this.files.permission(ref, 'readwrite', true))) {
        this.set({ fileState: 'needs-permission' });
        this.notify('error', 'Браузер не разрешил запись в файл проекта. Сохраните его как новый файл (⇧⌘S).');
        return false;
      }
    } catch (err) {
      this.notify('error', `Не удалось сохранить проект: ${message(err)}`);
      return false;
    }
    if (ref !== this.fileRef && this.s.project.name === UNTITLED) {
      // Безымянный проект получает имя файла.
      this.set({ project: { ...this.s.project, name: nameFromFile(ref.name) } }, false);
      this.revision++;
    }
    this.fileRef = ref;
    this.set({ projectFile: ref.name }, false);
    const ok = await this.writeFile(ref);
    if (ok) {
      if (this.files.inPlace(ref)) void this.recent.add(ref).catch(() => {});
      this.sessionDirty = true;
      await this.saveNow();
      this.notify('info', `Проект сохранён: ${ref.name}`);
    }
    return ok;
  }

  private writeFile(ref: ProjectFileRef): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const rev = this.revision;
      const text = serializeProjectFile(this.s.project);
      if (this.fileRef === ref) this.set({ fileState: 'saving' });
      try {
        await this.files.write(ref, text);
        if (this.fileRef === ref) {
          this.fileRevision = rev;
          this.set(this.fileStatePatch());
        }
        return true;
      } catch (err) {
        if (this.fileRef === ref) this.set({ fileState: 'error' });
        this.notify('error', `Не удалось записать «${ref.name}»: ${message(err)}`);
        return false;
      }
    };
    const p = this.fileWrites.then(run, run);
    this.fileWrites = p;
    return p;
  }

  /** ⌘O — открыть файл проекта через диалог. */
  async openFromPicker(): Promise<boolean> {
    let picked;
    try {
      picked = await this.files.pickAndRead();
    } catch (err) {
      this.notify('error', `Не удалось открыть файл: ${message(err)}`);
      return false;
    }
    return picked ? this.load(picked.text, picked.ref) : false;
  }

  /** Открыть недавний проект. Вызывать из обработчика щелчка: может понадобиться разрешение. */
  async openRecent(ref: ProjectFileRef): Promise<boolean> {
    let text: string;
    try {
      if (!(await this.files.permission(ref, 'read', true))) {
        this.notify('error', `Нет разрешения на чтение «${ref.name}»`);
        return false;
      }
      text = await this.files.read(ref);
    } catch {
      this.notify('error', `Файл «${ref.name}» не найден — он мог быть перемещён или удалён`);
      void this.recent.remove(ref).catch(() => {});
      return false;
    }
    return this.load(text, ref);
  }

  /** Проект, переданный приложением (двойной щелчок по .vcut в Finder). */
  openText(text: string, ref: ProjectFileRef): Promise<boolean> {
    return this.load(text, ref);
  }

  /** Файл проекта, перетащенный в окно. */
  async openDropped(file: File, handle: FileSystemFileHandle | null): Promise<boolean> {
    return this.load(await file.text(), { name: file.name, handle });
  }

  async recentProjects(): Promise<ProjectFileRef[]> {
    try {
      return await this.recent.list();
    } catch {
      return [];
    }
  }

  private async load(text: string, ref: ProjectFileRef): Promise<boolean> {
    let project: Project;
    try {
      project = parseProjectFile(text);
    } catch (err) {
      this.notify('error', `«${ref.name}»: ${message(err)}`);
      return false;
    }
    await this.fileWrites.catch(() => {});
    this.past = [];
    this.future = [];
    this.mediaFiles.clear();
    await this.linkMedia(project, new Map());
    this.fileRef = ref;
    this.revision = 0;
    this.fileRevision = 0;
    this.set(
      {
        project,
        playhead: 0,
        selection: [],
        selectedAsset: null,
        marks: { in: null, out: null },
        canUndo: false,
        canRedo: false,
        ...this.fileStatePatch(),
      },
      false,
    );
    this.refreshMedia();
    if (this.files.inPlace(ref)) void this.recent.add(ref).catch(() => {});
    this.sessionDirty = true;
    await this.saveNow();
    const missing = project.assets.filter((a) => !this.mediaFiles.get(a.id)?.file).length;
    this.notify('info', `Открыт проект «${project.name}»` + (missing ? ` · нужно подключить файлов: ${missing}` : ''));
    return true;
  }

  newProject(settings: TimelineSettings = this.s.project.settings): void {
    this.past = [];
    this.future = [];
    this.mediaFiles.clear();
    this.fileRef = null;
    this.revision = 0;
    this.fileRevision = 0;
    this.set(
      {
        project: newProject(UNTITLED, settings, this.ids),
        playhead: 0,
        selection: [],
        selectedAsset: null,
        marks: { in: null, out: null },
        canUndo: false,
        canRedo: false,
        ...this.fileStatePatch(),
      },
      false,
    );
    this.refreshMedia();
    this.scheduleSave();
  }

  private fileStatePatch(): Pick<EditorState, 'projectFile' | 'fileState'> {
    if (!this.fileRef) return { projectFile: null, fileState: 'none' };
    return { projectFile: this.fileRef.name, fileState: this.revision === this.fileRevision ? 'saved' : 'unsaved' };
  }

  /**
   * Находит исходники проекта: сначала по сохранённым ссылкам сессии,
   * затем в библиотеке по имени и размеру. Файл с другим размером не подключается.
   */
  private async linkMedia(project: Project, known: ReadonlyMap<AssetId, MediaHandle>): Promise<void> {
    for (const asset of project.assets) {
      let handle = known.get(asset.id) ?? null;
      if (!handle) handle = await this.library.find(asset.name, asset.sizeBytes).catch(() => null);
      let file: MediaRef | null = null;
      if (handle && (await handle.queryPermission({ mode: 'read' }).catch(() => 'denied')) === 'granted') {
        file = await safeGetFile(handle);
        // Файл с тем же именем, но другого размера — это другой файл: ссылку отбрасываем.
        if (!file || file.size !== asset.sizeBytes) {
          file = null;
          handle = null;
        }
      }
      this.mediaFiles.set(asset.id, { file, handle });
    }
  }

  /** Подключить недостающие исходники из выбранных файлов (по имени и размеру). Новые файлы не импортируются. */
  async relinkFiles(items: readonly { file: File; handle?: MediaHandle | null }[]): Promise<number> {
    let linked = 0;
    for (const { file, handle } of items) {
      const asset = this.s.project.assets.find((a) => a.name === file.name && a.sizeBytes === file.size);
      if (!asset || this.mediaFiles.get(asset.id)?.file) continue;
      this.mediaFiles.set(asset.id, { file, handle: handle ?? null });
      if (handle) void this.library.remember(file.name, file.size, handle).catch(() => {});
      linked++;
    }
    if (linked) {
      this.refreshMedia();
      this.scheduleSave();
    }
    return linked;
  }

  // ── Импорт ──────────────────────────────────────────────────────────────

  /**
   * Импорт файлов в Media Pool. Уже известные (то же имя и размер) не дублируются,
   * а переподключаются — так восстанавливаются «офлайн» исходники.
   */
  async importFiles(items: readonly { file: File; handle?: MediaHandle | null }[]): Promise<AssetId[]> {
    const added: MediaAsset[] = [];
    const ids: AssetId[] = [];
    let relinked = false;
    for (const { file, handle } of items) {
      if (handle) void this.library.remember(file.name, file.size, handle).catch(() => {});
      const known = this.s.project.assets.find((a) => a.name === file.name && a.sizeBytes === file.size);
      if (known) {
        this.mediaFiles.set(known.id, { file, handle: handle ?? this.mediaFiles.get(known.id)?.handle ?? null });
        ids.push(known.id);
        relinked = true;
        continue;
      }
      try {
        const meta = await this.prober.probe(file);
        if (meta.video && !meta.video.decodable)
          throw new Error(`видео ${meta.video.codec} не поддерживается браузером`);
        const asset: MediaAsset = { id: newAssetId(), ...meta };
        this.mediaFiles.set(asset.id, { file, handle: handle ?? null });
        added.push(asset);
        ids.push(asset.id);
      } catch (err) {
        this.notify('error', `«${file.name}»: ${message(err)}`);
      }
    }
    if (added.length) {
      let project: Project = { ...this.s.project, assets: [...this.s.project.assets, ...added] };
      // На пустом таймлайне частота берётся с первого видео (как предлагает Resolve).
      const firstVideo = added.find((a) => a.video);
      if (firstVideo?.video && isTimelineEmpty(project) && !sameFrameRate(firstVideo.video.frameRate, project.settings.frameRate)) {
        project = changeSettings(project, { ...project.settings, frameRate: firstVideo.video.frameRate });
        this.notify('info', `Частота таймлайна: ${(firstVideo.video.frameRate.num / firstVideo.video.frameRate.den).toFixed(3).replace(/\.?0+$/, '')} кадр/с — по «${firstVideo.name}»`);
      }
      this.commit(project, { selectedAsset: added[0]!.id });
    } else if (relinked) this.scheduleSave();
    this.refreshMedia();
    return ids;
  }

  removeAsset(id: AssetId): void {
    if (allClips(this.timeline).some((r) => r.clip.assetId === id)) {
      this.notify('error', 'Файл используется на таймлайне');
      return;
    }
    // Запись о файле остаётся: отмена удаления вернёт его «онлайн».
    this.commit({ ...this.s.project, assets: this.s.project.assets.filter((a) => a.id !== id) }, { selectedAsset: null });
  }

  private refreshMedia(): void {
    const media = new Map<AssetId, MediaStatus>();
    for (const a of this.s.project.assets) {
      const e = this.mediaFiles.get(a.id);
      media.set(a.id, e?.file ? 'online' : e?.handle ? 'needs-permission' : 'offline');
    }
    this.set({ media });
  }

  // ── Размещение на таймлайне ────────────────────────────────────────────

  private targets(): { video: TrackId; audio: TrackId } {
    return { video: tracksOfKind(this.timeline, 'video')[0]!.id, audio: tracksOfKind(this.timeline, 'audio')[0]!.id };
  }

  /** Shift+F12 — в конец таймлайна. */
  appendAsset(id: AssetId = this.s.selectedAsset!): void {
    this.edit('append', id);
  }

  /** F9 — вставка в позицию плейхеда со сдвигом. */
  insertAsset(id: AssetId = this.s.selectedAsset!): void {
    this.edit('insert', id);
  }

  /** F10 — перезапись в позиции плейхеда. */
  overwriteAsset(id: AssetId = this.s.selectedAsset!, at = this.s.playhead, target?: { video: TrackId | null; audio: TrackId | null }): void {
    this.edit('overwrite', id, at, target);
  }

  private edit(kind: 'append' | 'insert' | 'overwrite', id: AssetId | null, at = this.s.playhead, target?: { video: TrackId | null; audio: TrackId | null }): void {
    if (!id) return this.notify('info', 'Выберите файл в Media Pool');
    const asset = findAsset(this.s.project, id);
    if (!asset) return;
    this.tryCommit(() => {
      const tl = this.timeline;
      const items = placementsForAsset(tl, asset, target ?? this.targets());
      const r = kind === 'append' ? appendAtEnd(tl, items, this.ids) : kind === 'insert' ? insert(tl, at, items, this.ids) : overwrite(tl, at, items, this.ids);
      const start = findClip(r.timeline, r.created[0]!)!.clip;
      return { timeline: r.timeline, extra: { selection: r.created, playhead: clipEnd(start) } };
    });
  }

  // ── Резы и удаление ────────────────────────────────────────────────────

  /** Cmd+B: режет выделенные клипы, а без выделения — все дорожки под плейхедом. */
  splitAtPlayhead(): void {
    this.splitAt(this.s.playhead, this.s.selection.length ? this.s.selection : null);
  }

  splitAt(frame: number, clips: readonly ClipId[] | null): void {
    this.tryCommit(() => ({
      timeline: clips ? splitClipsAt(this.timeline, frame, clips, this.ids) : splitAt(this.timeline, frame, this.ids),
    }));
  }

  /** Backspace — удалить, оставив пустоту; Shift+Backspace — со сдвигом. Без выделения работает по In/Out. */
  deleteSelection(ripple: boolean): void {
    const { selection, marks } = this.s;
    if (selection.length) {
      const ids = this.s.linkedSelection ? withLinked(this.timeline, selection) : selection;
      this.tryCommit(() => ({ timeline: ripple ? rippleDelete(this.timeline, ids) : lift(this.timeline, ids), extra: { selection: [] } }));
      return;
    }
    if (marks.in !== null && marks.out !== null && marks.out > marks.in) {
      this.tryCommit(() => ({
        timeline: rippleDeleteRange(this.timeline, marks.in!, marks.out!, this.ids),
        extra: { marks: { in: null, out: null }, playhead: marks.in! },
      }));
    }
  }

  // ── Титры ───────────────────────────────────────────────────────────────

  /**
   * Добавить титр в кадр `at` (по умолчанию под плейхедом) длиной 5 секунд.
   * Без явной дорожки титр встаёт на первую свободную видеодорожку выше V1;
   * если такой нет — создаётся новая (как V2 в Resolve).
   */
  addTitle(template: TitleTemplate, at = this.s.playhead, trackId?: TrackId): void {
    const length = Math.max(1, Math.round(fpsValue(this.rate) * 5));
    this.tryCommit(() => {
      let tl = this.timeline;
      let target = trackId ?? null;
      if (!target) {
        const video = tracksOfKind(tl, 'video');
        const empty = allClips(tl).length === 0;
        const free = (t: (typeof video)[number]) => t.clips.every((c) => clipEnd(c) <= at || c.start >= at + length);
        const candidates = empty ? video : video.slice(1);
        target = candidates.find(free)?.id ?? null;
        if (!target) {
          tl = addTrack(tl, 'video', this.ids);
          target = tracksOfKind(tl, 'video').at(-1)!.id;
        }
      }
      const r = overwrite(tl, at, [{ trackId: target, assetId: null, title: defaultTitle(template), sourceIn: 0, length }], this.ids);
      return { timeline: r.timeline, extra: { selection: r.created } };
    });
  }

  /** Изменить оформление титра. Набор текста подряд — один шаг отмены. */
  updateTitle(clipId: ClipId, patch: Partial<TitleStyle>): void {
    const ref = findClip(this.timeline, clipId);
    if (!ref?.clip.title) return;
    const title = sanitizeTitle({ ...ref.clip.title, ...patch });
    const timeline: Timeline = {
      ...this.timeline,
      tracks: this.timeline.tracks.map((t) => (t.id !== ref.track.id ? t : { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, title } : c)) })),
    };
    this.commit({ ...this.s.project, timeline }, {}, `title:${clipId}`);
  }

  /** Единственный выделенный титр — для инспектора. */
  selectedTitle(): { id: ClipId; title: TitleStyle } | null {
    const titles = this.s.selection.map((id) => findClip(this.timeline, id)?.clip).filter((c) => c?.title);
    return titles.length === 1 ? { id: titles[0]!.id, title: titles[0]!.title! } : null;
  }

  // ── Дорожки ─────────────────────────────────────────────────────────────

  addTrack(kind: TrackKind): void {
    this.tryCommit(() => ({ timeline: addTrack(this.timeline, kind, this.ids) }));
  }

  /** Удалить дорожку вместе с клипами (⌘Z вернёт). */
  deleteTrack(id: TrackId): void {
    this.tryCommit(() => ({ timeline: deleteTrack(this.timeline, id) }));
  }

  /** Удалить все пустые видео- или аудиодорожки. */
  deleteEmptyTracks(kind: TrackKind): void {
    this.tryCommit(() => ({ timeline: deleteEmptyTracks(this.timeline, kind) }));
  }

  /** Применить результат перетаскивания/подрезки, посчитанный интерфейсом через функции домена. */
  applyTimeline(timeline: Timeline, extra: Partial<EditorState> = {}): void {
    if (timeline === this.timeline) return;
    this.tryCommit(() => ({ timeline, extra }));
  }

  // ── Настройки ───────────────────────────────────────────────────────────

  changeSettings(settings: TimelineSettings): void {
    try {
      this.commit(changeSettings(this.s.project, settings));
    } catch (err) {
      this.notify('error', message(err));
    }
  }

  rename(name: string): void {
    const trimmed = name.trim();
    if (trimmed && trimmed !== this.s.project.name) this.commit({ ...this.s.project, name: trimmed });
  }

  // ── Навигация и выделение (не попадают в историю) ───────────────────────

  setPage(page: Page): void {
    this.set({ page });
  }

  setPlayhead(frame: number): void {
    const f = Math.max(0, Math.round(frame));
    if (f !== this.s.playhead) this.set({ playhead: f });
  }

  stepPlayhead(delta: number): void {
    this.setPlayhead(this.s.playhead + delta);
  }

  /** Стрелки вверх/вниз — к предыдущей/следующей точке монтажа. */
  jumpToEdit(direction: 1 | -1): void {
    const points = new Set<number>([0, timelineEnd(this.timeline)]);
    for (const { clip } of allClips(this.timeline)) {
      points.add(clip.start);
      points.add(clipEnd(clip));
    }
    const sorted = [...points].sort((a, b) => a - b);
    const p = this.s.playhead;
    const next = direction > 0 ? sorted.find((x) => x > p) : [...sorted].reverse().find((x) => x < p);
    if (next !== undefined) this.setPlayhead(next);
  }

  select(ids: readonly ClipId[], mode: 'replace' | 'toggle' = 'replace'): void {
    const expanded = this.s.linkedSelection ? withLinked(this.timeline, ids) : [...ids];
    if (mode === 'replace') return this.set({ selection: expanded });
    const current = new Set(this.s.selection);
    const allIn = expanded.every((id) => current.has(id));
    for (const id of expanded) allIn ? current.delete(id) : current.add(id);
    this.set({ selection: [...current] });
  }

  selectAsset(id: AssetId | null): void {
    this.set({ selectedAsset: id });
  }

  setTool(tool: Tool): void {
    this.set({ tool });
  }

  toggleSnapping(): void {
    this.set({ snapping: !this.s.snapping });
  }

  toggleLinkedSelection(): void {
    this.set({ linkedSelection: !this.s.linkedSelection });
  }

  markIn(frame = this.s.playhead): void {
    const out = this.s.marks.out !== null && this.s.marks.out <= frame ? null : this.s.marks.out;
    this.set({ marks: { in: frame, out } });
  }

  /** Out ставится включительно: кадр под плейхедом входит в диапазон. */
  markOut(frame = this.s.playhead): void {
    const end = frame + 1;
    const inn = this.s.marks.in !== null && this.s.marks.in >= end ? null : this.s.marks.in;
    this.set({ marks: { in: inn, out: end } });
  }

  clearMarks(): void {
    this.set({ marks: { in: null, out: null } });
  }

  // ── История ─────────────────────────────────────────────────────────────

  undo(): void {
    this.lastCoalesce = undefined;
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.s.project);
    this.set({ project: prev, selection: this.validSelection(prev) }, false);
    this.afterProjectChange();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.s.project);
    this.set({ project: next, selection: this.validSelection(next) }, false);
    this.afterProjectChange();
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────

  private tryCommit(fn: () => { timeline: Timeline; extra?: Partial<EditorState> }): void {
    try {
      const { timeline, extra } = fn();
      if (timeline === this.timeline && !extra) return;
      this.commit({ ...this.s.project, timeline }, extra);
    } catch (err) {
      this.notify('error', message(err));
    }
  }

  /**
   * @param coalesce — ключ серии правок (например, набор текста титра):
   *   правки с тем же ключом подряд в течение пары секунд — один шаг отмены.
   */
  private commit(project: Project, extra: Partial<EditorState> = {}, coalesce?: string): void {
    const errors = validateTimeline(project.timeline);
    if (errors.length) {
      // Защитный барьер: ошибка в логике монтажа не должна испортить проект.
      console.error('Отклонено изменение с нарушением инвариантов', errors);
      this.notify('error', 'Операция отменена: она повредила бы таймлайн');
      return;
    }
    if (project !== this.s.project) {
      const now = Date.now();
      const continues = coalesce !== undefined && coalesce === this.lastCoalesce && now - this.lastCommitAt < 2000;
      if (!continues) {
        this.past.push(this.s.project);
        if (this.past.length > HISTORY_LIMIT) this.past.shift();
      }
      this.future = [];
      this.lastCoalesce = coalesce;
      this.lastCommitAt = now;
    }
    this.set({ ...extra, project }, false);
    if (extra.selection === undefined) this.set({ selection: this.validSelection(project) }, false);
    this.afterProjectChange();
  }

  private afterProjectChange(): void {
    this.revision++;
    this.set({ canUndo: this.past.length > 0, canRedo: this.future.length > 0, ...this.fileStatePatch() }, false);
    this.refreshMedia();
    this.scheduleSave();
  }

  private validSelection(p: Project): ClipId[] {
    return this.s.selection.filter((id) => findClip(p.timeline, id));
  }

  private set(patch: Partial<EditorState>, emit = true): void {
    this.s = { ...this.s, ...patch };
    if (emit) for (const fn of this.listeners) fn(this.s);
  }
}

async function safeGetFile(handle: MediaHandle): Promise<File | null> {
  try {
    return await handle.getFile();
  } catch {
    return null;
  }
}

const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || UNTITLED;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
