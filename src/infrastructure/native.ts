import type { ProjectFileRef, ProjectFiles } from '../application/ports';

/** Мост приложения для Mac (Electron, см. electron/preload.cjs). В браузере — undefined. */
export interface VibeNative {
  info(): Promise<{ version: string; platform: string }>;
  saveProjectDialog(suggestedName: string): Promise<string | null>;
  openProjectDialog(): Promise<{ path: string; name: string; text: string } | null>;
  readProject(path: string): Promise<string>;
  writeProject(path: string, text: string): Promise<void>;
  projectExists(path: string): Promise<boolean>;
  checkUpdates(): Promise<void>;
  onOpenProject(cb: (p: { path: string; name: string; text: string }) => void): void;
  onMenu(cb: (action: string) => void): void;
  ready(): void;
}

export const native: VibeNative | undefined = (window as unknown as { vibeNative?: VibeNative }).vibeNative;

const baseName = (p: string) => p.split('/').pop() ?? p;

/**
 * Файлы проекта в приложении для Mac: обычные диалоги macOS и запись по пути.
 * Разрешений браузера не нужно — после перезапуска проект пишется сразу.
 */
export class NativeProjectFiles implements ProjectFiles {
  constructor(private readonly n: VibeNative) {}

  async pickSaveTarget(suggestedName: string): Promise<ProjectFileRef | null> {
    const path = await this.n.saveProjectDialog(suggestedName);
    return path ? { name: baseName(path), handle: null, path } : null;
  }

  async pickAndRead(): Promise<{ ref: ProjectFileRef; text: string } | null> {
    const r = await this.n.openProjectDialog();
    return r ? { ref: { name: r.name, handle: null, path: r.path }, text: r.text } : null;
  }

  read(ref: ProjectFileRef): Promise<string> {
    if (!ref.path) return Promise.reject(new Error('Файл недоступен'));
    return this.n.readProject(ref.path);
  }

  write(ref: ProjectFileRef, text: string): Promise<void> {
    if (!ref.path) return Promise.reject(new Error('Не выбран файл проекта'));
    return this.n.writeProject(ref.path, text);
  }

  /** Разрешений у приложения не бывает: доступ есть, если известен путь (отсутствие файла выяснится при чтении). */
  async permission(ref: ProjectFileRef): Promise<boolean> {
    return !!ref.path;
  }

  inPlace(ref: ProjectFileRef): boolean {
    return !!ref.path;
  }
}
