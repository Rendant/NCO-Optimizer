import type { ReactorStats, BlockInfo, SourcePlan, FuelDef, ReactorType, LayoutJSON } from '@ncopt/engine';

export interface CoolerMeta { id: string; block: number; cooling: number; rule: string; coolant?: string }
export interface Meta {
  fuels: FuelDef[];
  moderators: { id: string; name: string; fluxFactor: number; efficiency: number }[];
  reflectors: { id: string; name: string; efficiency: number; reflectivity: number }[];
  sources: { id: string; name: string; efficiency: number }[];
  sfrCoolants: { id: string; name: string; heatPerMB: number }[];
  sinks: CoolerMeta[];
  heaters: CoolerMeta[];
  maxWorkers: number;
}

export interface OptimizeRequest {
  reactor: ReactorType; dims: [number, number, number]; fuelId: string; sfrCoolant?: string;
  /** multi-fuel: candidate fuels (fuelIds[0] = fuelId) */
  fuelIds?: string[];
  /** multi-fuel: every fuel must be used */
  requireAllFuels?: boolean;
  objective: 'output' | 'efficiency' | 'balanced' | 'breeding';
  allowedModerators: string[]; allowedReflectors: string[]; allowedCoolers: string[]; allowConductors: boolean;
  maxFuel?: number | ''; minEfficiency?: number | ''; symmetry: { x: boolean; y: boolean; z: boolean };
  timeLimitSec: number; workers: number; seed?: number | ''; initial?: number[];
  /** share the best layout between worker threads */
  cooperate?: boolean;
  /** seed from / save to the server-side result library */
  useLibrary?: boolean;
}

export interface WorkerState { seed: number; phase: string; evaluations: number; elapsedMs: number; bestFitness: number; bestValid: boolean; effectiveHeating: number; meanEfficiency: number; error?: string;
  /** [elapsedMs, effective heating of the best valid layout (0 = none yet), valid] */
  history?: [number, number, number][] }
export interface JobResult { id: string; seed: number; grid: number[]; stats: ReactorStats; fitness: number; valid: boolean }
export interface JobSnapshot {
  id: string; status: 'running' | 'done' | 'cancelled' | 'error'; cfg: any; createdAt: number; workers: WorkerState[]; totalEvaluations: number;
  best: { grid: number[]; stats: ReactorStats; fitness: number; valid: boolean } | null; results?: JobResult[];
  options?: { cooperate: boolean; useLibrary: boolean }; librarySeeds?: number; libraryAdded?: number;
}

export interface LibraryEntry {
  id: string; key: string; grid: number[]; fitness: number; effectiveHeating: number; meanEfficiency: number; fuelComponents: number; fuelPerHour?: number;
  stable: boolean; createdAt: number; jobId?: string; compatible?: boolean;
}

export interface SimDetail { stats: ReactorStats; blocks: BlockInfo[]; sourcePlan: SourcePlan; layout: LayoutJSON }

async function json<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as any).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  meta: () => fetch('/api/meta').then((r) => json<Meta>(r)),
  simulate: (b: { reactor: ReactorType; dims: [number, number, number]; fuelId: string; fuelIds?: string[]; sfrCoolant?: string; grid: number[]; sourceType?: string }) =>
    fetch('/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => json<SimDetail>(r)),
  optimize: (b: OptimizeRequest) =>
    fetch('/api/optimize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => json<{ jobId: string; workers: number }>(r)),
  libraryQuery: (b: OptimizeRequest) =>
    fetch('/api/library/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => json<{ key: string; entries: LibraryEntry[] }>(r)),
  libraryDelete: (id: string) => fetch(`/api/library/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  cancel: (id: string) => fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  watch(id: string, onProgress: (s: JobSnapshot) => void, onDone: (s: JobSnapshot) => void, onError: (e: string) => void) {
    const es = new EventSource(`/api/jobs/${id}/events`);
    es.addEventListener('progress', (e) => onProgress(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('done', (e) => { es.close(); onDone(JSON.parse((e as MessageEvent).data)); });
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) return; es.close(); onError('Lost connection to the optimizer job'); };
    return () => es.close();
  },
};
