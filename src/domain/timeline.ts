import type { AssetId, MediaAsset } from './media';
import { type FrameRate, secondsToFrames } from './time';

/**
 * Таймлайн в духе страницы Edit в DaVinci Resolve: дорожки V1…Vn и A1…An,
 * у клипа абсолютная позиция, между клипами могут быть пустоты.
 * Видео и звук одного исходника связаны общим linkId и редактируются вместе.
 *
 * Все функции чистые: принимают таймлайн и возвращают новый.
 * Инвариант: клипы дорожки отсортированы по start и не перекрываются.
 */

export type TrackId = string & { readonly __brand: 'TrackId' };
export type ClipId = string & { readonly __brand: 'ClipId' };
export type LinkId = string & { readonly __brand: 'LinkId' };
export type TrackKind = 'video' | 'audio';

export interface Clip {
  readonly id: ClipId;
  readonly assetId: AssetId;
  /** Позиция на таймлайне, кадры. */
  readonly start: number;
  /** Начало в исходнике, кадры таймлайна от первого кадра файла. */
  readonly sourceIn: number;
  /** Длина, кадры (> 0). */
  readonly length: number;
  readonly linkId: LinkId | null;
}

export interface Track {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly clips: readonly Clip[];
}

export interface Timeline {
  readonly frameRate: FrameRate;
  /** Порядок внутри вида: первый видео-трек — V1 (нижний), первый аудио — A1. */
  readonly tracks: readonly Track[];
}

export interface Ids {
  clip(): ClipId;
  link(): LinkId;
  track(): TrackId;
}

/** Длина исходника в кадрах таймлайна; нужна для ограничения подрезки. */
export type AssetLength = (assetId: AssetId) => number;

export interface ClipRef {
  readonly track: Track;
  readonly trackIndex: number;
  readonly clip: Clip;
}

export class TimelineError extends Error {}

export const clipEnd = (c: Clip): number => c.start + c.length;

export function emptyTimeline(frameRate: FrameRate, ids: Ids): Timeline {
  return {
    frameRate,
    tracks: [
      { id: ids.track(), kind: 'video', clips: [] },
      { id: ids.track(), kind: 'audio', clips: [] },
    ],
  };
}

export const assetLengthInFrames = (asset: MediaAsset, rate: FrameRate): number =>
  secondsToFrames(asset.duration, rate);

export const tracksOfKind = (tl: Timeline, kind: TrackKind): Track[] => tl.tracks.filter((t) => t.kind === kind);

/** «V1», «A2» и т.п. */
export function trackName(tl: Timeline, id: TrackId): string {
  const track = tl.tracks.find((t) => t.id === id);
  if (!track) throw new TimelineError(`Нет дорожки ${id}`);
  const n = tracksOfKind(tl, track.kind).indexOf(track) + 1;
  return `${track.kind === 'video' ? 'V' : 'A'}${n}`;
}

export const timelineEnd = (tl: Timeline): number =>
  Math.max(0, ...tl.tracks.flatMap((t) => t.clips.map(clipEnd)));

export function findClip(tl: Timeline, id: ClipId): ClipRef | null {
  for (let trackIndex = 0; trackIndex < tl.tracks.length; trackIndex++) {
    const track = tl.tracks[trackIndex]!;
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, trackIndex, clip };
  }
  return null;
}

export const allClips = (tl: Timeline): ClipRef[] =>
  tl.tracks.flatMap((track, trackIndex) => track.clips.map((clip) => ({ track, trackIndex, clip })));

/** Клип дорожки, покрывающий кадр (кадр на стыке принадлежит правому клипу). */
export const clipOnTrackAt = (track: Track, frame: number): Clip | null =>
  track.clips.find((c) => frame >= c.start && frame < clipEnd(c)) ?? null;

/** Добавляет к выделению все связанные клипы (как Linked Selection в Resolve). */
export function withLinked(tl: Timeline, ids: readonly ClipId[]): ClipId[] {
  const links = new Set<LinkId>();
  for (const id of ids) {
    const link = findClip(tl, id)?.clip.linkId;
    if (link) links.add(link);
  }
  const out = new Set(ids);
  for (const { clip } of allClips(tl)) if (clip.linkId && links.has(clip.linkId)) out.add(clip.id);
  return [...out];
}

export function addTrack(tl: Timeline, kind: TrackKind, ids: Ids): Timeline {
  const track: Track = { id: ids.track(), kind, clips: [] };
  const lastOfKind = tl.tracks.map((t) => t.kind).lastIndexOf(kind);
  const tracks = [...tl.tracks];
  tracks.splice(lastOfKind + 1, 0, track);
  return { ...tl, tracks };
}

