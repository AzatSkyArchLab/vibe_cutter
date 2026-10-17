import type { Editor } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import { fpsValue } from '../domain/time';
import { timelineEnd } from '../domain/timeline';
import type { TimelineView } from './timeline-view';

/** Сочетание клавиш → действие. Раскладка повторяет DaVinci Resolve (macOS). */
export interface Shortcut {
  keys: string;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Пробел / K / L', label: 'Пуск / стоп / пуск' },
  { keys: '← →', label: 'Кадр назад / вперёд (⇧ — секунда)' },
  { keys: '↑ ↓', label: 'Предыдущая / следующая точка монтажа' },
  { keys: 'I / O / ⌥X', label: 'In / Out / сбросить' },
  { keys: 'A / B', label: 'Выделение / лезвие' },
  { keys: '⌘B', label: 'Разрезать под плейхедом' },
  { keys: '⌫', label: 'Удалить, оставив пустоту' },
  { keys: '⇧⌫ / Del', label: 'Удалить со сдвигом' },
  { keys: 'F9 / F10 / ⇧F12', label: 'Вставка / перезапись / в конец' },
  { keys: 'N', label: 'Привязка' },
  { keys: '⌘= / ⌘- / ⇧Z', label: 'Масштаб / по размеру' },
  { keys: '⌘Z / ⇧⌘Z', label: 'Отменить / вернуть' },
  { keys: '⌘S / ⇧⌘S / ⌘O', label: 'Сохранить / сохранить как / открыть проект' },
];

export function installShortcuts(
  editor: Editor,
  playback: PlaybackController,
  timeline: TimelineView,
  extra: { importMedia: () => void; save: (as: boolean) => void; open: () => void },
): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const cmd = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const code = e.code;
    const fps = Math.round(fpsValue(editor.rate));
    const editing = (fn: () => void) => () => (playback.stop(), fn());

    const action = ((): (() => void) | null => {
      if (cmd) {
        if (code === 'KeyZ') return e.shiftKey ? editing(() => editor.redo()) : editing(() => editor.undo());
        if (code === 'KeyB' || code === 'Backslash') return editing(() => editor.splitAtPlayhead());
        if (code === 'KeyL' && e.shiftKey) return () => editor.toggleLinkedSelection();
        if (code === 'Equal') return () => timeline.zoomBy(1.5);
        if (code === 'Minus') return () => timeline.zoomBy(1 / 1.5);
        if (code === 'KeyI') return extra.importMedia;
        if (code === 'KeyS') return () => extra.save(e.shiftKey);
        if (code === 'KeyO') return extra.open;
        return null;
      }
      if (e.altKey && code === 'KeyX') return () => editor.clearMarks();
      switch (key) {
        case ' ':
          return () => playback.toggle();
        case 'k':
          return () => playback.stop();
        case 'l':
          return () => playback.play();
        case 'ArrowLeft':
          return editing(() => editor.stepPlayhead(e.shiftKey ? -fps : -1));
        case 'ArrowRight':
          return editing(() => editor.stepPlayhead(e.shiftKey ? fps : 1));
        case 'ArrowUp':
          return editing(() => editor.jumpToEdit(-1));
        case 'ArrowDown':
          return editing(() => editor.jumpToEdit(1));
        case 'Home':
          return editing(() => editor.setPlayhead(0));
        case 'End':
          return editing(() => editor.setPlayhead(timelineEnd(editor.timeline)));
        case 'i':
          return () => editor.markIn();
        case 'o':
          return () => editor.markOut();
        case 'a':
          return () => editor.setTool('select');
        case 'b':
          return () => editor.setTool('blade');
        case 'n':
          return () => editor.toggleSnapping();
        case 'z':
          return e.shiftKey ? () => timeline.zoomToFit() : null;
        case 'Backspace':
          return editing(() => editor.deleteSelection(e.shiftKey));
        case 'Delete':
          return editing(() => editor.deleteSelection(true));
        case 'Escape':
          return () => editor.select([]);
        case 'F9':
          return editing(() => editor.insertAsset());
        case 'F10':
          return editing(() => editor.overwriteAsset());
        case 'F12':
          return e.shiftKey ? editing(() => editor.appendAsset()) : null;
      }
      return null;
    })();
    if (action) {
      e.preventDefault();
      action();
    }
  });
}
