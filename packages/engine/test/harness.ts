import { optimize, COOLER_NAMES, HEATER_NAMES } from '../src/index.ts';
const cases: any[] = [
  { reactor:'sfr', dims:[5,5,5], fuelId:'leu-235-oxide', symmetry:{x:true,y:true,z:true} },
  { reactor:'sfr', dims:[7,7,7], fuelId:'leu-235-oxide', symmetry:{} },
  { reactor:'sfr', dims:[7,7,7], fuelId:'leu-235-oxide', symmetry:{x:true,y:true,z:true} },
  { reactor:'sfr', dims:[5,5,5], fuelId:'tbu-oxide', symmetry:{x:true,y:true,z:true} },
  { reactor:'msr', dims:[5,5,5], fuelId:'heu-235-fluoride', symmetry:{x:true,y:true,z:true} },
];
const ms = Number(process.argv[2] ?? 8000);
for (const c of cases) {
  const r = optimize({ ...c, objective:'output', allowedModerators:['graphite','beryllium','heavy_water'], allowedReflectors:['beryllium_carbon','lead_steel'], allowedCoolers: c.reactor==='sfr'?[...COOLER_NAMES]:[...HEATER_NAMES], timeLimitMs: ms, seed: 7 });
  const s = r.stats;
  console.log(c.reactor, c.dims.join('x'), c.fuelId, JSON.stringify(c.symmetry), '| valid', r.valid, '| eff', s.effectiveHeating.toFixed(0), '| raw', s.rawHeating, 'cool', s.cooling, '| me', (s.meanEfficiency*100).toFixed(1)+'%', '| cells', s.fuelComponents, '| evals/s', Math.round(r.evaluations/(r.elapsedMs/1000)));
}
