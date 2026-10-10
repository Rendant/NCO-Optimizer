// Optimizer quality benchmark. Usage: CASE=sfr5s SEEDS=1,2,3 node bench.mjs <ms>
import { optimize, COOLER_NAMES, HEATER_NAMES } from '../src/index.ts';
const S = { x: true, y: true, z: true };
const CASES: Record<string, any> = {
  sfr5s: { reactor: 'sfr', dims: [5, 5, 5], fuelId: 'leu-235-oxide', symmetry: S },
  sfr7: { reactor: 'sfr', dims: [7, 7, 7], fuelId: 'leu-235-oxide', symmetry: {} },
  sfr7s: { reactor: 'sfr', dims: [7, 7, 7], fuelId: 'leu-235-oxide', symmetry: S },
  tbu5s: { reactor: 'sfr', dims: [5, 5, 5], fuelId: 'tbu-oxide', symmetry: S },
  msr5s: { reactor: 'msr', dims: [5, 5, 5], fuelId: 'heu-235-fluoride', symmetry: S },
};
const ms = Number(process.argv[2] ?? 6000);
const c = CASES[process.env.CASE ?? 'sfr5s'];
const seeds = (process.env.SEEDS ?? '1,2,3,4,5,6').split(',').map(Number);
const out: number[] = []; let ev = 0;
for (const seed of seeds) {
  const r = optimize({ ...c, objective: 'output', allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: ['beryllium_carbon', 'lead_steel'],
    allowedCoolers: c.reactor === 'sfr' ? [...COOLER_NAMES] : [...HEATER_NAMES], timeLimitMs: ms, seed });
  out.push(r.valid ? r.stats.effectiveHeating : 0); ev += r.evaluations / (r.elapsedMs / 1000);
  console.log('seed', seed, r.valid, r.stats.effectiveHeating.toFixed(0), 'evals/s', Math.round(r.evaluations / (r.elapsedMs / 1000)));
}
console.log('mean', (out.reduce((a, b) => a + b, 0) / out.length).toFixed(0), 'evals/s', Math.round(ev / seeds.length));
