import { h } from './dom';

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  action: () => void;
}

let open: HTMLElement | null = null;

/** Контекстное меню в точке (clientX, clientY). Закрывается щелчком мимо, Esc или прокруткой. */
export function showContextMenu(x: number, y: number, items: (MenuItem | 'separator')[]): void {
  closeContextMenu();
  const menu = h(
    'div',
    { class: 'menu ctx-menu', oncontextmenu: (e: Event) => e.preventDefault() },
    ...items.map((it) =>
      it === 'separator'
        ? h('div', { class: 'menu-line' })
        : h(
            'button',
            {
              class: `menu-item${it.danger ? ' danger' : ''}`,
              disabled: it.disabled,
              title: it.hint,
              onclick: (e: Event) => {
                e.stopPropagation();
                closeContextMenu();
                it.action();
              },
            },
            h('span', {}, it.label),
          ),
    ),
  );
  document.body.append(menu);
  // Не даём меню вылезти за край окна.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  open = menu;
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
  });
}

export function closeContextMenu(): void {
  open?.remove();
  open = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeContextMenu);
}

function onOutside(e: Event): void {
  if (open && !open.contains(e.target as Node)) closeContextMenu();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeContextMenu();
  }
}
