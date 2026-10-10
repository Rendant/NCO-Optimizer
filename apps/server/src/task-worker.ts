/** One-shot worker for CPU-heavy synchronous tasks (turbine design). */
import { parentPort, workerData } from 'node:worker_threads';
import { optimizeTurbine } from '@ncopt/engine';

try {
  const { type, cfg } = workerData as { type: 'turbine'; cfg: any };
  if (type !== 'turbine') throw new Error(`unknown task ${type}`);
  parentPort!.postMessage({ ok: true, result: optimizeTurbine(cfg) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
