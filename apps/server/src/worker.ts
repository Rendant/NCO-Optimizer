/** Optimizer worker thread: runs one optimizer instance and streams progress to the parent. */
import { parentPort, workerData } from 'node:worker_threads';
import { optimize, type OptimizeConfig, type Progress } from '@ncopt/engine';
import { exchangeHooks } from './exchange.js';

const { cfg, stop, exchange } = workerData as { cfg: OptimizeConfig; stop: SharedArrayBuffer; exchange?: SharedArrayBuffer };
const stopFlag = new Int32Array(stop);
let last = 0;
try {
  const result = optimize(
    cfg,
    (p: Progress) => {
      const now = Date.now();
      if (p.phase !== 'done' && now - last < 250) return;
      last = now;
      parentPort!.postMessage({ type: 'progress', progress: p });
    },
    () => Atomics.load(stopFlag, 0) !== 0,
    exchange ? exchangeHooks(exchange) : undefined,
  );
  parentPort!.postMessage({ type: 'result', result });
} catch (e) {
  parentPort!.postMessage({ type: 'error', error: e instanceof Error ? e.message : String(e) });
}
