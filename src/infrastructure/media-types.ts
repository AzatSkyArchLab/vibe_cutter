/** Какие файлы можно импортировать. Чистые функции: проверяются тестами без браузера. */

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm'] as const;
// AIFF не поддерживает разборщик Mediabunny, поэтому его нет в списке.
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'wave', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus'] as const;

export type MediaKind = 'video' | 'audio';

const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';

/** Вид файла по типу MIME или расширению; null, если файл не медиа. */
export function mediaKind(name: string, mime: string): MediaKind | null {
  const e = ext(name);
  if (mime.startsWith('video/') || (VIDEO_EXTENSIONS as readonly string[]).includes(e)) return 'video';
  if ((mime.startsWith('audio/') && !/aiff/.test(mime)) || (AUDIO_EXTENSIONS as readonly string[]).includes(e)) return 'audio';
  return null;
}

/** Можно ли импортировать файл: `video` только видео (сжатие), `media` видео и звук (монтаж). */
export const accepts = (what: 'video' | 'media', name: string, mime: string): boolean => {
  const kind = mediaKind(name, mime);
  return what === 'video' ? kind === 'video' : kind !== null;
};

/** Типы для диалога выбора файлов. */
export function pickerTypes(what: 'video' | 'media'): FilePickerAcceptType[] {
  const video: FilePickerAcceptType = {
    description: 'Видео',
    accept: { 'video/mp4': ['.mp4', '.m4v'], 'video/quicktime': ['.mov'], 'video/webm': ['.webm'], 'video/x-matroska': ['.mkv'] },
  };
  const audio: FilePickerAcceptType = {
    description: 'Звук',
    accept: {
      'audio/mpeg': ['.mp3'],
      'audio/wav': ['.wav', '.wave'],
      'audio/mp4': ['.m4a'],
      'audio/aac': ['.aac'],
      'audio/flac': ['.flac'],
      'audio/ogg': ['.ogg', '.oga', '.opus'],
    },
  };
  return what === 'video' ? [video] : [video, audio];
}

/** Строка для <input accept>. */
export const inputAccept = (what: 'video' | 'media'): string =>
  [
    'video/*',
    ...VIDEO_EXTENSIONS.map((e) => `.${e}`),
    ...(what === 'media' ? ['audio/*', ...AUDIO_EXTENSIONS.map((e) => `.${e}`)] : []),
  ].join(',');
