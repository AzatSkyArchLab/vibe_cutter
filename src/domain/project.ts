import type { AssetId, MediaAsset } from './media';
import { sanitizeTitle } from './title';
import type { Clip } from './timeline';
import { type FrameRate, fpsValue } from './time';
import { type Ids, type Timeline, emptyTimeline, validateTimeline } from './timeline';

/** Как вписывать исходник, если его пропорции не совпадают с кадром таймлайна. */
export type FitMode = 'fit' | 'fill';

export interface TimelineSettings {
  readonly width: number;
  readonly height: number;
  readonly frameRate: FrameRate;
  readonly fit: FitMode;
}

export interface Project {
  readonly version: 1;
  readonly name: string;
  readonly settings: TimelineSettings;
  readonly assets: readonly MediaAsset[];
  readonly timeline: Timeline;
}

export interface ResolutionPreset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export const RESOLUTIONS: readonly ResolutionPreset[] = [
  { label: '1080p · 16:9', width: 1920, height: 1080 },
  { label: '4K · 16:9', width: 3840, height: 2160 },
  { label: '1080p · 9:16', width: 1080, height: 1920 },
  { label: '4K · 9:16', width: 2160, height: 3840 },
];

export const orientation = (s: Pick<TimelineSettings, 'width' | 'height'>): 'horizontal' | 'vertical' =>
  s.width >= s.height ? 'horizontal' : 'vertical';

export function newProject(name: string, settings: TimelineSettings, ids: Ids): Project {
  return { version: 1, name, settings, assets: [], timeline: emptyTimeline(settings.frameRate, ids) };
}

export const findAsset = (p: Project, id: AssetId): MediaAsset | undefined => p.assets.find((a) => a.id === id);

export const isTimelineEmpty = (p: Project): boolean => p.timeline.tracks.every((t) => t.clips.length === 0);

/**
 * Частоту кадров можно менять только на пустом таймлайне: позиции клипов
 * хранятся в кадрах, и смена частоты сдвинула бы все резы (в Resolve так же).
 */
export function changeSettings(p: Project, settings: TimelineSettings): Project {
  const rateChanged = fpsValue(settings.frameRate) !== fpsValue(p.settings.frameRate);
  if (rateChanged && !isTimelineEmpty(p)) throw new Error('Частоту кадров можно менять только на пустом таймлайне');
  return { ...p, settings, timeline: rateChanged ? { ...p.timeline, frameRate: settings.frameRate } : p.timeline };
}

export const serializeProject = (p: Project): string => JSON.stringify(p);

/** Расширение файла проекта на диске. */
export const PROJECT_EXT = '.vcut';
const FILE_FORMAT = 'vibe_cutter-project';

/**
 * Файл проекта: монтаж, настройки и описание исходников (имя, размер,
 * параметры). Само видео в файл не входит — как .drp в Resolve.
 * Поле format отличает наш файл от случайного JSON.
 */
export function serializeProjectFile(p: Project, savedAt = Date.now()): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, savedAt: new Date(savedAt).toISOString(), project: p }, null, 1);
}

/** Читает файл проекта (а также сырой проект из автосохранения) с полной проверкой. */
export function parseProjectFile(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не похож на проект vibe_cutter');
  }
  const wrapped = data as { format?: string; version?: number; project?: unknown };
  if (wrapped?.format === FILE_FORMAT) {
    if (wrapped.version !== 1) throw new Error('Проект сохранён более новой версией vibe_cutter');
    return validateProject(wrapped.project);
  }
  return validateProject(data);
}

export const parseProject = (json: string): Project => parseProjectFile(json);

function validateProject(data: unknown): Project {
  const p = data as Project;
  if (p?.version !== 1 || !p.timeline || !Array.isArray(p.timeline.tracks) || !Array.isArray(p.assets) || !p.settings)
    throw new Error('Файл не похож на проект vibe_cutter');
  const errors = validateTimeline(p.timeline);
  if (errors.length) throw new Error(`Проект повреждён: ${errors.slice(0, 3).join('; ')}`);
  const known = new Set(p.assets.map((a) => a.id));
  for (const t of p.timeline.tracks)
    for (const c of t.clips) if (c.assetId !== null && !known.has(c.assetId)) throw new Error('Проект повреждён: клип ссылается на неизвестный файл');
  // Оформление титров из файла приводим к допустимым значениям.
  return {
    ...p,
    timeline: {
      ...p.timeline,
      tracks: p.timeline.tracks.map((t) => ({ ...t, clips: t.clips.map((c: Clip): Clip => (c.title ? { ...c, title: sanitizeTitle(c.title) } : c)) })),
    },
  };
}

/** Имя проекта по имени файла: «Влог 12.vcut» → «Влог 12». */
export const nameFromFile = (fileName: string): string => fileName.replace(/\.vcut$/i, '').trim() || 'Без названия';
