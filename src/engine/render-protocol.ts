import type { AssetId } from '../domain/media';
import type { OutputSettings } from '../domain/export-preset';
import type { RenderPlan } from '../domain/render-plan';
import type { CompressResult, EncodeSupport, RemuxResult, RenderProgress, RenderStats, RenderTarget } from '../application/ports';
import type { CompressPlan } from '../domain/compress';
import type { MediaAsset } from '../domain/media';

export type ToWorker =
  | { type: 'check'; id: number; settings: OutputSettings }
  | { type: 'render'; id: number; plan: RenderPlan; files: [AssetId, File][]; destination: RenderTarget }
  | { type: 'compress'; id: number; source: MediaAsset; file: File; plan: CompressPlan; destination: RenderTarget }
  | { type: 'remux'; id: number; file: File; destination: RenderTarget }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'checked'; id: number; support: EncodeSupport }
  | { type: 'progress'; id: number; progress: RenderProgress; pass?: number }
  | { type: 'fraction'; id: number; fraction: number }
  | { type: 'compressed'; id: number; result: CompressResult | RemuxResult; blob: Blob | null }
  | { type: 'done'; id: number; stats: RenderStats; blob: Blob | null }
  | { type: 'error'; id: number; message: string; canceled: boolean };
