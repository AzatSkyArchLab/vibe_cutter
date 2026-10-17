import type { Editor, EditorState } from '../application/editor';
import type { PlaybackController } from '../application/playback';
import type { ProjectFileRef } from '../application/ports';
import { ask } from './dialog';
import { h, setText } from './dom';
import { mod } from './format';

/**
 * Меню «Проект» и статус сохранения. Все действия, которые могут
 * заменить текущий монтаж, сначала предлагают сохранить изменения.
 */
export class ProjectMenu {
  readonly button: HTMLButtonElement;
  readonly status: HTMLButtonElement;
  private readonly menu: HTMLDivElement;

  constructor(
    private readonly editor: Editor,
    private readonly playback: PlaybackController,
  ) {
    this.menu = h('div', { class: 'menu' });
    this.button = h('button', { class: 'menu-button', onclick: (e: Event) => (e.stopPropagation(), void this.toggle()) }, 'Проект ▾');
    this.status = h('button', { class: 'save-state', onclick: () => void this.save() });
    document.addEventListener('click', () => this.close());
    editor.subscribe((s) => this.update(s));
    this.update(editor.state);
  }

  async save(as = false): Promise<void> {
    this.close();
    await this.editor.saveToFile({ as });
  }

  async open(): Promise<void> {
    this.close();
    if (!(await this.confirmDiscard())) return;
    this.playback.stop();
    await this.editor.openFromPicker();
  }

  async newProject(): Promise<void> {
    this.close();
    if (!(await this.confirmDiscard())) return;
    this.playback.stop();
    this.editor.newProject();
  }

  /** Проект из Finder (приложение для Mac). */
  async openExternal(text: string, ref: ProjectFileRef): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.playback.stop();
    await this.editor.openText(text, ref);
  }

  async openDropped(file: File, handle: FileSystemFileHandle | null): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.playback.stop();
    await this.editor.openDropped(file, handle);
  }

  /** true — можно заменять текущий проект. */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.editor.hasUnsavedWork()) return true;
    const answer = await ask(
      'Сохранить изменения?',
      `В проекте «${this.editor.project.name}» есть изменения, которые не сохранены в файл.`,
      [
        { label: 'Не сохранять', value: 'discard' as const },
        { label: 'Отмена', value: 'cancel' as const },
        { label: 'Сохранить', value: 'save' as const, primary: true },
      ],
      'cancel' as const,
    );
    if (answer === 'cancel') return false;
    if (answer === 'save') return this.editor.saveToFile();
    return true;
  }

  private async toggle(): Promise<void> {
    if (this.menu.isConnected) return this.close();
    const recent = await this.editor.recentProjects();
    const item = (label: string, keys: string, fn: () => void) =>
      h('button', { class: 'menu-item', onclick: (e: Event) => (e.stopPropagation(), fn()) }, h('span', {}, label), keys ? h('kbd', {}, keys) : null);
    this.menu.replaceChildren(
      item('Новый проект', '', () => void this.newProject()),
      item('Открыть…', `${mod}O`, () => void this.open()),
      item('Сохранить', `${mod}S`, () => void this.save()),
      item('Сохранить как…', `⇧${mod}S`, () => void this.save(true)),
      ...(recent.length
        ? [
            h('div', { class: 'menu-sep' }, 'Недавние'),
            ...recent.map((ref) =>
              h(
                'button',
                {
                  class: 'menu-item',
                  title: ref.name,
                  onclick: async (e: Event) => {
                    e.stopPropagation();
                    this.close();
                    if (!(await this.confirmDiscard())) return;
                    this.playback.stop();
                    await this.editor.openRecent(ref);
                  },
                },
                h('span', {}, ref.name.replace(/\.vcut$/i, '')),
              ),
            ),
          ]
        : []),
    );
    this.button.after(this.menu);
  }

  private close(): void {
    this.menu.remove();
  }

  private update(s: EditorState): void {
    const file = s.projectFile;
    const text: Record<EditorState['fileState'], string> = {
      none: `Не сохранён в файл · ${mod}S`,
      saved: `Сохранено · ${file}`,
      unsaved: `Изменён · ${file}`,
      saving: `Сохранение… · ${file}`,
      'needs-permission': `Разрешите запись · ${mod}S`,
      error: `Ошибка записи · ${mod}S — повторить`,
    };
    setText(this.status, text[s.fileState]);
    this.status.className = `save-state ${s.fileState}`;
    this.status.title =
      s.fileState === 'none'
        ? 'Сохраните проект в файл .vcut, чтобы вернуться к монтажу в любой момент'
        : s.fileState === 'needs-permission'
          ? 'После перезагрузки браузер просит подтвердить запись в файл проекта'
          : file ?? '';
    document.title = `${this.editor.hasUnsavedWork() ? '• ' : ''}${s.project.name} — vibe_cutter`;
  }
}
