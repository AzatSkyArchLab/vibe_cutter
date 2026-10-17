import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakes, video } from './fakes';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

async function withVideo() {
  const f = fakes();
  const [id] = await f.editor.importFiles([{ file: video('a.mp4') }]);
  f.editor.appendAsset(id); // 4 с = 120 кадров на V1/A1
  f.editor.setPlayhead(30);
  return f;
}

describe('титры в редакторе', () => {
  it('над видео титр встаёт на новую V2 под плейхедом, длиной 5 секунд, и выделяется', async () => {
    const { editor } = await withVideo();
    editor.addTitle('center');
    const video = editor.timeline.tracks.filter((t) => t.kind === 'video');
    expect(video).toHaveLength(2);
    const t = video[1]!.clips[0]!;
    expect([t.start, t.length, t.assetId, t.title?.template]).toEqual([30, 150, null, 'center']);
    expect(editor.state.selection).toEqual([t.id]);
    expect(editor.selectedTitle()?.id).toBe(t.id);
  });

  it('второй титр в то же место не затирает первый — идёт на V3', async () => {
    const { editor } = await withVideo();
    editor.addTitle('center');
    editor.addTitle('lower-left');
    const video = editor.timeline.tracks.filter((t) => t.kind === 'video');
    expect(video.map((t) => t.clips.length)).toEqual([1, 1, 1]);
  });

  it('на пустом таймлайне титр встаёт на V1', () => {
    const { editor } = fakes();
    editor.addTitle('lower-center');
    expect(editor.timeline.tracks[0]!.clips[0]!.title?.template).toBe('lower-center');
    expect(editor.timeline.tracks.filter((t) => t.kind === 'video')).toHaveLength(1);
  });

  it('набор текста подряд — один шаг отмены; отмена возвращает исходный текст', async () => {
    const { editor } = await withVideo();
    editor.addTitle('center');
    const id = editor.selectedTitle()!.id;
    for (const text of ['П', 'Пр', 'При', 'Прив', 'Привет']) editor.updateTitle(id, { text });
    expect(editor.selectedTitle()!.title.text).toBe('Привет');
    editor.undo();
    expect(editor.selectedTitle()!.title.text).toBe('Заголовок');
    editor.undo(); // убирает сам титр
    expect(editor.timeline.tracks.flatMap((t) => t.clips).some((c) => c.title)).toBe(false);
  });

  it('правки разных титров — разные шаги отмены', async () => {
    const { editor } = await withVideo();
    editor.addTitle('center');
    const a = editor.selectedTitle()!.id;
    editor.addTitle('lower-left');
    const b = editor.selectedTitle()!.id;
    editor.updateTitle(a, { text: 'A' });
    editor.updateTitle(b, { text: 'B' });
    editor.undo();
    const titles = editor.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.title);
    expect(titles.map((c) => c.title!.text).sort()).toEqual(['A', 'Имя Фамилия']);
  });

  it('недопустимые значения из инспектора приводятся к допустимым', async () => {
    const { editor } = await withVideo();
    editor.addTitle('center');
    const id = editor.selectedTitle()!.id;
    editor.updateTitle(id, { size: -5, color: 'blue' });
    expect(editor.selectedTitle()!.title.size).toBe(1);
    expect(editor.selectedTitle()!.title.color).toBe('#ffffff');
  });

  it('титр сохраняется в файл проекта', async () => {
    const { editor, disk } = await withVideo();
    editor.addTitle('lower-left');
    editor.updateTitle(editor.selectedTitle()!.id, { text: 'Иван Петров', subtitle: 'Оператор' });
    await editor.saveToFile();
    const saved = JSON.parse(disk.get('Монтаж.vcut')!);
    const title = saved.project.timeline.tracks.flatMap((t: { clips: { title?: { text: string; subtitle: string } }[] }) => t.clips).find((c: { title?: unknown }) => c.title).title;
    expect([title.text, title.subtitle]).toEqual(['Иван Петров', 'Оператор']);
  });
});
