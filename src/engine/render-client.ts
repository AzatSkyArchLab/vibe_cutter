import type { EncodeSupport, MediaRef, RenderEngine, RenderProgress, RenderStats, RenderTarget, RenderTask } from '../application/ports';
import type { AssetId } from '../domain/media';
import type { OutputSettings } from '../domain/export-preset';
import type { RenderPlan } from '../domain/render-plan';
import type { FromWorker, ToWorker } from './render-protocol';

type Pending = {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  onProgress?: (p: RenderProgress) => void;
};

/** Реализация RenderEngine поверх Web Worker. Если воркер падает, все задачи завершаются ошибкой. */
export class WorkerRenderEngine implements RenderEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private get w(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    worker.onerror = (e) => this.crash(`Сбой процесса рендера: ${e.message || 'неизвестная ошибка'}`);
    worker.onmessageerror = () => this.crash('Сбой обмена данными с процессом рендера');
    return (this.worker = worker);
  }

  check(settings: OutputSettings): Promise<EncodeSupport> {
    return this.request<EncodeSupport>((id) => ({ type: 'check', id, settings }));
  }

  render(
    plan: RenderPlan,
    media: ReadonlyMap<AssetId, MediaRef>,
    target: RenderTarget,
    onProgress: (p: RenderProgress) => void,
  ): RenderTask {
    const id = this.nextId++;
    const done = new Promise<{ stats: RenderStats; blob: Blob | null }>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, onProgress });
    });
    const files = plan.assets.map((a): [AssetId, File] => {
      const f = media.get(a.id);
      if (!f) throw new Error(`Нет доступа к файлу «${a.name}»`);
      return [a.id, f];
    });
    this.post({ type: 'render', id, plan, files, destination: target });
    return { done, cancel: () => this.post({ type: 'cancel', id }) };
  }

  private request<T>(make: (id: number) => ToWorker): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: never) => void, reject }));
    this.post(make(id));
    return p;
  }

  private post(m: ToWorker) {
    this.w.postMessage(m);
  }

  private onMessage(m: FromWorker) {
    const p = this.pending.get(m.id);
    if (!p) return;
    switch (m.type) {
      case 'progress':
        p.onProgress?.(m.progress);
        return;
      case 'checked':
        this.pending.delete(m.id);
        p.resolve(m.support as never);
        return;
      case 'done':
        this.pending.delete(m.id);
        p.resolve({ stats: m.stats, blob: m.blob } as never);
        return;
      case 'error': {
        this.pending.delete(m.id);
        const err = new Error(m.message);
        if (m.canceled) err.name = 'AbortError';
        p.reject(err);
      }
    }
  }

  private crash(message: string) {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
