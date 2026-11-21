import type { Editor } from '../application/editor';
import { type AudioFx, FADE_CURVES, GAIN_MAX_DB, GAIN_MIN_DB, NO_FX, REVERB_PRESETS, type ReverbPreset } from '../domain/audio-fx';
import type { ClipId } from '../domain/timeline';
import { h, setText } from './dom';

/**
 * Инспектор звукового клипа (как Inspector → Audio и Fairlight FX в Resolve):
 * громкость, «телефон», реверберация. Строится один раз на клип; при обновлении
 * состояния меняются только значения, поэтому ползунок не теряет захват.
 */
export class AudioInspector {
  readonly el: HTMLElement;
  private readonly body: HTMLDivElement;
  private readonly title: HTMLElement;
  private clipId: ClipId | null = null;
  private sync: ((fx: AudioFx) => void)[] = [];

  constructor(private readonly editor: Editor) {
    this.title = h('span', {});
    this.body = h('div', { class: 'inspector-body' });
    this.el = h('div', { class: 'inspector' }, h('div', { class: 'panel-head' }, this.title), this.body);
    editor.subscribe(() => this.update());
    this.update();
  }

  get visible(): boolean {
    return this.clipId !== null;
  }

  private update(): void {
    const sel = this.editor.selectedAudioClip();
    if (!sel) {
      this.clipId = null;
      this.body.replaceChildren();
      return;
    }
    if (sel.id !== this.clipId) this.build(sel.id);
    setText(this.title, `Инспектор · Звук${sel.name ? ` · ${sel.name}` : ''}`);
    for (const f of this.sync) f(sel.fx);
  }

  private build(id: ClipId): void {
    this.clipId = id;
    this.sync = [];
    const set = (patch: Partial<AudioFx>) => this.editor.updateAudioFx(id, patch);
    const current = () => this.editor.selectedAudioClip()?.fx ?? NO_FX;
    const active = (el: Element) => document.activeElement === el;

    const range = (min: number, max: number, step: number, get: (fx: AudioFx) => number, put: (v: number) => void, fmt: (v: number) => string) => {
      const out = h('span', { class: 'range-value' });
      const input = h('input', { type: 'range', min, max, step, oninput: () => put(Number(input.value)) });
      this.sync.push((fx) => {
        if (!active(input)) input.value = String(get(fx));
        out.textContent = fmt(get(fx));
      });
      return h('div', { class: 'range' }, input, out);
    };
    const row = (label: string, ...controls: HTMLElement[]) =>
      // div, не label: щелчок по подписи не должен нажимать первую кнопку строки.
      h('div', { class: 'field' }, h('span', {}, label), h('div', { class: 'field-controls' }, ...controls));
    const toggle = (label: string, isOn: (fx: AudioFx) => boolean, flip: () => void) => {
      const b = h('button', { class: 'toggle', onclick: (e: Event) => (e.preventDefault(), flip()) }, label);
      this.sync.push((fx) => {
        b.classList.toggle('on', isOn(fx));
        setText(b, isOn(fx) ? 'Вкл' : 'Выкл');
      });
      return b;
    };

    // Громкость
    const gain = range(GAIN_MIN_DB, GAIN_MAX_DB, 0.5, (fx) => fx.gainDb, (v) => set({ gainDb: v }), (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} дБ`);
    const gainReset = h('button', { class: 'toggle', title: 'Вернуть 0 дБ', onclick: (e: Event) => (e.preventDefault(), set({ gainDb: 0 })) }, '0');

    // Телефон
    const phoneRow = row('Сила', range(0.05, 1, 0.05, (fx) => fx.phone, (v) => set({ phone: v }), (v) => `${Math.round(v * 100)}%`));
    const phoneToggle = toggle('Выкл', (fx) => fx.phone > 0, () => set({ phone: current().phone > 0 ? 0 : 1 }));
    this.sync.push((fx) => (phoneRow.style.display = fx.phone > 0 ? '' : 'none'));

    // Реверберация
    const presets = h(
      'div',
      { class: 'seg' },
      ...REVERB_PRESETS.map((p) =>
        h('button', { 'data-preset': p.preset, onclick: (e: Event) => (e.preventDefault(), set({ reverb: { preset: p.preset, mix: current().reverb?.mix || 0.3 } })) }, p.label),
      ),
    );
    this.sync.push((fx) => {
      for (const b of presets.querySelectorAll('button')) b.classList.toggle('on', b.dataset.preset === fx.reverb?.preset);
    });
    const reverbToggle = toggle('Выкл', (fx) => !!fx.reverb && fx.reverb.mix > 0, () =>
      set({ reverb: current().reverb && current().reverb!.mix > 0 ? null : { preset: (current().reverb?.preset ?? 'room') as ReverbPreset, mix: 0.3 } }),
    );
    const reverbRows = h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:6px' },
      row('Помещение', presets),
      row('Смесь', range(0.05, 1, 0.05, (fx) => fx.reverb?.mix ?? 0, (v) => set({ reverb: { preset: current().reverb?.preset ?? 'room', mix: v } }), (v) => `${Math.round(v * 100)}%`)),
      h('div', { class: 'spec' }, 'Хвост реверберации звучит и после конца клипа.'),
    );
    this.sync.push((fx) => (reverbRows.style.display = fx.reverb && fx.reverb.mix > 0 ? '' : 'none'));

    // Появление и затухание: то же, что ручки на клипе, но числами.
    const fadeControls = (secKey: 'fadeIn' | 'fadeOut', curveKey: 'fadeInCurve' | 'fadeOutCurve') => {
      const num = h('input', {
        type: 'number',
        min: 0,
        step: 0.1,
        class: 'num',
        onchange: () => {
          const v = Number(num.value);
          if (v >= 0) set({ [secKey]: v } as Partial<AudioFx>);
        },
      });
      const curve = h(
        'select',
        { onchange: () => set({ [curveKey]: curve.value } as Partial<AudioFx>) },
        ...FADE_CURVES.map((c) => h('option', { value: c.curve }, c.label)),
      );
      this.sync.push((fx) => {
        if (!active(num)) num.value = fx[secKey] ? String(Math.round(fx[secKey] * 100) / 100) : '0';
        if (!active(curve)) curve.value = fx[curveKey];
      });
      return [num, h('span', { class: 'spec' }, 'с'), curve];
    };

    this.body.replaceChildren(
      h('section', {}, row('Громкость', gain, gainReset)),
      h(
        'section',
        {},
        row('Появление', ...fadeControls('fadeIn', 'fadeInCurve')),
        row('Затухание', ...fadeControls('fadeOut', 'fadeOutCurve')),
        h('div', { class: 'spec' }, 'Или тяните ручки в верхних углах клипа и линию громкости на нём.'),
      ),
      h('section', {}, row('Телефон', phoneToggle, h('span', { class: 'spec' }, 'голос из трубки')), phoneRow),
      h('section', {}, row('Реверберация', reverbToggle), reverbRows),
      h('section', {}, h('button', { class: 'reset', onclick: () => set(NO_FX) }, 'Сбросить эффекты')),
    );
  }
}