/** Удаляет пустую дорожку; последнюю дорожку вида оставляет. */
export function removeTrack(tl: Timeline, id: TrackId): Timeline {
  const track = tl.tracks.find((t) => t.id === id);
  if (!track) throw new TimelineError(`Нет дорожки ${id}`);
  if (track.clips.length > 0) throw new TimelineError('Дорожка не пустая');
  if (tracksOfKind(tl, track.kind).length === 1) throw new TimelineError('Нужна хотя бы одна дорожка этого вида');
  return { ...tl, tracks: tl.tracks.filter((t) => t.id !== id) };
}

// ── Размещение ────────────────────────────────────────────────────────────

/** Клип для размещения: на какой дорожке и откуда из исходника. */
export interface Placement {
  readonly trackId: TrackId;
  readonly assetId: AssetId;
  readonly sourceIn: number;
  readonly length: number;
  /** Клипы с одинаковой группой будут связаны между собой. */
  readonly group?: string;
}

/**
 * Перезапись (Overwrite, F10): кладёт клипы в `frame`, затирая то, что под ними.
 * Возвращает таймлайн и id созданных клипов.
 */
export function overwrite(tl: Timeline, frame: number, items: readonly Placement[], ids: Ids): EditResult {
  if (frame < 0) throw new TimelineError('Позиция меньше нуля');
  const links = new Map<string, LinkId>();
  const created: ClipId[] = [];
  let out = tl;
  for (const item of items) {
    if (item.length <= 0) throw new TimelineError('Длина клипа должна быть больше нуля');
    let linkId: LinkId | null = null;
    if (item.group !== undefined) {
      linkId = links.get(item.group) ?? ids.link();
      links.set(item.group, linkId);
    }
    const clip: Clip = {
      id: ids.clip(),
      assetId: item.assetId,
      start: frame,
      sourceIn: item.sourceIn,
      length: item.length,
      linkId,
    };
    out = mapTrack(out, item.trackId, (t) => sortedTrack(t, [...clearRange(t, frame, clipEnd(clip), ids).clips, clip]));
    created.push(clip.id);
  }
  return { timeline: out, created };
}

/**
 * Вставка (Insert, F9): раздвигает все дорожки в `frame` на длину вставки
 * и кладёт клипы в образовавшееся место. Двигаются все дорожки — так
 * синхронизация между ними не может разъехаться.
 */
export function insert(tl: Timeline, frame: number, items: readonly Placement[], ids: Ids): EditResult {
  const length = Math.max(0, ...items.map((i) => i.length));
  const opened = shiftFrom(splitAt(tl, frame, ids), frame, length);
  return overwrite(opened, frame, items, ids);
}

/** Добавить в конец таймлайна (Append at End, Shift+F12). */
export const appendAtEnd = (tl: Timeline, items: readonly Placement[], ids: Ids): EditResult =>
  overwrite(tl, timelineEnd(tl), items, ids);

export interface EditResult {
  readonly timeline: Timeline;
  readonly created: readonly ClipId[];
}

/** Видео + звук исходника как связанная пара для размещения. */
export function placementsForAsset(
  tl: Timeline,
  asset: MediaAsset,
  target: { video: TrackId | null; audio: TrackId | null },
  range?: { sourceIn: number; length: number },
): Placement[] {
  const full = assetLengthInFrames(asset, tl.frameRate);
  const sourceIn = range?.sourceIn ?? 0;
  const length = range?.length ?? full - sourceIn;
  if (length <= 0) throw new TimelineError(`«${asset.name}» короче одного кадра`);
  const out: Placement[] = [];
  const group = asset.id;
  if (asset.video && target.video) out.push({ trackId: target.video, assetId: asset.id, sourceIn, length, group });
  if (asset.audio && target.audio) out.push({ trackId: target.audio, assetId: asset.id, sourceIn, length, group });
  if (out.length === 0) throw new TimelineError(`В «${asset.name}» нет подходящих дорожек`);
  return out;
}

// ── Резы и удаление ───────────────────────────────────────────────────────

/**
 * Разрез (Ctrl/Cmd+B) в кадре `frame` на указанных дорожках (по умолчанию на всех).
 * Правые половинки связанных клипов остаются связанными между собой.
 */
