import type { Editor, EditorState } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import { randomIds } from '../domain/ids';
import type { AssetId } from '../domain/media';
import { findAsset } from '../domain/project';
import { formatTimecode, fpsValue } from '../domain/time';
import {
  type Clip, type ClipId, type Timeline, type Track, type TrackId,
  allClips, clipEnd, moveClips, timelineEnd, trackName, tracksOfKind, trimEnd, trimStart,
} from '../domain/timeline';
import { h } from './dom';

const RULER_H = 26;
const HEADER_W = 64;
const VIDEO_H = 56;
const AUDIO_H = 44;
const EDGE_PX = 7;
const SNAP_PX = 9;
const MIN_PX_PER_FRAME = 0.02;
const MAX_PX_PER_FRAME = 40;

export const ASSET_MIME = 'application/x-vibe-asset';

interface Row {
  track: Track;
  y: number;
  h: number;
}

type Hit =
  | { kind: 'ruler' }
  | { kind: 'clip'; clip: Clip; track: Track; edge: 'start' | 'end' | null }
  | { kind: 'empty'; track: Track | null }
  | { kind: 'header' };

type Drag =
  | { kind: 'scrub' }
  | { kind: 'trim'; edge: 'start' | 'end'; clipId: ClipId; base: Timeline; startFrame: number; edgeFrame: number }
  | {
      kind: 'move';
      base: Timeline;
      ids: ClipId[];
      startX: number;
      startY: number;
      startFrame: number;
      groupStart: number;
      groupEnd: number;
      rowIndex: number;
      trackKind: 'video' | 'audio';
      active: boolean;
    };

/**
 * Таймлайн на canvas: V-дорожки сверху (верхняя — старшая), A-дорожки снизу.
 * Во время перетаскивания рисуется превью, посчитанное теми же чистыми
 * функциями домена; в проект оно попадает одним шагом истории при отпускании.
 */
