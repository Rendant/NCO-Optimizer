/** One-shot worker for CPU-heavy synchronous tasks (turbine, heat exchanger design). */
import { parentPort, workerData } from 'node:worker_threads';
import { optimizeTurbine, designHeatExchanger } from '@ncopt/engine';

try {
  const { type, cfg } = workerData as { type: 'turbine' | 'hx'; cfg: any };
  if (type === 'turbine') parentPort!.postMessage({ ok: true, result: optimizeTurbine(cfg) });
  else if (type === 'hx') {
    const r = designHeatExchanger(cfg);
    // typed arrays of the layout -> plain arrays for JSON
    const plain = (d: any) => ({ ...d, layout: { ...d.layout, cells: Array.from(d.layout.cells), settings: Array.from(d.layout.settings) } });
    parentPort!.postMessage({ ok: true, result: { ...r, best: plain(r.best), alternatives: r.alternatives.map(plain) } });
  } else throw new Error(`unknown task ${type}`);
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
