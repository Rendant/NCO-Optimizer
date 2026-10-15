/** Optimization job manager: fans a request out to N worker threads with different seeds. */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { OptimizeConfig, OptimizeResult, Progress, ReactorStats } from '@ncopt/engine';
import { createExchange } from './exchange.js';
import type { Library } from './library.js';

export interface WorkerState {
  seed: number;
  phase: Progress['phase'] | 'starting' | 'error';
  evaluations: number;
  elapsedMs: number;
  bestFitness: number;
  bestValid: boolean;
  effectiveHeating: number;
  meanEfficiency: number;
  /** best objective over time: [elapsed ms, effective heating, valid 0/1] */
  history: [number, number, number][];
  error?: string;
}

export interface JobResult { id: string; seed: number; grid: number[]; stats: ReactorStats; fitness: number; valid: boolean }

export interface Job {
  id: string;
  cfg: OptimizeConfig;
  status: 'running' | 'done' | 'cancelled' | 'error';
  createdAt: number;
  workers: WorkerState[];
  best: { grid: number[]; stats: ReactorStats; fitness: number; valid: boolean } | null;
  results: JobResult[];
  stop: Int32Array;
  threads: Worker[];
  listeners: Set<(event: string, data: unknown) => void>;
  options: JobOptions;
  librarySeeds: number;
  libraryAdded: number;
}

export interface JobOptions {
  /** share the best layout between workers */
  cooperate: boolean;
  /** seed from / save to the result library */
  useLibrary: boolean;
}

const HISTORY_MAX = 300;
function pushHistory(h: [number, number, number][], p: [number, number, number]) {
  const lastP = h[h.length - 1];
  if (lastP && lastP[1] === p[1] && lastP[2] === p[2] && h.length > 1 && h[h.length - 2][1] === p[1]) lastP[0] = p[0]; // extend flat segments
  else h.push(p);
  if (h.length > HISTORY_MAX) for (let k = 1; k < h.length - 1; k += 1) h.splice(k, 1); // thin out (keeps endpoints)
}

const better = (a: { valid: boolean; fitness: number }, b: { valid: boolean; fitness: number } | null) =>
  !b || (a.valid && !b.valid) || (a.valid === b.valid && a.fitness > b.fitness);

export class JobManager {
  private jobs = new Map<string, Job>();
  constructor(private workerUrl: URL, private library?: Library) {}

  get(id: string) { return this.jobs.get(id); }

  snapshot(job: Job, includeResults = true) {
    return {
      id: job.id, status: job.status, cfg: job.cfg, createdAt: job.createdAt, workers: job.workers,
      totalEvaluations: job.workers.reduce((a, w) => a + w.evaluations, 0),
      best: job.best, results: includeResults ? job.results : undefined,
      options: job.options, librarySeeds: job.librarySeeds, libraryAdded: job.libraryAdded,
    };
  }

