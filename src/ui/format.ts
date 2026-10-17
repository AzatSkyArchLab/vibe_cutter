/** Размер в десятичных единицах — так же, как показывает Finder на Mac. */
export function formatBytes(n: number): string {
  if (n < 1e6) return `${Math.round(n / 1e3)} КБ`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\.?0+$/, '')} МБ`;
  return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')} ГБ`;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

export function formatFps(num: number, den: number): string {
  const v = num / den;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = isMac ? '⌘' : 'Ctrl+';
