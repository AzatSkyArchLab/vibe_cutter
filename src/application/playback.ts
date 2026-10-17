import type { Editor, EditorState } from './editor';
import type { PreviewEngine } from './ports';

/**
 * Связывает редактор с вьюером: показывает кадр под плейхедом и управляет
 * воспроизведением. Любое изменение проекта останавливает воспроизведение —
 * план проигрывания строится один раз на старте и не должен устаревать.
 */
export class PlaybackController {
  private last: { project: EditorState['project']; playhead: number; media: EditorState['media'] } | null = null;
  private listeners = new Set<(playing: boolean) => void>();

  constructor(
    private readonly editor: Editor,
    private readonly preview: PreviewEngine,
  ) {
    editor.subscribe((s) => this.onState(s));
  }

  get playing(): boolean {
    return this.preview.playing;
  }

  onChange(fn: (playing: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.preview.playing);
  }

  private onState(s: EditorState): void {
    const prev = this.last;
    this.last = { project: s.project, playhead: s.playhead, media: s.media };
    if (this.preview.playing) {
      if (prev && (prev.project !== s.project || prev.media !== s.media)) this.stop();
      return;
    }
    if (!prev || prev.project !== s.project || prev.playhead !== s.playhead || prev.media !== s.media) this.refresh();
  }

  refresh(): void {
    if (!this.preview.playing) this.preview.showFrame(this.editor.project, this.editor.state.playhead, this.editor.onlineFiles());
  }

  play(): void {
    if (this.preview.playing) return;
    this.preview.play(
      this.editor.project,
      this.editor.state.playhead,
      this.editor.onlineFiles(),
      (frame) => this.editor.setPlayhead(frame),
      (err) => {
        if (err) this.editor.notify('error', `Воспроизведение остановлено: ${err.message}`);
        this.emit();
        this.refresh();
      },
    );
    this.emit();
  }

  stop(): void {
    if (!this.preview.playing) return;
    this.preview.stop();
    this.emit();
    this.refresh();
  }

  toggle(): void {
    this.preview.playing ? this.stop() : this.play();
  }
}
