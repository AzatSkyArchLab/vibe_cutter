import './ui/styles.css';
import { Editor } from './application/editor';
import { PlaybackController } from './application/playback';
import { probeMedia } from './engine/probe';
import { BrowserPreview } from './engine/preview';
import { WorkerRenderEngine } from './engine/render-client';
import { FsProjectFiles } from './infrastructure/file-access';
import { IdbMediaLibrary, IdbProjectRepository, IdbRecentProjects } from './infrastructure/idb';
import { mountApp } from './ui/app';
import { Viewer } from './ui/viewer';

/** Точка сборки: здесь порты приложения связываются с браузерными адаптерами. */
async function main() {
  const root = document.getElementById('app')!;
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    root.innerHTML =
      '<div style="padding:40px;font:15px system-ui;color:#ddd">vibe_cutter работает в Google Chrome (нужен WebCodecs). Откройте страницу в Chrome на Mac.</div>';
    return;
  }

  const editor = new Editor({ probe: probeMedia }, new IdbProjectRepository(), new FsProjectFiles(), new IdbMediaLibrary(), new IdbRecentProjects());
  const canvas = document.createElement('canvas');
  const preview = new BrowserPreview(canvas);
  const playback = new PlaybackController(editor, preview);
  const viewer = new Viewer(editor, playback, canvas);
  mountApp(root, editor, playback, viewer, new WorkerRenderEngine());

  await editor.restore();
  playback.refresh();

  if (import.meta.env.DEV) {
    Object.assign(window, {
      __editor: editor,
      __dev: { renderCheck: () => import('./dev/render-check').then((m) => m.runRenderCheck) },
    });
  }
}

void main();
