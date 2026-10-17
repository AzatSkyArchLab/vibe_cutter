import type { Editor } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import { TITLE_TEMPLATES, type TitleTemplate, defaultTitle } from '../domain/title';
import { drawTitle } from '../engine/title-render';
import { h } from './dom';

export const TITLE_MIME = 'application/x-vibe-title';

/** Библиотека титров (как Effects → Titles в Resolve): щелчок — под плейхед, перетаскивание — в нужное место. */
export class TitlesLibrary {
  readonly el: HTMLElement;

  constructor(editor: Editor, playback: PlaybackController) {
    const items = TITLE_TEMPLATES.map(({ template, label, hint }) => {
      const preview = h('canvas', { width: 320, height: 180, class: 'title-thumb' });
      drawPreview(preview, template);
      return h(
        'div',
        {
          class: 'title-item',
          draggable: true,
          title: `${hint}\nЩелчок — добавить под плейхед, или перетащите на таймлайн`,
          onclick: () => (playback.stop(), editor.addTitle(template)),
          ondragstart: (e: DragEvent) => {
            e.dataTransfer!.setData(TITLE_MIME, template);
            e.dataTransfer!.effectAllowed = 'copy';
          },
        },
        preview,
        h('div', {}, h('div', { class: 'name' }, label), h('div', { class: 'meta' }, hint)),
      );
    });
    this.el = h('div', { class: 'pool-list' }, ...items);
  }
}

function drawPreview(canvas: HTMLCanvasElement, template: TitleTemplate): void {
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, '#3b4a5e');
  g.addColorStop(1, '#5e4636');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const t = defaultTitle(template);
  drawTitle(ctx, canvas.width, canvas.height, template === 'center' ? { ...t, size: 14 } : t, 1);
}
