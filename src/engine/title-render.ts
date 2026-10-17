import { TITLE_FONTS, type TitleStyle } from '../domain/title';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Рисует титр в кадр w×h. Одна функция для вьюера и рендера, поэтому
 * в файле надпись ровно такая же, как на экране.
 *
 * Все размеры считаются от короткой стороны кадра: в вертикальном
 * 1080×1920 текст того же размера, что в горизонтальном 1920×1080.
 */
export function drawTitle(ctx: Ctx, w: number, h: number, t: TitleStyle, opacity: number): void {
  if (opacity <= 0 || (!t.text.trim() && !t.subtitle.trim())) return;
  const unit = Math.min(w, h);
  const px = (t.size / 100) * unit;
  const subPx = px * 0.62;
  const lineH = 1.18;
  const family = TITLE_FONTS.find((f) => f.font === t.font)?.css ?? TITLE_FONTS[0]!.css;
  const mainFont = `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${px}px ${family}`;
  const subFont = `${t.italic ? 'italic ' : ''}400 ${subPx}px ${family}`;
  const lower = t.template !== 'center';
  const hasSub = lower && t.subtitle.trim() !== '';

  // Ширина строки для переноса.
  const maxW = w * (t.template === 'lower-left' ? 0.7 : 0.86);
  ctx.save();
  ctx.font = mainFont;
  const main = wrap(ctx, t.text, maxW);
  ctx.font = subFont;
  const sub = hasSub ? wrap(ctx, t.subtitle, maxW) : [];

  const blockW = Math.max(...measure(ctx, main, mainFont), ...measure(ctx, sub, subFont), 0);
  const mainH = main.length * px * lineH;
  const gap = hasSub && main.length ? px * 0.18 : 0;
  const blockH = mainH + gap + sub.length * subPx * lineH;

  // Позиция блока по шаблону + сдвиг пользователя.
  const dx = (t.offsetX / 100) * w;
  const dy = (t.offsetY / 100) * h;
  const barW = t.background === 'bar' ? Math.max(2, px * 0.12) : 0;
  const barGap = barW ? px * 0.4 : 0;
  let left: number;
  let align: CanvasTextAlign;
  let top: number;
  if (t.template === 'center') {
    left = w / 2 - blockW / 2 + dx;
    top = h / 2 - blockH / 2 + dy;
    align = 'center';
  } else if (t.template === 'lower-left') {
    left = unit * 0.07 + barW + barGap + dx;
    top = h - unit * 0.1 - blockH + dy;
    align = 'left';
  } else {
    left = w / 2 - blockW / 2 + dx;
    top = h - unit * 0.09 - blockH + dy;
    align = 'center';
  }

  ctx.globalAlpha = opacity;

  // Подложка
  if (t.background !== 'none' && t.backgroundOpacity > 0) {
    ctx.fillStyle = withAlpha(t.backgroundColor, t.backgroundOpacity);
    if (t.background === 'box') {
      const padX = px * 0.38;
      const padY = px * 0.2;
      ctx.beginPath();
      ctx.roundRect(left - padX, top - padY, blockW + padX * 2, blockH + padY * 2, px * 0.14);
      ctx.fill();
    } else {
      ctx.fillRect(left - barGap - barW, top + px * 0.08, barW, blockH - px * 0.12);
    }
  }

  // Текст
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align;
  const x = align === 'center' ? left + blockW / 2 : left;
  let y = top;
  const lines: { text: string; font: string; size: number }[] = [
    ...main.map((text) => ({ text, font: mainFont, size: px })),
    ...sub.map((text) => ({ text, font: subFont, size: subPx })),
  ];
  lines.forEach((line, i) => {
    if (i === main.length) y += gap;
    // Базовая линия ≈ 80% высоты строки.
    const baseline = y + line.size * lineH * 0.8;
    ctx.font = line.font;
    if (t.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = line.size * 0.12;
      ctx.shadowOffsetY = line.size * 0.04;
    }
    if (t.outline > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = (t.outline / 100) * line.size * 2;
      ctx.strokeStyle = t.outlineColor;
      ctx.strokeText(line.text, x, baseline);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = i < main.length ? t.color : withAlpha(t.color, 0.85);
    ctx.fillText(line.text, x, baseline);
    ctx.shadowColor = 'transparent';
    y += line.size * lineH;
  });
  ctx.restore();
}

/** Перенос по словам; явные переносы строк сохраняются. Слишком длинное слово не режется. */
function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      if (text.includes('\n')) out.push('');
      continue;
    }
    let line = words[0]!;
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`;
      if (ctx.measureText(next).width <= maxW) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  // Пустые строки в конце не нужны.
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function measure(ctx: Ctx, lines: string[], font: string): number[] {
  ctx.font = font;
  return lines.map((l) => ctx.measureText(l).width);
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