export function splitAt(tl: Timeline, frame: number, ids: Ids, trackIds?: readonly TrackId[]): Timeline {
  const only = trackIds ? new Set(trackIds) : null;
  const newLinks = new Map<LinkId, LinkId>();
  const tracks = tl.tracks.map((track) => {
      if (only && !only.has(track.id)) return track;
      const hit = clipOnTrackAt(track, frame);
      if (!hit || hit.start === frame) return track;
      let rightLink: LinkId | null = null;
      if (hit.linkId) {
        rightLink = newLinks.get(hit.linkId) ?? ids.link();
        newLinks.set(hit.linkId, rightLink);
      }
      const offset = frame - hit.start;
      const left: Clip = { ...hit, length: offset };
      const right: Clip = {
        ...hit,
        id: ids.clip(),
        start: frame,
        sourceIn: hit.sourceIn + offset,
        length: hit.length - offset,
        linkId: rightLink,
      };
      return { ...track, clips: track.clips.flatMap((c) => (c === hit ? [left, right] : [c])) };
  });
  return tracks.every((t, i) => t === tl.tracks[i]) ? tl : { ...tl, tracks };
}

/** Разрезать только выбранные клипы (и связанные с ними) в кадре `frame`. */
export function splitClipsAt(tl: Timeline, frame: number, clipIds: readonly ClipId[], ids: Ids): Timeline {
  const trackIds = withLinked(tl, clipIds)
    .map((id) => findClip(tl, id))
    .filter((r): r is ClipRef => r !== null && frame > r.clip.start && frame < clipEnd(r.clip))
    .map((r) => r.track.id);
  return trackIds.length ? splitAt(tl, frame, ids, trackIds) : tl;
}

/** Удалить, оставив пустоту (Backspace). */
export function lift(tl: Timeline, clipIds: readonly ClipId[]): Timeline {
  const drop = new Set(clipIds);
  return { ...tl, tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !drop.has(c.id)) })) };
}

/**
 * Удалить со сдвигом (Shift+Backspace / Delete). Пустота закрывается на тех
 * дорожках, где были удалённые клипы; связанные клипы удаляются парой,
 * поэтому видео и звук сдвигаются одинаково.
 */
export function rippleDelete(tl: Timeline, clipIds: readonly ClipId[]): Timeline {
  const drop = new Set(clipIds);
  return {
    ...tl,
    tracks: tl.tracks.map((track) => {
      const removed = track.clips.filter((c) => drop.has(c.id));
      if (removed.length === 0) return track;
      const clips = track.clips
        .filter((c) => !drop.has(c.id))
        .map((c) => {
          const shift = removed.filter((r) => clipEnd(r) <= c.start).reduce((s, r) => s + r.length, 0);
          return shift ? { ...c, start: c.start - shift } : c;
        });
      return { ...track, clips };
    }),
  };
}

/** Вырезать диапазон [from, to) со всех дорожек со сдвигом (In/Out + Shift+Backspace). */
export function rippleDeleteRange(tl: Timeline, from: number, to: number, ids: Ids): Timeline {
  if (to <= from) return tl;
  const cut = splitAt(splitAt(tl, from, ids), to, ids);
  return {
    ...cut,
    tracks: cut.tracks.map((track) => ({
      ...track,
      clips: track.clips
        .filter((c) => !(c.start >= from && clipEnd(c) <= to))
        .map((c) => (c.start >= to ? { ...c, start: c.start - (to - from) } : c)),
    })),
  };
}

// ── Подрезка и перемещение ────────────────────────────────────────────────

/**
 * Подрезка начала клипа на `delta` кадров (положительный — укоротить).
 * Применяется ко всем связанным клипам; величина ограничивается так,
 * чтобы ни один из них не залез на соседа, не вышел за начало исходника
 * и не стал короче кадра.
 */
export function trimStart(tl: Timeline, clipId: ClipId, delta: number): Timeline {
  const group = linkedRefs(tl, clipId);
  let d = delta;
  for (const { track, clip } of group) {
    const prevEnd = Math.max(0, ...track.clips.filter((c) => clipEnd(c) <= clip.start).map(clipEnd));
    d = Math.max(d, -clip.sourceIn, prevEnd - clip.start);
    d = Math.min(d, clip.length - 1);
  }
  if (d === 0) return tl;
  return updateClips(tl, group, (c) => ({ ...c, start: c.start + d, sourceIn: c.sourceIn + d, length: c.length - d }));
}

/** Подрезка конца клипа на `delta` кадров (положительный — удлинить). */
export function trimEnd(tl: Timeline, clipId: ClipId, delta: number, assetLength: AssetLength): Timeline {
  const group = linkedRefs(tl, clipId);
  let d = delta;
  for (const { track, clip } of group) {
    const nextStart = Math.min(Infinity, ...track.clips.filter((c) => c.start >= clipEnd(clip)).map((c) => c.start));
    d = Math.min(d, nextStart - clipEnd(clip), assetLength(clip.assetId) - clip.sourceIn - clip.length);
    d = Math.max(d, 1 - clip.length);
  }
  if (d === 0) return tl;
  return updateClips(tl, group, (c) => ({ ...c, length: c.length + d }));
}

