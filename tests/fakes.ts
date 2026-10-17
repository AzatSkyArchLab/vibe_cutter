import { Editor } from '../src/application/editor';
import type {
  MediaHandle, MediaLibrary, MediaProber, ProjectFileRef, ProjectFiles, ProjectRepository, RecentProjects, SavedProject,
} from '../src/application/ports';
import type { MediaMetadata } from '../src/domain/media';
import { R30 } from './helpers';

/** Подставные адаптеры: всё в памяти, поведение настраивается в тесте. */
export function fakes() {
  const disk = new Map<string, string>();
  const writes: string[] = [];
  const state = { writable: true, failWrite: false, saveAs: 'Монтаж.vcut' as string | null };

  const handleFor = (name: string) => ({ name, kind: 'file' }) as unknown as FileSystemFileHandle;
  const files: ProjectFiles = {
    async pickSaveTarget() {
      return state.saveAs ? { name: state.saveAs, handle: handleFor(state.saveAs) } : null;
    },
    async pickAndRead() {
      return null;
    },
    async read(ref) {
      const t = disk.get(ref.name);
      if (t === undefined) throw new Error('нет файла');
      return t;
    },
    async write(ref, text) {
      await new Promise((r) => setTimeout(r, 5));
      if (state.failWrite) throw new Error('диск полон');
      writes.push(ref.name);
      disk.set(ref.name, text);
    },
    async permission(_ref, mode) {
      return mode === 'read' || state.writable;
    },
    inPlace(ref) {
      return ref.handle !== null;
    },
  };

  let session: SavedProject | null = null;
  const repo: ProjectRepository = {
    async load() {
      return session;
    },
    async save(s) {
      session = { ...s, savedAt: Date.now() };
    },
  };

  const lib = new Map<string, MediaHandle>();
  const library: MediaLibrary = {
    async remember(name, size, h) {
      lib.set(`${name}|${size}`, h);
    },
    async find(name, size) {
      return lib.get(`${name}|${size}`) ?? null;
    },
  };

  const recentList: ProjectFileRef[] = [];
  const recent: RecentProjects = {
    async list() {
      return recentList;
    },
    async add(ref) {
      recentList.unshift(ref);
    },
    async remove() {},
  };

  const prober: MediaProber = {
    async probe(file): Promise<MediaMetadata> {
      return {
        name: file.name,
        sizeBytes: file.size,
        startTime: 0,
        duration: 4,
        video: { codec: 'avc', width: 1920, height: 1080, frameRate: R30, variableFrameRate: false, hdr: false, decodable: true },
        audio: { codec: 'aac', sampleRate: 48000, channels: 2, decodable: true },
      };
    },
  };

  const editor = new Editor(prober, repo, files, library, recent);
  return { editor, disk, writes, state, library, lib, recentList, getSession: () => session, setSession: (s: SavedProject) => (session = s) };
}

export const video = (name: string, bytes = 1000) => new File([new Uint8Array(bytes)], name, { type: 'video/mp4' });

/** Ручка исходника с заданным разрешением на чтение. */
export const mediaHandle = (file: File, permission: PermissionState = 'granted') =>
  ({ kind: 'file', name: file.name, queryPermission: async () => permission, getFile: async () => file }) as unknown as MediaHandle;

