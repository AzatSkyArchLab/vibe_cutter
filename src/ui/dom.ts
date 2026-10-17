type Child = Node | string | null | undefined | false;

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Обозначения клавиш пишутся по-маковски (⌘S, ⇧⌘Z, ⌥X); на Windows и Linux
 * они превращаются в Ctrl+S, Ctrl+Shift+Z, Alt+X. Применяется ко всему тексту
 * и подсказкам, созданным через h().
 */
export function keys(s: string): string {
  if (MAC || !/[⌘⇧⌥]/.test(s)) return s;
  return s
    .replace(/⇧⌘/g, 'Ctrl+Shift+')
    .replace(/⌥⌘/g, 'Ctrl+Alt+')
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌥/g, 'Alt+');
}
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Минимальный помощник для создания элементов. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'title' && typeof v === 'string') el.title = keys(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? keys(c) : c);
  return el;
}

export function setText(el: Element, text: string): void {
  const t = keys(text);
  if (el.textContent !== t) el.textContent = t;
}
