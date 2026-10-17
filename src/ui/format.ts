export function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
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
