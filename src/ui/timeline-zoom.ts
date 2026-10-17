/**
 * Математика масштаба таймлайна (без DOM — тестируется отдельно).
 * Масштаб — пикселей на кадр, прокрутка — номер кадра у левого края дорожек.
 */
export interface Viewport {
  readonly pxPerFrame: number;
  readonly scrollX: number;
}

export interface ZoomLimits {
  readonly min: number;
  readonly max: number;
  /** Ширина колонки заголовков дорожек слева. */
  readonly headerW: number;
}

/** Во сколько раз меняется масштаб за один щелчок колеса мыши. */
const STEP_PER_NOTCH = 1.25;
/** Типичная величина deltaY одного щелчка колеса в пикселях. */
const PX_PER_NOTCH = 100;

/**
 * Коэффициент масштаба для события колеса. Учитывает единицы прокрутки
 * (пиксели, строки, страницы): колесо мыши даёт ровный шаг ≈25% за щелчок,
 * щипок на трекпаде (мелкие deltaY с ctrlKey) — плавное изменение.
 * > 1 — приблизить (колесо от себя), < 1 — отдалить.
 */
export function wheelZoomFactor(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): number {
  // С зажатым Shift некоторые системы отдают прокрутку в deltaX — берём преобладающую.
  const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  const px = e.deltaMode === 1 ? raw * 33 : e.deltaMode === 2 ? raw * PX_PER_NOTCH * 3 : raw;
  // Не больше двух щелчков за одно событие — быстрые колёса и «инерция» не дают скачков.
  const notches = Math.max(-2, Math.min(2, px / PX_PER_NOTCH));
  return Math.pow(STEP_PER_NOTCH, -notches);
}

/**
 * Масштаб вокруг точки: кадр под anchorX остаётся под anchorX.
 * Над колонкой заголовков опорой служит левый край дорожек.
 * Слева от нулевого кадра прокрутить нельзя — у самого начала таймлайна
 * опорная точка может сместиться ровно на эту величину.
 */
export function zoomAt(v: Viewport, factor: number, anchorX: number, limits: ZoomLimits): Viewport {
  const x = Math.max(limits.headerW, anchorX);
  const anchorFrame = v.scrollX + (x - limits.headerW) / v.pxPerFrame;
  const pxPerFrame = Math.max(limits.min, Math.min(limits.max, v.pxPerFrame * factor));
  const scrollX = Math.max(0, anchorFrame - (x - limits.headerW) / pxPerFrame);
  return { pxPerFrame, scrollX };
}

/** Кадр (дробный) под координатой x. */
export const frameAtX = (v: Viewport, x: number, headerW: number): number => v.scrollX + (x - headerW) / v.pxPerFrame;
