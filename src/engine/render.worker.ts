/// <reference lib="webworker" />
import { memoryWritable } from './memory-writable';
import { checkEncodeSupport, renderPlan } from './render';
import type { FromWorker, ToWorker } from './render-protocol';

/**
 * Рендер живёт в отдельном потоке: интерфейс не подвисает, а сбой
 * кодека или нехватка памяти не роняют вкладку с проектом.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const jobs = new Map<number, AbortController>();
const post = (m: FromWorker) => scope.postMessage(m);

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'check':
      post({ type: 'checked', id: msg.id, support: await checkEncodeSupport(msg.settings) });
      return;
    case 'cancel':
      jobs.get(msg.id)?.abort(new DOMException('Рендер отменён', 'AbortError'));
      return;
    case 'render': {
      const ctrl = new AbortController();
      jobs.set(msg.id, ctrl);
      try {
        let writable: WritableStream;
        let result: (() => Blob) | null = null;
        if (msg.destination.kind === 'file') {
          // Пишется во временный файл; на диске он появится только после успешного close().
          writable = await msg.destination.handle.createWritable({ keepExistingData: false });
        } else {
          const mem = memoryWritable();
          writable = mem.writable;
          result = mem.result;
        }
        const stats = await renderPlan(
          msg.plan,
          new Map(msg.files),
          writable,
          (progress) => post({ type: 'progress', id: msg.id, progress }),
          ctrl.signal,
        );
        post({ type: 'done', id: msg.id, stats, blob: result ? result() : null });
      } catch (err) {
        post({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
          canceled: ctrl.signal.aborted,
        });
      } finally {
        jobs.delete(msg.id);
      }
    }
  }
};
