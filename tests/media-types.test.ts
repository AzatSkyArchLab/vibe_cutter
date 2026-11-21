import { describe, expect, it } from 'vitest';
import { accepts, inputAccept, mediaKind } from '../src/infrastructure/media-types';

describe('какие файлы можно импортировать', () => {
  it('звук по расширению и по типу', () => {
    for (const name of ['song.mp3', 'VOICE.WAV', 'a.m4a', 'b.aac', 'c.flac', 'd.ogg', 'e.opus'])
      expect(mediaKind(name, '')).toBe('audio');
    expect(mediaKind('без_расширения', 'audio/mpeg')).toBe('audio');
  });

  it('видео по расширению и по типу', () => {
    for (const name of ['clip.MOV', 'a.mp4', 'b.m4v', 'c.mkv', 'd.webm']) expect(mediaKind(name, '')).toBe('video');
    expect(mediaKind('x', 'video/quicktime')).toBe('video');
  });

  it('прочее не импортируется', () => {
    expect(mediaKind('project.vcut', '')).toBeNull();
    expect(mediaKind('photo.jpg', 'image/jpeg')).toBeNull();
    // AIFF не читает разборщик: не принимаем, чтобы не было ошибки после импорта.
    expect(mediaKind('glass.aiff', 'audio/aiff')).toBeNull();
  });

  it('монтаж принимает видео и звук, сжатие только видео', () => {
    expect(accepts('media', 'song.mp3', 'audio/mpeg')).toBe(true);
    expect(accepts('media', 'clip.mov', '')).toBe(true);
    expect(accepts('video', 'song.mp3', 'audio/mpeg')).toBe(false);
    expect(accepts('video', 'clip.mov', '')).toBe(true);
    expect(inputAccept('media')).toContain('.mp3');
    expect(inputAccept('video')).not.toContain('audio');
  });
});
