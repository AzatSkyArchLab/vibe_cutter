import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseProjectFile, serializeProjectFile } from '../src/domain/project';
import { fakes, mediaHandle, video } from './fakes';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('файл проекта', () => {
  it('пустой проект не считается несохранённой работой', () => {
    const { editor } = fakes();
    expect(editor.hasUnsavedWork()).toBe(false);
    expect(editor.state.fileState).toBe('none');
  });

  it('⌘S сохраняет в новый файл, проект получает имя файла', async () => {
    const { editor, disk } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    editor.appendAsset(id);
    expect(editor.hasUnsavedWork()).toBe(true);

    expect(await editor.saveToFile()).toBe(true);
    expect(editor.state.projectFile).toBe('Монтаж.vcut');
    expect(editor.state.fileState).toBe('saved');
    expect(editor.hasUnsavedWork()).toBe(false);
    const saved = parseProjectFile(disk.get('Монтаж.vcut')!);
    expect(saved.name).toBe('Монтаж');
    expect(saved.timeline.tracks[0]!.clips).toHaveLength(1);
  });

  it('отмена диалога ничего не сохраняет', async () => {
    const { editor, disk, state } = fakes();
    await editor.importFiles([{ file: video('a.mp4') }]);
    state.saveAs = null;
    expect(await editor.saveToFile()).toBe(false);
    expect(disk.size).toBe(0);
    expect(editor.state.fileState).toBe('none');
  });

  it('после сохранения изменения автоматически пишутся в тот же файл', async () => {
    const { editor, disk } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    await editor.saveToFile();
    editor.appendAsset(id);
    expect(editor.state.fileState).toBe('unsaved');
    await editor.saveNow();
    expect(editor.state.fileState).toBe('saved');
    expect(parseProjectFile(disk.get('Монтаж.vcut')!).timeline.tracks[0]!.clips).toHaveLength(1);
  });

  it('без разрешения на запись файл не трогается, состояние — нужен ⌘S', async () => {
    const { editor, disk, state } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    await editor.saveToFile();
    const before = disk.get('Монтаж.vcut');
    state.writable = false;
    editor.appendAsset(id);
    await editor.saveNow();
    expect(editor.state.fileState).toBe('needs-permission');
    expect(disk.get('Монтаж.vcut')).toBe(before);
    expect(editor.hasUnsavedWork()).toBe(true);
  });

  it('ошибка записи не теряет изменения: состояние error, следующее сохранение повторяет запись', async () => {
    const { editor, disk, state } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    await editor.saveToFile();
    state.failWrite = true;
    editor.appendAsset(id);
    await editor.saveNow();
    expect(editor.state.fileState).toBe('error');
    expect(editor.hasUnsavedWork()).toBe(true);
    state.failWrite = false;
    await editor.saveNow();
    expect(editor.state.fileState).toBe('saved');
    expect(parseProjectFile(disk.get('Монтаж.vcut')!).timeline.tracks[0]!.clips).toHaveLength(1);
  });

  it('записи идут по очереди и последней на диске оказывается последняя версия', async () => {
    const { editor, disk, writes } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    await editor.saveToFile();
    editor.appendAsset(id);
    const first = editor.saveNow();
    editor.appendAsset(id);
    const second = editor.saveNow();
    await Promise.all([first, second]);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(parseProjectFile(disk.get('Монтаж.vcut')!).timeline.tracks[0]!.clips).toHaveLength(2);
    expect(editor.state.fileState).toBe('saved');
  });

  it('открытие находит исходники по имени и размеру; файл другого размера не подключается', async () => {
    const src = fakes();
    const a = video('a.mp4', 1000);
    const b = video('b.mp4', 2000);
    const [ia, ib] = await src.editor.importFiles([{ file: a }, { file: b }]);
    src.editor.appendAsset(ia);
    src.editor.appendAsset(ib);
    await src.editor.saveToFile();
    const text = src.disk.get('Монтаж.vcut')!;

    const dst = fakes();
    await dst.library.remember('a.mp4', 1000, mediaHandle(a));
    await dst.library.remember('b.mp4', 2000, mediaHandle(video('b.mp4', 1999)));
    dst.disk.set('Монтаж.vcut', text);
    const ok = await dst.editor.openRecent({ name: 'Монтаж.vcut', handle: {} as FileSystemFileHandle });
    expect(ok).toBe(true);
    expect([...dst.editor.state.media.values()]).toEqual(['online', 'offline']);
    expect(dst.editor.hasUnsavedWork()).toBe(false);
    expect(dst.editor.state.canUndo).toBe(false);
    expect(dst.recentList[0]?.name).toBe('Монтаж.vcut');

    // «Указать папку»: подключаются только недостающие исходники проекта.
    const linked = await dst.editor.relinkFiles([{ file: b }, { file: video('чужой.mp4') }]);
    expect(linked).toBe(1);
    expect([...dst.editor.state.media.values()]).toEqual(['online', 'online']);
    expect(dst.editor.project.assets).toHaveLength(2);
  });

  it('битый файл не открывается и не трогает текущий проект', async () => {
    const { editor, disk } = fakes();
    await editor.importFiles([{ file: video('a.mp4') }]);
    disk.set('x.vcut', '{"format":"vibe_cutter-project","version":1,"project":{"version":1}}');
    expect(await editor.openRecent({ name: 'x.vcut', handle: {} as FileSystemFileHandle })).toBe(false);
    expect(editor.project.assets).toHaveLength(1);
  });

  it('восстановление сессии помнит файл и несохранённые изменения', async () => {
    const one = fakes();
    const [id] = await one.editor.importFiles([{ file: video('a.mp4') }]);
    await one.editor.saveToFile();
    one.state.writable = false;
    one.editor.appendAsset(id);
    await one.editor.saveNow();

    const two = fakes();
    two.setSession(one.getSession()!);
    await two.editor.restore();
    expect(two.editor.state.projectFile).toBe('Монтаж.vcut');
    expect(two.editor.state.fileState).toBe('unsaved');
    expect(two.editor.timeline.tracks[0]!.clips).toHaveLength(1);
  });

  it('вкладка без изменений не затирает автосохранение другой вкладки', async () => {
    const one = fakes();
    await one.editor.importFiles([{ file: video('a.mp4') }]);
    await one.editor.saveNow();
    // Вторая вкладка открыла ту же сессию и ничего не меняла…
    const two = fakes();
    two.setSession(one.getSession()!);
    await two.editor.restore();
    // …а в первой тем временем продолжили монтаж.
    one.editor.appendAsset(one.editor.project.assets[0]!.id);
    await one.editor.saveNow();
    const fresh = one.getSession()!;
    two.setSession(fresh);
    await two.editor.saveNow(); // вторую вкладку закрывают
    expect(two.getSession()).toBe(fresh);
    // А если во второй вкладке правили — её версия сохраняется.
    two.editor.rename('Другое имя');
    await two.editor.saveNow();
    expect(two.getSession()!.project.name).toBe('Другое имя');
  });

  it('новый проект отвязывается от файла', async () => {
    const { editor } = fakes();
    await editor.importFiles([{ file: video('a.mp4') }]);
    await editor.saveToFile();
    editor.newProject();
    expect(editor.state.projectFile).toBeNull();
    expect(editor.project.assets).toHaveLength(0);
  });
});

describe('формат файла', () => {
  it('сохраняется и читается без потерь', async () => {
    const { editor } = fakes();
    const [id] = await editor.importFiles([{ file: video('a.mp4') }]);
    editor.appendAsset(id);
    const p = editor.project;
    expect(parseProjectFile(serializeProjectFile(p))).toEqual(p);
  });

  it('чужой JSON и файл новой версии отклоняются понятной ошибкой', () => {
    expect(() => parseProjectFile('{"hello":1}')).toThrow(/не похож/);
    expect(() => parseProjectFile('не json')).toThrow(/не похож/);
    expect(() => parseProjectFile('{"format":"vibe_cutter-project","version":2,"project":{}}')).toThrow(/более новой версией/);
  });
});
