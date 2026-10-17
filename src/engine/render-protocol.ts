import type { AssetId } from '../domain/media';
import type { OutputSettings } from '../domain/export-preset';
import type { RenderPlan } from '../domain/render-plan';
import type { EncodeSupport, RenderProgress, RenderStats, RenderTarget } from '../application/ports';

export type ToWorker =
  | { type: 'check'; id: number; settings: OutputSettings }
  | { type: 'render'; id: number; plan: RenderPlan; files: [AssetId, File][]; destination: RenderTarget }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'checked'; id: number; support: EncodeSupport }
  | { type: 'progress'; id: number; progress: RenderProgress }
  | { type: 'done'; id: number; stats: RenderStats; blob: Blob | null }
  | { type: 'error'; id: number; message: string; canceled: boolean };
