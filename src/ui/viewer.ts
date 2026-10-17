import type { Editor, EditorState } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import { formatTimecode } from '../domain/time';
import { timelineEnd } from '../domain/timeline';
import { h, setText } from './dom';

/** Вьюер таймлайна с транспортом (как Timeline Viewer в Resolve). */
export class Viewer {
  readonly el: HTMLElement;
  private readonly tc: HTMLElement;
  private readonly dur: HTMLElement;
  private readonly info: HTMLElement;
  private readonly playBtn: HTMLButtonElement;

  constructor(
    private readonly editor: Editor,
    private readonly playback: PlaybackController,
    canvas: HTMLCanvasElement,
  ) {
    canvas.title = 'Щелчок или пробел — воспроизведение';
    canvas.addEventListener('click', () => playback.toggle());
    this.tc = h('div', { class: 'tc' });
    this.dur = h('div', { class: 'tc dim' });
    this.info = h('div', { class: 'viewer-info' });
    const btn = (label: string, title: string, fn: () => void) => h('button', { title, onclick: fn }, label);
    this.playBtn = btn('▶', 'Воспроизведение (Пробел)', () => playback.toggle());
    this.el = h(
      'div',
      { class: 'viewer' },
      h('div', { class: 'viewer-screen' }, this.info, canvas),
      h(
        'div',
        { class: 'transport' },
        this.tc,
        h(
          'div',
          { class: 'buttons' },
          btn('⏮', 'В начало (Home)', () => (playback.stop(), editor.setPlayhead(0))),
          btn('◀︎|', 'Кадр назад (←)', () => (playback.stop(), editor.stepPlayhead(-1))),
          this.playBtn,
          btn('|▶︎', 'Кадр вперёд (→)', () => (playback.stop(), editor.stepPlayhead(1))),
          btn('⏭', 'В конец (End)', () => (playback.stop(), editor.setPlayhead(timelineEnd(editor.timeline)))),
        ),
        this.dur,
      ),
    );
    editor.subscribe((s) => this.update(s));
    playback.onChange((p) => setText(this.playBtn, p ? '❚❚' : '▶'));
    this.update(editor.state);
  }

  private update(s: EditorState): void {
    const rate = s.project.timeline.frameRate;
    setText(this.tc, formatTimecode(s.playhead, rate));
    setText(this.dur, formatTimecode(timelineEnd(s.project.timeline), rate));
    const { width, height } = s.project.settings;
    const marks = s.marks.in !== null || s.marks.out !== null
      ? ` · In ${s.marks.in !== null ? formatTimecode(s.marks.in, rate) : '—'} Out ${s.marks.out !== null ? formatTimecode(s.marks.out - 1, rate) : '—'}`
      : '';
    setText(this.info, `${width}×${height}${marks}`);
  }
}
