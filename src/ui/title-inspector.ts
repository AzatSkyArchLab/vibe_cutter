import type { Editor, EditorState } from '../application/editor';
import { TITLE_FONTS, TITLE_TEMPLATES, type TitleStyle } from '../domain/title';
import { findClip, trimEnd } from '../domain/timeline';
import { fpsValue } from '../domain/time';
import { h } from './dom';

type Field = { el: HTMLElement; sync: (t: TitleStyle) => void };

/**
 * Инспектор титра (как Inspector → Title в Resolve). Строится один раз на
 * выделенный клип; при изменениях состояния обновляются только поля,
 * которые сейчас не редактируются, — фокус и курсор не сбиваются.
 */
export class TitleInspector {
  readonly el: HTMLElement;
  private readonly body: HTMLDivElement;
  private clipId: string | null = null;
  private fields: Field[] = [];
  private durationInput: HTMLInputElement | null = null;
  private lowerOnly: HTMLElement[] = [];

  constructor(private readonly editor: Editor) {
    this.body = h('div', { class: 'inspector-body' });
    this.el = h('div', { class: 'inspector' }, h('div', { class: 'panel-head' }, 'Инспектор · Титр'), this.body);
    editor.subscribe((s) => this.update(s));
    this.update(editor.state);
  }

  get visible(): boolean {
    return this.clipId !== null;
  }

  private update(_s: EditorState): void {
    const sel = this.editor.selectedTitle();
    if (!sel) {
      this.clipId = null;
      this.body.replaceChildren();
      return;
    }
    if (sel.id !== this.clipId) this.build(sel.id);
    for (const f of this.fields) f.sync(sel.title);
    for (const el of this.lowerOnly) el.style.display = sel.title.template === 'center' ? 'none' : '';
    const clip = findClip(this.editor.timeline, sel.id)?.clip;
    if (clip && this.durationInput && document.activeElement !== this.durationInput)
      this.durationInput.value = (clip.length / fpsValue(this.editor.rate)).toFixed(1);
  }

  private build(id: string): void {
    this.clipId = id;
    this.fields = [];
    this.lowerOnly = [];
    const set = (patch: Partial<TitleStyle>) => this.editor.updateTitle(id as never, patch);
    const focused = (el: Element) => document.activeElement === el;

    const select = <K extends keyof TitleStyle>(key: K, options: [string, string][]): Field => {
      const el = h('select', { onchange: () => set({ [key]: el.value } as Partial<TitleStyle>) }, ...options.map(([v, l]) => h('option', { value: v }, l)));
      return { el, sync: (t) => !focused(el) && (el.value = String(t[key])) };
    };
    const text = (key: 'text' | 'subtitle', multiline: boolean): Field => {
      const el = multiline
        ? h('textarea', { rows: 3, spellcheck: true, oninput: () => set({ [key]: el.value }) })
        : h('input', { type: 'text', spellcheck: true, oninput: () => set({ [key]: (el as HTMLInputElement).value }) });
      return { el, sync: (t) => !focused(el) && ((el as HTMLInputElement).value = t[key]) };
    };
    const range = (key: keyof TitleStyle, min: number, max: number, step: number, unit = ''): Field => {
      const out = h('span', { class: 'range-value' });
      const el = h('input', { type: 'range', min, max, step, oninput: () => set({ [key]: Number(el.value) } as Partial<TitleStyle>) });
      return {
        el: h('div', { class: 'range' }, el, out),
        sync: (t) => {
          if (!focused(el)) el.value = String(t[key]);
          out.textContent = `${Number(t[key]).toFixed(step < 1 ? 1 : 0)}${unit}`;
        },
      };
    };
    const color = (key: 'color' | 'outlineColor' | 'backgroundColor'): Field => {
      const el = h('input', { type: 'color', oninput: () => set({ [key]: el.value }) });
      return { el, sync: (t) => !focused(el) && (el.value = t[key]) };
    };
    const toggle = (key: 'bold' | 'italic' | 'shadow', label: string): Field => {
      const el = h('button', { class: 'toggle', onclick: () => set({ [key]: !el.classList.contains('on') }) }, label);
      return { el, sync: (t) => el.classList.toggle('on', t[key]) };
    };
    const row = (label: string, ...fields: Field[]) => {
      this.fields.push(...fields);
      return h('label', { class: 'field' }, h('span', {}, label), h('div', { class: 'field-controls' }, ...fields.map((f) => f.el)));
    };

    const subtitleRow = row('Вторая строка', text('subtitle', false));
    this.lowerOnly.push(subtitleRow);

    this.durationInput = h('input', {
      type: 'number',
      min: 0.1,
      step: 0.1,
      class: 'num',
      onchange: () => {
        const ref = findClip(this.editor.timeline, id as never);
        const sec = Number(this.durationInput!.value);
        if (!ref || !(sec > 0)) return;
        const frames = Math.max(1, Math.round(sec * fpsValue(this.editor.rate)));
        this.editor.applyTimeline(trimEnd(this.editor.timeline, ref.clip.id, frames - ref.clip.length, this.editor.assetLength));
      },
    });

    this.body.replaceChildren(
      h('section', {}, row('Шаблон', select('template', TITLE_TEMPLATES.map((t) => [t.template, t.label]))), row('Текст', text('text', true)), subtitleRow),
      h(
        'section',
        {},
        row('Шрифт', select('font', TITLE_FONTS.map((f) => [f.font, f.label])), toggle('bold', 'Ж'), toggle('italic', 'К')),
        row('Размер', range('size', 1, 20, 0.5, '%')),
        row('Цвет', color('color'), toggle('shadow', 'Тень')),
        row('Обводка', range('outline', 0, 15, 1, '%'), color('outlineColor')),
      ),
      h(
        'section',
        {},
        row('Подложка', select('background', [['none', 'Нет'], ['box', 'Плашка'], ['bar', 'Полоса слева']]), color('backgroundColor')),
        row('Прозрачность', range('backgroundOpacity', 0, 1, 0.05)),
      ),
      h(
        'section',
        {},
        row('Сдвиг X', range('offsetX', -50, 50, 0.5, '%')),
        row('Сдвиг Y', range('offsetY', -50, 50, 0.5, '%')),
        h('button', { class: 'reset', onclick: () => set({ offsetX: 0, offsetY: 0 }) }, 'Вернуть на место'),
      ),
      h(
        'section',
        {},
        h('label', { class: 'field' }, h('span', {}, 'Длительность, с'), h('div', { class: 'field-controls' }, this.durationInput)),
        row('Появление', range('fadeIn', 0, 3, 0.1, ' с')),
        row('Исчезновение', range('fadeOut', 0, 3, 0.1, ' с')),
      ),
    );
  }
}
