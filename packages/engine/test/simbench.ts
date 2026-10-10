// Deterministic simulator throughput benchmark: a random walk of optimizer-like single-orbit edits.
import { Simulator, FUELS, mulberry32, FUEL, MOD0, COOLER0, CONDUCTOR } from '../src/index.ts';
const dims = (process.env.DIMS ?? '5,5,5').split(',').map(Number) as [number, number, number];
const steps = Number(process.argv[2] ?? 200000);
const fuel = FUELS.find((f) => f.id === 'leu-235-oxide')!;
const sim = new Simulator(dims, { reactor: 'sfr', fuel });
const N = sim.N, rnd = mulberry32(1);
const grid = new Uint8Array(N);
for (let i = 0; i < N; i++) { const [x, y, z] = sim.coords(i); const on = [x, y, z].filter((v) => v % 2 === 0).length; grid[i] = on === 3 ? FUEL : on === 2 ? MOD0 + 2 : COOLER0 + Math.floor(rnd() * 32); }
let acc = 0;
const t0 = performance.now();
for (let s = 0; s < steps; s++) {
  const i = Math.floor(rnd() * N), r = rnd(), prev = grid[i];
  grid[i] = r < 0.65 ? COOLER0 + Math.floor(rnd() * 32) : r < 0.7 ? CONDUCTOR : r < 0.75 ? 0 : r < 0.85 ? FUEL : MOD0 + Math.floor(rnd() * 3);
  acc += sim.evaluate(grid).effectiveHeating;
  if (rnd() < 0.7) grid[i] = prev; // mostly rejected moves, like annealing
}
const dt = performance.now() - t0;
console.log(dims.join('x'), 'evals/s', Math.round(steps / (dt / 1000)), 'checksum', acc.toFixed(0));