  create(cfg: OptimizeConfig, workers: number, options: JobOptions = { cooperate: true, useLibrary: true }): Job {
    const id = randomUUID();
    const stopBuf = new SharedArrayBuffer(4);
    const baseSeed = cfg.seed ?? Math.floor(Math.random() * 2 ** 31);
    const job: Job = {
      id, cfg: { ...cfg, seed: baseSeed }, status: 'running', createdAt: Date.now(), workers: [], best: null, results: [],
      stop: new Int32Array(stopBuf), threads: [], listeners: new Set(), options, librarySeeds: 0, libraryAdded: 0,
    };
    // library layouts for the same reactor / size / fuel / objective become extra seeds (not when improving a layout)
    const seedLayouts = options.useLibrary && this.library && !cfg.initial
      ? this.library.forConfig(cfg).filter((e) => e.compatible).slice(0, 4).map((e) => e.grid) : [];
    job.librarySeeds = seedLayouts.length;
    const N = cfg.dims[0] * cfg.dims[1] * cfg.dims[2];
    // value plotted in the progress chart: fuel use for breeding, irradiator flux for irradiation, effective heat otherwise
    const metric = (st: { effectiveHeating: number; fuelPerHour: number; irradiatorFlux: number }) =>
      (cfg.objective === 'breeding' ? st.fuelPerHour : cfg.objective === 'irradiation' ? st.irradiatorFlux : st.effectiveHeating);
    const exchange = options.cooperate && workers > 1 ? createExchange(N) : undefined;
    this.jobs.set(id, job);
    this.gc();
    let finished = 0;
    for (let w = 0; w < workers; w++) {
      const seed = (baseSeed + w * 7919) >>> 0;
      const state: WorkerState = { seed, phase: 'starting', evaluations: 0, elapsedMs: 0, bestFitness: -Infinity, bestValid: false, effectiveHeating: 0, meanEfficiency: 0, history: [] };
      job.workers.push(state);
      const t = new Worker(this.workerUrl, { workerData: { cfg: { ...cfg, seed, seedLayouts }, stop: stopBuf, exchange } });
      job.threads.push(t);
      const done = () => {
        if (++finished === workers) {
          if (job.status === 'running') job.status = job.results.length ? 'done' : 'error';
          job.results.sort((a, b) => (better(a, b) ? -1 : 1));
          if (options.useLibrary && this.library && job.results.length) {
            try { job.libraryAdded = this.library.add(cfg, job.results, job.id); } catch { /* library is best-effort */ }
          }
          this.emit(job, 'done', this.snapshot(job));
          job.threads = [];
        }
      };
      t.on('message', (m: any) => {
        if (m.type === 'progress') {
          const p: Progress = m.progress;
          Object.assign(state, {
            phase: p.phase, evaluations: p.evaluations, elapsedMs: p.elapsedMs, bestFitness: p.bestFitness, bestValid: p.bestValid,
            effectiveHeating: p.bestStats?.effectiveHeating ?? 0, meanEfficiency: p.bestStats?.meanEfficiency ?? 0,
          });
          pushHistory(state.history, [p.elapsedMs, p.bestValid && p.bestStats ? metric(p.bestStats) : 0, p.bestValid ? 1 : 0]);
          if (p.bestGrid && p.bestStats) {
            const cand = { grid: p.bestGrid, stats: p.bestStats, fitness: p.bestFitness, valid: p.bestValid };
            if (better(cand, job.best)) job.best = cand;
          }
          this.emit(job, 'progress', this.snapshot(job, false));
        } else if (m.type === 'result') {
          const r: OptimizeResult = m.result;
          state.phase = 'done'; state.evaluations = r.evaluations; state.elapsedMs = r.elapsedMs;
          state.bestFitness = r.fitness; state.bestValid = r.valid; state.effectiveHeating = r.stats.effectiveHeating; state.meanEfficiency = r.stats.meanEfficiency;
          pushHistory(state.history, [r.elapsedMs, r.valid ? metric(r.stats) : 0, r.valid ? 1 : 0]);
          const key = r.grid.join(',');
          if (!job.results.some((x) => x.grid.join(',') === key)) job.results.push({ id: `${id.slice(0, 8)}-${seed}`, seed, grid: r.grid, stats: r.stats, fitness: r.fitness, valid: r.valid });
          const cand = { grid: r.grid, stats: r.stats, fitness: r.fitness, valid: r.valid };
          if (better(cand, job.best)) job.best = cand;
        } else if (m.type === 'error') {
          state.phase = 'error'; state.error = m.error;
        }
      });
      t.on('error', (e) => { state.phase = 'error'; state.error = e.message; });
      t.on('exit', done);
    }
    return job;
  }

  cancel(job: Job) {
    if (job.status !== 'running') return;
    job.status = 'cancelled';
    Atomics.store(job.stop, 0, 1); // workers finish polish/cleanup quickly and still report their best
  }

  subscribe(job: Job, fn: (event: string, data: unknown) => void) {
    job.listeners.add(fn);
    return () => job.listeners.delete(fn);
  }

  private emit(job: Job, event: string, data: unknown) { for (const l of job.listeners) l(event, data); }

  /** keep the 50 most recent jobs */
  private gc() {
    if (this.jobs.size <= 50) return;
    const old = [...this.jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
    for (const j of old.slice(0, this.jobs.size - 50)) this.jobs.delete(j.id);
  }
}