/**
 * Перемещение клипов (со связанными) на `delta` кадров и, опционально,
 * на `trackDelta` дорожек того же вида. На новом месте клипы затирают то,
 * что под ними, как при перетаскивании в Resolve.
 */
export function moveClips(
  tl: Timeline,
  clipIds: readonly ClipId[],
  delta: number,
  ids: Ids,
  trackDelta: Partial<Record<TrackKind, number>> = {},
): Timeline {
  const refs = withLinked(tl, clipIds)
    .map((id) => findClip(tl, id))
    .filter((r): r is ClipRef => r !== null);
  if (refs.length === 0) return tl;
  const d = Math.max(delta, -Math.min(...refs.map((r) => r.clip.start)));

  const moved = refs.map((r) => {
    const sameKind = tracksOfKind(tl, r.track.kind);
    const shift = trackDelta[r.track.kind] ?? 0;
    const to = sameKind[Math.max(0, Math.min(sameKind.length - 1, sameKind.indexOf(r.track) + shift))]!;
    return { trackId: to.id, clip: { ...r.clip, start: r.clip.start + d } };
  });
  if (d === 0 && moved.every((m, i) => m.trackId === refs[i]!.track.id)) return tl;

  let out = lift(tl, refs.map((r) => r.clip.id));
  for (const m of moved) {
    out = mapTrack(out, m.trackId, (t) =>
      sortedTrack(t, [...clearRange(t, m.clip.start, clipEnd(m.clip), ids).clips, m.clip]),
    );
  }
  return out;
}

// ── Внутреннее ────────────────────────────────────────────────────────────

/** Освобождает [from, to) на дорожке: клипы обрезаются, разрезаются или удаляются. */
function clearRange(track: Track, from: number, to: number, ids: Ids): Track {
  const clips: Clip[] = [];
  for (const c of track.clips) {
    const end = clipEnd(c);
    if (end <= from || c.start >= to) {
      clips.push(c);
      continue;
    }
    if (c.start < from) clips.push({ ...c, length: from - c.start });
    if (end > to) {
      const cut = to - c.start;
      // Хвост — новый клип; связь с парой теряется, как в Resolve при затирании.
      clips.push({ ...c, id: c.start < from ? ids.clip() : c.id, start: to, sourceIn: c.sourceIn + cut, length: end - to, linkId: c.start < from ? null : c.linkId });
    }
  }
  return { ...track, clips };
}

/** Сдвигает вправо всё, что начинается в `frame` и позже, на всех дорожках. */
function shiftFrom(tl: Timeline, frame: number, by: number): Timeline {
  if (by === 0) return tl;
  return {
    ...tl,
    tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.start >= frame ? { ...c, start: c.start + by } : c)) })),
  };
}

function linkedRefs(tl: Timeline, clipId: ClipId): ClipRef[] {
  if (!findClip(tl, clipId)) throw new TimelineError(`Нет клипа ${clipId}`);
  return withLinked(tl, [clipId]).map((id) => findClip(tl, id)!);
}

function updateClips(tl: Timeline, refs: readonly ClipRef[], fn: (c: Clip) => Clip): Timeline {
  const targets = new Set(refs.map((r) => r.clip.id));
  return {
    ...tl,
    tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (targets.has(c.id) ? fn(c) : c)) })),
  };
}

function mapTrack(tl: Timeline, id: TrackId, fn: (t: Track) => Track): Timeline {
  if (!tl.tracks.some((t) => t.id === id)) throw new TimelineError(`Нет дорожки ${id}`);
  return { ...tl, tracks: tl.tracks.map((t) => (t.id === id ? fn(t) : t)) };
}

const sortedTrack = (t: Track, clips: Clip[]): Track => ({ ...t, clips: clips.sort((a, b) => a.start - b.start) });

/** Проверка инварианта; используется в тестах и при загрузке проекта. */
export function validateTimeline(tl: Timeline): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const t of tl.tracks) {
    let prevEnd = 0;
    for (const c of t.clips) {
      if (seen.has(c.id)) errors.push(`повтор id ${c.id}`);
      seen.add(c.id);
      if (!Number.isInteger(c.start) || !Number.isInteger(c.length) || !Number.isInteger(c.sourceIn))
        errors.push(`${c.id}: нецелые кадры`);
      if (c.length <= 0) errors.push(`${c.id}: длина ${c.length}`);
      if (c.start < 0 || c.sourceIn < 0) errors.push(`${c.id}: отрицательная позиция`);
      if (c.start < prevEnd) errors.push(`${c.id}: перекрытие на дорожке ${t.id}`);
      prevEnd = clipEnd(c);
    }
  }
  return errors;
}