export class TimelineView {
  readonly el: HTMLElement;
  private readonly wrap: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private pxPerFrame = 2;
  private scrollX = 0; // кадры
  private scrollY = 0; // пиксели
  private drag: Drag | null = null;
  private preview: Timeline | null = null;
  private snapLine: number | null = null;
  private hover: Hit | null = null;
  private dirty = true;
  private fitted = false;
  private lastEnd = 0;
  private dropFrame: number | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly playback: PlaybackController,
    toolbar: HTMLElement,
  ) {
    this.canvas = h('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.wrap = h('div', { class: 'tl-canvas-wrap' }, this.canvas);
    this.el = h('div', { class: 'timeline' }, toolbar, this.wrap);

    new ResizeObserver(() => this.invalidate()).observe(this.wrap);
    editor.subscribe((s) => this.onState(s));
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag());
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.invalidate();
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.wrap.addEventListener('dragover', (e) => this.onDragOver(e));
    this.wrap.addEventListener('dragleave', () => this.setDropFrame(null));
    this.wrap.addEventListener('drop', (e) => this.onDrop(e));
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private get state(): EditorState {
    return this.editor.state;
  }

  private get tl(): Timeline {
    return this.preview ?? this.editor.timeline;
  }

  invalidate(): void {
    this.dirty = true;
  }

  private onState(s: EditorState): void {
    // Масштаб подстраивается, когда таймлайн впервые наполняется или вырастает за край экрана.
    const end = timelineEnd(s.project.timeline);
    if (end > this.lastEnd && (!this.fitted || this.frameToX(end) > this.width())) {
      this.fitted = true;
      this.zoomToFit();
    }
    this.lastEnd = end;
    // Во время воспроизведения страница таймлайна следует за плейхедом.
    if (this.playback.playing) {
      const w = this.width() - HEADER_W;
      const x = (s.playhead - this.scrollX) * this.pxPerFrame;
      if (x > w * 0.92 || x < 0) this.scrollX = Math.max(0, s.playhead - (w * 0.1) / this.pxPerFrame);
    }
    this.invalidate();
  }

  // ── Масштаб и прокрутка ────────────────────────────────────────────────

  private width(): number {
    return this.wrap.clientWidth;
  }

  setZoom(pxPerFrame: number, anchorX = HEADER_W + (this.width() - HEADER_W) / 2): void {
    const anchorFrame = this.xToFrameRaw(anchorX);
    this.pxPerFrame = Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, pxPerFrame));
    this.scrollX = Math.max(0, anchorFrame - (anchorX - HEADER_W) / this.pxPerFrame);
    this.invalidate();
  }

  zoomBy(factor: number): void {
    const playX = HEADER_W + (this.state.playhead - this.scrollX) * this.pxPerFrame;
    const inView = playX >= HEADER_W && playX <= this.width();
    this.setZoom(this.pxPerFrame * factor, inView ? playX : undefined);
  }

  zoomToFit(): void {
    const end = Math.max(timelineEnd(this.editor.timeline), Math.round(fpsValue(this.editor.rate) * 10));
    this.pxPerFrame = Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, ((this.width() || 1000) - HEADER_W - 30) / end));
    this.scrollX = 0;
    this.invalidate();
  }

  get zoom(): number {
    return this.pxPerFrame;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Щипок на трекпаде приходит как wheel с ctrlKey.
      this.setZoom(this.pxPerFrame * Math.exp(-e.deltaY * 0.01), e.offsetX);
      return;
    }
    const contentH = this.rows().reduce((s, r) => s + r.h, 0) + RULER_H;
    const overflowY = contentH > this.wrap.clientHeight;
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    const dy = e.shiftKey ? 0 : e.deltaY;
    if (Math.abs(dx) > 0) this.scrollX = Math.max(0, this.scrollX + dx / this.pxPerFrame);
    if (Math.abs(dy) > 0) {
      if (overflowY) this.scrollY = Math.max(0, Math.min(contentH - this.wrap.clientHeight + 20, this.scrollY + dy));
      else this.scrollX = Math.max(0, this.scrollX + dy / this.pxPerFrame);
    }
    this.invalidate();
  }

  // ── Геометрия ──────────────────────────────────────────────────────────

  private rows(tl: Timeline = this.tl): Row[] {
    const video = [...tracksOfKind(tl, 'video')].reverse();
    const audio = tracksOfKind(tl, 'audio');
    let y = RULER_H - this.scrollY;
    const out: Row[] = [];
    for (const track of video) {
      out.push({ track, y, h: VIDEO_H });
      y += VIDEO_H;
    }
    y += 4; // разделитель видео/звук
    for (const track of audio) {
      out.push({ track, y, h: AUDIO_H });
      y += AUDIO_H;
    }
    return out;
  }

  private frameToX(frame: number): number {
    return HEADER_W + (frame - this.scrollX) * this.pxPerFrame;
  }

  private xToFrameRaw(x: number): number {
    return this.scrollX + (x - HEADER_W) / this.pxPerFrame;
  }

  private xToFrame(x: number): number {
    return Math.max(0, Math.round(this.xToFrameRaw(x)));
  }

  private rowAt(y: number): Row | null {
    return this.rows().find((r) => y >= r.y && y < r.y + r.h) ?? null;
  }

  private hit(x: number, y: number): Hit {
    if (y < RULER_H) return { kind: 'ruler' };
    if (x < HEADER_W) return { kind: 'header' };
    const row = this.rowAt(y);
    if (!row) return { kind: 'empty', track: null };
    const f = this.xToFrameRaw(x);
    const clip = row.track.clips.find((c) => f >= c.start && f < clipEnd(c));
    if (!clip) {
      // Край клипа ловим и чуть снаружи — так удобнее хватать короткие клипы.
      const near = row.track.clips.find(
        (c) => Math.abs(this.frameToX(c.start) - x) <= EDGE_PX || Math.abs(this.frameToX(clipEnd(c)) - x) <= EDGE_PX,
      );
      if (near && this.state.tool === 'select')
        return { kind: 'clip', clip: near, track: row.track, edge: Math.abs(this.frameToX(near.start) - x) <= EDGE_PX ? 'start' : 'end' };
      return { kind: 'empty', track: row.track };
    }
    let edge: 'start' | 'end' | null = null;
    const w = clip.length * this.pxPerFrame;
    if (this.state.tool === 'select' && w > EDGE_PX * 3) {
      if (x - this.frameToX(clip.start) <= EDGE_PX) edge = 'start';
      else if (this.frameToX(clipEnd(clip)) - x <= EDGE_PX) edge = 'end';
    }
    return { kind: 'clip', clip, track: row.track, edge };
  }

  // ── Привязка ───────────────────────────────────────────────────────────

  private snapPoints(exclude: ReadonlySet<ClipId>): number[] {
    const pts = new Set<number>([0, this.state.playhead]);
    const { marks } = this.state;
    if (marks.in !== null) pts.add(marks.in);
    if (marks.out !== null) pts.add(marks.out);
    for (const { clip } of allClips(this.editor.timeline)) {
      if (exclude.has(clip.id)) continue;
      pts.add(clip.start);
      pts.add(clipEnd(clip));
    }
    return [...pts];
  }

  /** Ближайшая точка привязки к любому из кандидатов; возвращает сдвиг. */
  private snapDelta(candidates: number[], exclude: ReadonlySet<ClipId>, disable: boolean): number {
    this.snapLine = null;
    if (!this.state.snapping || disable) return 0;
    const limit = SNAP_PX / this.pxPerFrame;
    let best = 0;
    let bestDist = Infinity;
    for (const p of this.snapPoints(exclude))
      for (const c of candidates) {
        const d = p - c;
        if (Math.abs(d) <= limit && Math.abs(d) < bestDist) {
          best = d;
          bestDist = Math.abs(d);
          this.snapLine = p;
        }
      }
    return best;
  }

  // ── Мышь ───────────────────────────────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const hit = this.hit(e.offsetX, e.offsetY);
    const frame = this.xToFrame(e.offsetX);
    this.canvas.setPointerCapture(e.pointerId);

    if (hit.kind === 'ruler') {
      this.playback.stop();
      this.drag = { kind: 'scrub' };
      this.scrubTo(e.offsetX, e.altKey);
      return;
    }
    if (hit.kind !== 'clip') {
      if (hit.kind === 'empty') this.editor.select([]);
      return;
    }
    this.playback.stop();
    if (this.state.tool === 'blade') {
      const snapped = frame + this.snapDelta([frame], new Set(), e.altKey);
      this.snapLine = null;
      this.editor.splitAt(snapped, this.state.linkedSelection ? [hit.clip.id] : [hit.clip.id]);
      return;
    }
    if (hit.edge) {
      this.editor.select([hit.clip.id]);
      this.drag = {
        kind: 'trim',
        edge: hit.edge,
        clipId: hit.clip.id,
        base: this.editor.timeline,
        startFrame: frame,
        edgeFrame: hit.edge === 'start' ? hit.clip.start : clipEnd(hit.clip),
      };
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) this.editor.select([hit.clip.id], 'toggle');
    else if (!this.state.selection.includes(hit.clip.id)) this.editor.select([hit.clip.id]);
    const ids = [...this.state.selection];
    if (!ids.includes(hit.clip.id)) return;
    const clips = ids.map((id) => allClips(this.editor.timeline).find((r) => r.clip.id === id)!.clip);
    this.drag = {
      kind: 'move',
      base: this.editor.timeline,
      ids,
      startX: e.offsetX,
      startY: e.offsetY,
      startFrame: this.xToFrameRaw(e.offsetX),
      groupStart: Math.min(...clips.map((c) => c.start)),
      groupEnd: Math.max(...clips.map(clipEnd)),
      rowIndex: this.rows().findIndex((r) => r.track.id === hit.track.id),
      trackKind: hit.track.kind,
      active: false,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      const hit = this.hit(e.offsetX, e.offsetY);
      this.hover = hit;
      this.canvas.style.cursor =
        this.state.tool === 'blade' && hit.kind === 'clip' ? 'crosshair' : hit.kind === 'clip' && hit.edge ? 'ew-resize' : hit.kind === 'ruler' ? 'text' : 'default';
      this.invalidate();
      return;
    }
    if (d.kind === 'scrub') return this.scrubTo(e.offsetX, e.altKey);

    if (d.kind === 'trim') {
      const raw = this.xToFrame(e.offsetX) - d.startFrame;
      const exclude = new Set([d.clipId]);
      const delta = raw + this.snapDelta([d.edgeFrame + raw], exclude, e.altKey);
      try {
        this.preview = d.edge === 'start' ? trimStart(d.base, d.clipId, delta) : trimEnd(d.base, d.clipId, delta, this.editor.assetLength);
      } catch {
        this.preview = null;
      }
      this.invalidate();
      return;
    }

    if (!d.active && Math.hypot(e.offsetX - d.startX, e.offsetY - d.startY) < 4) return;
    d.active = true;
    const raw = Math.round(this.xToFrameRaw(e.offsetX) - d.startFrame);
    const exclude = new Set(d.ids);
    const delta = raw + this.snapDelta([d.groupStart + raw, d.groupEnd + raw], exclude, e.altKey);
    // Перенос по вертикали — на соседние дорожки того же вида.
    const rows = this.rows(d.base);
    const overRow = this.rowAt(e.offsetY);
    const over = overRow ? rows.findIndex((r) => r.track.id === overRow.track.id) : d.rowIndex;
    const rowDelta = overRow && overRow.track.kind === d.trackKind ? over - d.rowIndex : 0;
    const trackDelta = d.trackKind === 'video' ? { video: -rowDelta } : { audio: rowDelta };
    try {
      this.preview = moveClips(d.base, d.ids, delta, randomIds, trackDelta);
    } catch {
      this.preview = null;
    }
    this.invalidate();
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.snapLine = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d && (d.kind === 'trim' || (d.kind === 'move' && d.active)) && this.preview) this.editor.applyTimeline(this.preview);
    this.preview = null;
    this.invalidate();
  }

  private cancelDrag(): void {
    this.drag = null;
    this.preview = null;
    this.snapLine = null;
    this.invalidate();
  }

  private scrubTo(x: number, noSnap: boolean): void {
    const f = this.xToFrame(x);
    this.editor.setPlayhead(f + this.snapDelta([f], new Set(), noSnap));
  }

  // ── Перетаскивание из Media Pool ──────────────────────────────────────

  private onDragOver(e: DragEvent): void {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes(ASSET_MIME)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    const f = this.xToFrame(e.offsetX);
    this.setDropFrame(f + this.snapDelta([f], new Set(), e.altKey));
  }

  private setDropFrame(f: number | null): void {
    this.dropFrame = f;
    if (f === null) this.snapLine = null;
    this.wrap.classList.toggle('drop', f !== null);
    this.invalidate();
  }

  private onDrop(e: DragEvent): void {
    const id = e.dataTransfer?.getData(ASSET_MIME) as AssetId | undefined;
    const frame = this.dropFrame;
    this.setDropFrame(null);
    if (!id || frame === null) return;
    e.preventDefault();
    e.stopPropagation();
    this.playback.stop();
    this.editor.overwriteAsset(id, frame, this.dropTargets(e.offsetY));
  }

  /** Видео на дорожку под курсором, звук — на A с тем же номером (или A1). */
  private dropTargets(y: number): { video: TrackId | null; audio: TrackId | null } {
    const tl = this.editor.timeline;
    const video = tracksOfKind(tl, 'video');
    const audio = tracksOfKind(tl, 'audio');
    const row = this.rowAt(y);
    if (row?.track.kind === 'audio') {
      const ai = audio.indexOf(row.track);
      return { video: (video[ai] ?? video[0]!).id, audio: row.track.id };
    }
    const vi = row ? video.indexOf(row.track) : 0;
    return { video: (video[vi] ?? video[0]!).id, audio: (audio[vi] ?? audio[0]!).id };
  }

  // ── Отрисовка ──────────────────────────────────────────────────────────

  private draw(): void {
    this.dirty = false;
    const dpr = devicePixelRatio || 1;
    const w = this.wrap.clientWidth;
    const hgt = this.wrap.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hgt * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1d1d20';
    ctx.fillRect(0, 0, w, hgt);

    const tl = this.tl;
    const rows = this.rows(tl);
    const s = this.state;
    const selection = new Set(s.selection);

    // Дорожки
    for (const [i, r] of rows.entries()) {
      ctx.fillStyle = i % 2 ? '#222226' : '#25252a';
      ctx.fillRect(HEADER_W, r.y, w - HEADER_W, r.h);
      ctx.fillStyle = '#121214';
      ctx.fillRect(HEADER_W, r.y + r.h - 1, w - HEADER_W, 1);
    }

    // In/Out
    if (s.marks.in !== null || s.marks.out !== null) {
      const a = this.frameToX(s.marks.in ?? 0);
      const b = this.frameToX(s.marks.out ?? timelineEnd(tl));
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(a, RULER_H, b - a, hgt - RULER_H);
    }

    // Клипы
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, RULER_H, w - HEADER_W, hgt - RULER_H);
    ctx.clip();
    for (const r of rows) for (const c of r.track.clips) this.drawClip(c, r, selection.has(c.id));
    ctx.restore();

    // Заголовки дорожек
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, RULER_H, HEADER_W, hgt - RULER_H);
    for (const r of rows) {
      ctx.fillStyle = r.track.kind === 'video' ? '#2f3b4a' : '#2d4236';
      ctx.fillRect(0, r.y, HEADER_W - 1, r.h - 1);
      ctx.fillStyle = '#e4e4e8';
      ctx.font = '600 12px system-ui';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(trackName(tl, r.track.id), 10, r.y + r.h / 2);
    }
    ctx.fillStyle = '#111';
    ctx.fillRect(HEADER_W - 1, RULER_H, 1, hgt);

    this.drawRuler(w);

    // Привязка и место вставки
    if (this.snapLine !== null) this.vline(this.frameToX(this.snapLine), '#f5d547', hgt);
    if (this.dropFrame !== null) this.vline(this.frameToX(this.dropFrame), '#f0883e', hgt);

    // Плейхед
    const px = this.frameToX(s.playhead);
    if (px >= HEADER_W - 1) {
      this.vline(px, '#e8433a', hgt);
      ctx.fillStyle = '#e8433a';
      ctx.beginPath();
      ctx.moveTo(px - 6, RULER_H - 10);
      ctx.lineTo(px + 6, RULER_H - 10);
      ctx.lineTo(px, RULER_H);
      ctx.fill();
    }
  }

  private vline(x: number, color: string, hgt: number): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x) - 0.5, RULER_H - 10, 1.5, hgt);
  }

  private drawClip(c: Clip, r: Row, selected: boolean): void {
    const ctx = this.ctx;
    const x = this.frameToX(c.start);
    const w = Math.max(1, c.length * this.pxPerFrame);
    if (x > this.width() || x + w < HEADER_W) return;
    const y = r.y + 2;
    const hh = r.h - 5;
    const video = r.track.kind === 'video';
    const asset = findAsset(this.editor.project, c.assetId);
    const online = this.state.media.get(c.assetId) === 'online';
    ctx.fillStyle = !online ? '#6b2a2a' : video ? (selected ? '#4a76ab' : '#355a86') : selected ? '#3f8a63' : '#2f6a4c';
    roundRect(ctx, x, y, w, hh, 3);
    ctx.fill();
    // Метка связанности и ручки подрезки при наведении
    const hov = this.hover?.kind === 'clip' && this.hover.clip.id === c.id ? this.hover : null;
    if (hov?.edge) {
      ctx.fillStyle = '#f0883e';
      ctx.fillRect(hov.edge === 'start' ? x : x + w - 3, y, 3, hh);
    }
    if (selected) {
      ctx.strokeStyle = '#f0883e';
      ctx.lineWidth = 1.5;
      roundRect(ctx, x + 0.75, y + 0.75, w - 1.5, hh - 1.5, 3);
      ctx.stroke();
    }
    if (w > 30) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, y, w - 8, hh);
      ctx.clip();
      ctx.fillStyle = '#f2f2f5';
      ctx.font = '11px system-ui';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText((online ? '' : '⚠ ') + (asset?.name ?? '?'), x + 6, y + 4);
      if (!video) {
        // Условная «волна» — настоящая форма волны будет позже.
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(x, y + hh * 0.65);
        ctx.lineTo(x + w, y + hh * 0.65);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawRuler(w: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, RULER_H - 1, w, 1);
    const rate = this.editor.rate;
    const fps = fpsValue(rate);
    const nominal = Math.ceil(fps - 1e-9);
    const steps = [1, 2, 5, 10, nominal, nominal * 2, nominal * 5, nominal * 10, nominal * 30, nominal * 60, nominal * 120, nominal * 300, nominal * 600];
    const step = steps.find((st) => st * this.pxPerFrame >= 90) ?? steps[steps.length - 1]!;
    const minor = step / (step >= nominal ? 5 : step >= 5 ? 5 : step);
    const first = Math.floor(this.scrollX / minor) * minor;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let f = first; this.frameToX(f) < w; f += minor) {
      const x = Math.round(this.frameToX(f)) + 0.5;
      if (x < HEADER_W) continue;
      const major = Math.round(f) % step === 0;
      ctx.fillStyle = major ? '#8b8b92' : '#55555c';
      ctx.fillRect(x, major ? 12 : 18, 1, major ? RULER_H - 13 : RULER_H - 19);
      if (major) {
        ctx.fillStyle = '#a5a5ad';
        ctx.fillText(formatTimecode(Math.round(f), rate), x + 3, 2);
      }
    }
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, 0, HEADER_W, RULER_H);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
}
