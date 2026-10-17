import { newAssetId, randomIds } from '../domain/ids';
import type { AssetId, MediaAsset } from '../domain/media';
import { type Project, type TimelineSettings, changeSettings, findAsset, isTimelineEmpty, newProject } from '../domain/project';
import { type FrameRate, frameRate, sameFrameRate } from '../domain/time';
import {
  type ClipId, type Ids, type Timeline, type TrackId, type TrackKind,
  addTrack, allClips, appendAtEnd, assetLengthInFrames, clipEnd, findClip, insert, lift, overwrite,
  placementsForAsset, removeTrack, rippleDelete, rippleDeleteRange, splitAt, splitClipsAt, timelineEnd,
  tracksOfKind, validateTimeline, withLinked,
} from '../domain/timeline';
import type { MediaHandle, MediaProber, MediaRef, ProjectRepository } from './ports';

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
const DEFAULT_SETTINGS: TimelineSettings = { width: 1920, height: 1080, frameRate: frameRate(30), fit: 'fit' };

export class Editor {
  private s: EditorState;
  private readonly listeners = new Set<(s: EditorState) => void>();
  private readonly noticeListeners = new Set<(n: Notice) => void>();
  private past: Project[] = [];
  private future: Project[] = [];
  private readonly mediaFiles = new Map<AssetId, MediaEntry>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ids: Ids = randomIds;

  constructor(
    private readonly prober: MediaProber,
    private readonly repo: ProjectRepository,
  ) {
    this.s = {
      project: newProject('Без названия', DEFAULT_SETTINGS, this.ids),
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

  // ── Загрузка и сохранение ──────────────────────────────────────────────

  async restore(): Promise<void> {
    let saved;
    try {
      saved = await this.repo.load();
    } catch (err) {
      this.notify('error', `Не удалось открыть сохранённый проект: ${message(err)}`);
      return;
    }
    if (!saved) return;
    for (const asset of saved.project.assets) {
      const handle = saved.handles.get(asset.id) ?? null;
      let file: MediaRef | null = null;
      if (handle && (await handle.queryPermission({ mode: 'read' })) === 'granted') file = await safeGetFile(handle);
      this.mediaFiles.set(asset.id, { file, handle });
    }
    this.set({ project: saved.project, playhead: 0, selection: [] }, false);
    this.refreshMedia();
  }

  /** Повторный запрос доступа к файлам после перезагрузки (нужен жест пользователя). */
  async regrantAccess(): Promise<void> {
    for (const [, entry] of this.mediaFiles) {
      if (entry.file || !entry.handle) continue;
      try {
        if ((await entry.handle.requestPermission({ mode: 'read' })) === 'granted') entry.file = await safeGetFile(entry.handle);
      } catch {
        /* пользователь отказал — файл останется недоступным */
      }
    }
    this.refreshMedia();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 400);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const handles = new Map<AssetId, MediaHandle>();
    for (const [id, e] of this.mediaFiles) if (e.handle) handles.set(id, e.handle);
    try {
      await this.repo.save(this.s.project, handles);
    } catch (err) {
      this.notify('error', `Автосохранение не удалось: ${message(err)}`);
    }
  }

  newProject(settings: TimelineSettings = this.s.project.settings): void {
    this.past = [];
    this.future = [];
    this.mediaFiles.clear();
    this.set({ project: newProject('Без названия', settings, this.ids), playhead: 0, selection: [], selectedAsset: null, marks: { in: null, out: null } }, false);
    this.refreshMedia();
    this.scheduleSave();
  }

  // ── Импорт ──────────────────────────────────────────────────────────────

  /**
   * Импорт файлов в Media Pool. Уже известные (то же имя и размер) не дублируются,
   * а переподключаются — так восстанавливаются «офлайн» исходники.
   */
  async importFiles(items: readonly { file: File; handle?: MediaHandle | null }[]): Promise<AssetId[]> {
    const added: MediaAsset[] = [];
    const ids: AssetId[] = [];
    for (const { file, handle } of items) {
      const known = this.s.project.assets.find((a) => a.name === file.name && a.sizeBytes === file.size);
      if (known) {
        this.mediaFiles.set(known.id, { file, handle: handle ?? this.mediaFiles.get(known.id)?.handle ?? null });
        ids.push(known.id);
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
    }
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

  // ── Дорожки ─────────────────────────────────────────────────────────────

  addTrack(kind: TrackKind): void {
    this.tryCommit(() => ({ timeline: addTrack(this.timeline, kind, this.ids) }));
  }

  removeTrack(id: TrackId): void {
    this.tryCommit(() => ({ timeline: removeTrack(this.timeline, id) }));
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

  private commit(project: Project, extra: Partial<EditorState> = {}): void {
    const errors = validateTimeline(project.timeline);
    if (errors.length) {
      // Защитный барьер: ошибка в логике монтажа не должна испортить проект.
      console.error('Отклонено изменение с нарушением инвариантов', errors);
      this.notify('error', 'Операция отменена: она повредила бы таймлайн');
      return;
    }
    if (project !== this.s.project) {
      this.past.push(this.s.project);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future = [];
    }
    this.set({ ...extra, project }, false);
    if (extra.selection === undefined) this.set({ selection: this.validSelection(project) }, false);
    this.afterProjectChange();
  }

  private afterProjectChange(): void {
    this.set({ canUndo: this.past.length > 0, canRedo: this.future.length > 0 }, false);
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

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
