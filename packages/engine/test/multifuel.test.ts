import { describe, it, expect } from 'vitest';
import { Simulator, FUELS, FUEL, FUELX0, MOD0, COOLER0, CONDUCTOR, REFL0, mulberry32, optimize, planSources, explainBlock, COOLER_NAMES, HEATER_NAMES, isFuel, fuelSlot } from '../src/index.ts';

const fuel = (id: string) => FUELS.find((f) => f.id === id)!;
const G = MOD0, BE = MOD0 + 1, HW = MOD0 + 2, BC = REFL0;

describe('multi-fuel simulator', () => {
  for (const reactor of ['sfr', 'msr'] as const) {
    it(`a layout loaded only with fuel slot 1 equals the single-fuel layout (${reactor})`, () => {
      const a = fuel(reactor === 'sfr' ? 'leu-235-oxide' : 'leu-235-fluoride'), b = fuel(reactor === 'sfr' ? 'heu-233-oxide' : 'heu-233-fluoride');
      const rnd = mulberry32(5);
      const dims: [number, number, number] = [5, 4, 5];
      for (let t = 0; t < 40; t++) {
        const g = new Uint8Array(100);
        for (let i = 0; i < 100; i++) { const r = rnd(); g[i] = r < 0.15 ? FUEL : r < 0.45 ? [G, BE, HW][Math.floor(rnd() * 3)] : r < 0.5 ? BC : COOLER0 + Math.floor(rnd() * 32); }
        const single = new Simulator(dims, { reactor, fuel: b }).evaluate(g);
        const g2 = g.map((x) => (x === FUEL ? FUELX0 : x));
        const multi = new Simulator(dims, { reactor, fuel: a, fuels: [a, b] }).evaluate(g2);
        expect(multi.effectiveHeating).toBeCloseTo(single.effectiveHeating, 9);
        expect(multi.rawHeating).toBeCloseTo(single.rawHeating, 9);
        expect(multi.runningFuelComponents).toBe(single.runningFuelComponents);
        expect(multi.fuelPerHour).toBeCloseTo(single.fuelPerHour, 6);
        expect(multi.fuelBreakdown[0].placed).toBe(0);
        expect(multi.fuelBreakdown[1].placed).toBe(single.fuelComponents);
      }
    });
  }
  it('MSR vessels of different fuels do not bunch', () => {
    const a = fuel('heu-235-fluoride'), b = fuel('leu-235-fluoride');
    const sim = new Simulator([2, 1, 1], { reactor: 'msr', fuel: a, fuels: [a, b] });
    sim.evaluate(Uint8Array.from([FUEL, FUEL]));
    expect(sim.bunchCount).toBe(1);
    sim.evaluate(Uint8Array.from([FUEL, FUELX0]));
    expect(sim.bunchCount).toBe(2);
  });
  it('each component uses its own criticality', () => {
    // HEU-235 oxide (low criticality) and TBU oxide (high criticality) on both ends of one heavy-water line
    const heu = fuel('heu-235-oxide'), tbu = fuel('tbu-oxide');
    const sim = new Simulator([1, 1, 3], { reactor: 'sfr', fuel: heu, fuels: [heu, tbu] });
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, FUELX0]));
    const flux = sim.flux[0];
    expect(sim.running[0]).toBe(flux >= heu.criticality ? 1 : 0);
    expect(sim.running[2]).toBe(sim.flux[2] >= tbu.criticality && sim.running[0] ? 1 : sim.running[2]);
    expect(s.fuelBreakdown.map((u) => u.fuelId)).toEqual([heu.id, tbu.id]);
    expect(explainBlock(sim, 2).fuel?.fuelId).toBe(tbu.id);
  });
  it('incremental evaluation stays exact with fuel-type changes', () => {
    const fs = [fuel('leu-235-fluoride'), fuel('heu-235-fluoride'), fuel('leu-233-fluoride')];
    const rnd = mulberry32(11);
    const dims: [number, number, number] = [5, 4, 5];
    const grid = new Uint8Array(100);
    const fb = [FUEL, FUELX0, FUELX0 + 1];
    for (let i = 0; i < 100; i++) grid[i] = i % 7 === 0 ? fb[i % 3] : i % 3 === 0 ? G : COOLER0 + Math.floor(rnd() * 32);
    const inc = new Simulator(dims, { reactor: 'msr', fuel: fs[0], fuels: fs });
    for (let step = 0; step < 1500; step++) {
      const i = Math.floor(rnd() * 100), r = rnd();
      grid[i] = r < 0.7 ? COOLER0 + Math.floor(rnd() * 32) : r < 0.75 ? CONDUCTOR : r < 0.8 ? 0 : r < 0.92 ? fb[Math.floor(rnd() * 3)] : [HW, BE, G][Math.floor(rnd() * 3)];
      const a = inc.evaluate(grid);
      const b = new Simulator(dims, { reactor: 'msr', fuel: fs[0], fuels: fs }).evaluate(grid);
      expect(a).toEqual(b);
    }
  });
  it('source plan skips self-priming fuels', () => {
    const self = FUELS.find((f) => f.reactor === 'sfr' && f.selfPriming && f.intrinsicFlux === 0);
    if (!self) return;
    const heu = fuel('heu-235-oxide');
    const sim = new Simulator([1, 1, 3], { reactor: 'sfr', fuel: self, fuels: [self, heu] });
    const p = planSources(sim, Uint8Array.from([FUEL, G, FUEL]));
    expect(p.needed).toBe(false);
  });
});

describe('multi-fuel optimizer', () => {
  it('places several fuels and re-simulates identically', () => {
    const cfg = { reactor: 'sfr' as const, dims: [5, 5, 5] as [number, number, number], fuelId: 'leu-235-oxide', fuelIds: ['leu-235-oxide', 'tbu-oxide'], requireAllFuels: true,
      objective: 'output' as const, allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: ['beryllium_carbon'], allowedCoolers: [...COOLER_NAMES], symmetry: { x: true, y: true, z: true }, timeLimitMs: 6000, seed: 9 };
    const r = optimize(cfg);
    expect(r.valid).toBe(true);
    expect(r.stats.fuelBreakdown.every((u) => u.producing > 0)).toBe(true);
    const fs = [fuel('leu-235-oxide'), fuel('tbu-oxide')];
    const s = new Simulator(cfg.dims, { reactor: 'sfr', fuel: fs[0], fuels: fs }).evaluate(Uint8Array.from(r.grid));
    expect(s.effectiveHeating).toBeCloseTo(r.stats.effectiveHeating, 9);
    expect(new Set(r.grid.filter(isFuel).map(fuelSlot)).size).toBe(2);
  }, 20000);
  it('MSR multi-fuel optimisation finds a valid layout', () => {
    const r = optimize({ reactor: 'msr', dims: [5, 5, 5], fuelId: 'heu-235-fluoride', fuelIds: ['heu-235-fluoride', 'leu-235-fluoride'], objective: 'output', allowedModerators: ['heavy_water', 'graphite'], allowedReflectors: [], allowedCoolers: [...HEATER_NAMES], symmetry: { x: true, y: true, z: true }, timeLimitMs: 3000, seed: 4 });
    expect(r.valid).toBe(true);
  }, 20000);
});
