/**
 * Титры — клипы без исходника, как Titles в DaVinci Resolve.
 * Все размеры и отступы — в долях кадра, поэтому надпись выглядит
 * одинаково в 1080p, 4K и в вертикальном формате.
 */

export type TitleTemplate = 'center' | 'lower-left' | 'lower-center';
export type TitleFont = 'sans' | 'serif' | 'mono' | 'condensed';
export type TitleBackground = 'none' | 'box' | 'bar';

export interface TitleStyle {
  readonly template: TitleTemplate;
  /** Основной текст; переносы строк — \n. */
  readonly text: string;
  /** Вторая строка для подписей (должность, место); для центра не используется. */
  readonly subtitle: string;
  readonly font: TitleFont;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Высота основного текста, % короткой стороны кадра. */
  readonly size: number;
  readonly color: string;
  /** Тень под текстом — читаемость на светлом видео. */
  readonly shadow: boolean;
  /** Обводка, % размера шрифта (0 — нет). */
  readonly outline: number;
  readonly outlineColor: string;
  /** Подложка: плашка под текстом или цветная полоса слева (для подписи). */
  readonly background: TitleBackground;
  readonly backgroundColor: string;
  /** 0…1 */
  readonly backgroundOpacity: number;
  /** Сдвиг от позиции шаблона, % ширины/высоты кадра. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Плавное появление и исчезновение, секунды. */
  readonly fadeIn: number;
  readonly fadeOut: number;
}

export const TITLE_TEMPLATES: readonly { template: TitleTemplate; label: string; hint: string }[] = [
  { template: 'center', label: 'Текст по центру', hint: 'Заголовок поверх видео' },
  { template: 'lower-left', label: 'Подпись слева внизу', hint: 'Имя и должность — нижняя треть' },
  { template: 'lower-center', label: 'Подпись внизу по центру', hint: 'Подпись или субтитр' },
];

export const TITLE_FONTS: readonly { font: TitleFont; label: string; css: string }[] = [
  { font: 'sans', label: 'Гротеск', css: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { font: 'serif', label: 'Антиква', css: 'Georgia, "Times New Roman", serif' },
  { font: 'condensed', label: 'Узкий', css: '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", sans-serif' },
  { font: 'mono', label: 'Моноширинный', css: 'Menlo, "SF Mono", Consolas, monospace' },
];

export function defaultTitle(template: TitleTemplate): TitleStyle {
  const base: TitleStyle = {
    template,
    text: 'Заголовок',
    subtitle: '',
    font: 'sans',
    bold: true,
    italic: false,
    size: 8,
    color: '#ffffff',
    shadow: true,
    outline: 0,
    outlineColor: '#000000',
    background: 'none',
    backgroundColor: '#000000',
    backgroundOpacity: 0.6,
    offsetX: 0,
    offsetY: 0,
    fadeIn: 0.3,
    fadeOut: 0.3,
  };
  switch (template) {
    case 'center':
      return base;
    case 'lower-left':
      return { ...base, text: 'Имя Фамилия', subtitle: 'Должность', size: 5, background: 'bar', backgroundColor: '#f0883e', backgroundOpacity: 1 };
    case 'lower-center':
      return { ...base, text: 'Подпись', size: 4.5, bold: false, background: 'box', backgroundOpacity: 0.55 };
  }
}

/** Проверка значений из файла проекта: всё, что выходит за рамки, приводится к допустимому. */
export function sanitizeTitle(t: Partial<TitleStyle> | undefined): TitleStyle {
  const d = defaultTitle(t?.template && TITLE_TEMPLATES.some((x) => x.template === t.template) ? t.template : 'center');
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  const color = (v: unknown, def: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : def);
  const str = (v: unknown, def: string) => (typeof v === 'string' ? v.slice(0, 2000) : def);
  return {
    template: d.template,
    text: str(t?.text, d.text),
    subtitle: str(t?.subtitle, d.subtitle),
    font: TITLE_FONTS.some((f) => f.font === t?.font) ? t!.font! : d.font,
    bold: typeof t?.bold === 'boolean' ? t.bold : d.bold,
    italic: typeof t?.italic === 'boolean' ? t.italic : d.italic,
    size: num(t?.size, d.size, 1, 40),
    color: color(t?.color, d.color),
    shadow: typeof t?.shadow === 'boolean' ? t.shadow : d.shadow,
    outline: num(t?.outline, d.outline, 0, 20),
    outlineColor: color(t?.outlineColor, d.outlineColor),
    background: t?.background === 'none' || t?.background === 'box' || t?.background === 'bar' ? t.background : d.background,
    backgroundColor: color(t?.backgroundColor, d.backgroundColor),
    backgroundOpacity: num(t?.backgroundOpacity, d.backgroundOpacity, 0, 1),
    offsetX: num(t?.offsetX, d.offsetX, -50, 50),
    offsetY: num(t?.offsetY, d.offsetY, -50, 50),
    fadeIn: num(t?.fadeIn, d.fadeIn, 0, 10),
    fadeOut: num(t?.fadeOut, d.fadeOut, 0, 10),
  };
}

/** Непрозрачность титра в кадре `local` (от начала клипа) с учётом появления и исчезновения. */
export function titleOpacity(t: TitleStyle, local: number, length: number, fps: number): number {
  const fin = t.fadeIn * fps;
  const fout = t.fadeOut * fps;
  let a = 1;
  // +1: первый кадр появления уже чуть виден, последний кадр исчезновения — ещё чуть виден.
  if (fin > 0) a = Math.min(a, (local + 1) / (fin + 1));
  if (fout > 0) a = Math.min(a, (length - local) / (fout + 1));
  return Math.max(0, Math.min(1, a));
}

/** Короткая подпись для клипа на таймлайне. */
export const titleLabel = (t: TitleStyle): string => (t.text.split('\n')[0] || t.subtitle || 'Титр').slice(0, 60);
