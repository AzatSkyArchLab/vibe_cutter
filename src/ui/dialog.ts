import { h } from './dom';

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

/** Модальный вопрос. Esc и щелчок мимо окна возвращают cancelValue. */
export function ask<T>(title: string, text: string, buttons: DialogButton<T>[], cancelValue: T): Promise<T> {
  return new Promise((resolve) => {
    const close = (v: T) => {
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(cancelValue);
      }
    };
    const box = h(
      'div',
      { class: 'dialog', onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'dialog-title' }, title),
      h('div', { class: 'dialog-text' }, text),
      h('div', { class: 'dialog-buttons' }, ...buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => close(b.value) }, b.label))),
    );
    const overlay = h('div', { class: 'dialog-overlay', onclick: () => close(cancelValue) }, box);
    document.body.append(overlay);
    window.addEventListener('keydown', onKey, true);
    (box.querySelector('button.primary') as HTMLButtonElement | null)?.focus();
  });
}
