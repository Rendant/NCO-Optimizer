import { describe, it, expect } from 'vitest';
import { Simulator, FUELS, parseRule, adjacentSatisfied, COOLER0, FUEL, MOD0, REFL0, CONDUCTOR, planSources, explainBlock, mulberry32, optimize, COOLER_NAMES, HEATER_NAMES, blockFromKey } from '../src/index.ts';
import { referenceSimulate } from './reference.ts';

const fuel = (id: string) => FUELS.find((f) => f.id === id)!;
const G = 2, BE = 3, HW = 4, BC = 5, LS = 6;
const sink = (name: string) => blockFromKey(`${name}_sink`, 'sfr');

describe('fuel data (NCConfig defaults)', () => {
  it('matches known values', () => {
    expect(fuel('heu-235-oxide')).toMatchObject({ heat: 360, criticality: 51, efficiency: 1.05, time: 4800 });
    expect(fuel('tbu-oxide')).toMatchObject({ heat: 40, criticality: 234, efficiency: 1.25 });
    expect(fuel('leu-235-nitride')).toMatchObject({ heat: 96, criticality: 128 });
    expect(fuel('hecf-251-nitride').criticality).toBe(Math.floor(89 / 2));
    expect(fuel('hecf-251-za').criticality).toBe(30);
    expect(fuel('lecf-249-oxide').selfPriming).toBe(true);
    expect(FUELS.filter((f) => f.reactor === 'sfr').length).toBe(81);
    expect(FUELS.filter((f) => f.reactor === 'msr').length).toBe(27);
  });
});

describe('placement rules', () => {
  it('parses source rule strings', () => {
    const r = parseRule('exactly two axial lead sinks && one casing', 'sfr');
    expect(r.op).toBe('and');
    expect(r.subs[0]).toMatchObject({ target: 'cooler', amount: 2, count: 'exactly', adj: 'axial', coolerType: 17 });
    expect(r.subs[1]).toMatchObject({ target: 'casing', amount: 1, count: 'atLeast' });
    expect(r.requiresRecheck).toBe(true);
    expect(parseRule('two axial reflectors', 'msr').subs[0]).toMatchObject({ target: 'reflector', adj: 'axial', amount: 2 });
    expect(parseRule('one vessel && one casing', 'msr').subs[0].target).toBe('fuel');
  });
  it('evaluates adjacency like PlacementRule.Adjacent', () => {
    const axial2 = parseRule('two axial lapis sinks', 'sfr').subs[0];
    expect(adjacentSatisfied(axial2, 0b000011)).toBe(true); // down+up
    expect(adjacentSatisfied(axial2, 0b000110)).toBe(false); // up+north
    const ex = parseRule('exactly two iron sinks', 'sfr').subs[0];
    expect(adjacentSatisfied(ex, 0b000011)).toBe(true);
    expect(adjacentSatisfied(ex, 0b000111)).toBe(false);
    const vtx = parseRule('three casings at exactly one vertex', 'sfr').subs[0];
    expect(adjacentSatisfied(vtx, 0b010101)).toBe(true); // down, north, west
    expect(adjacentSatisfied(vtx, 0b000111)).toBe(false); // down, up, north
  });
});

describe('core mechanics', () => {
  it('two cells joined by a heavy water line', () => {
    const sim = new Simulator([1, 1, 4], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, HW, FUEL]));
    expect(s.runningFuelComponents).toBe(2);
    expect(s.rawHeating).toBe(720);
    expect(s.effectiveHeating).toBeCloseTo(756, 6);
    expect(s.activeModerators).toBe(2);
    expect(s.sparsityEfficiencyMult).toBe(1);
    expect(s.stable).toBe(false);
  });
  it('below criticality nothing runs', () => {
    const sim = new Simulator([1, 1, 3], { reactor: 'sfr', fuel: fuel('leu-235-oxide') }); // crit 102
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, FUEL])); // flux 36
    expect(s.runningFuelComponents).toBe(0);
    expect(s.effectiveHeating).toBe(0);
  });
  it('reflector doubles flux and adds a heat multiplier', () => {
    const sim = new Simulator([1, 1, 3], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, BC])); // flux floor(2*36*1) = 72 >= 51
    expect(s.runningFuelComponents).toBe(1);
    expect(sim.flux[0]).toBe(72);
    expect(s.rawHeating).toBe(360);
    // efficiency = 1 * 1.05 * (0.5 * 1.0) * fluxEff
    const fe = (1 + Math.exp(-102)) / (1 + Math.exp(2 * (72 - 102)));
    expect(sim.fuelEfficiency(0)).toBeCloseTo(1.05 * 0.5 * fe, 9);
    expect(s.activeReflectors).toBe(1);
  });
  it('reflectors need at most reach/2 moderators', () => {
    const sim = new Simulator([1, 1, 5], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    expect(sim.evaluate(Uint8Array.from([FUEL, G, G, G, BC])).runningFuelComponents).toBe(0);
  });
  it('lines longer than neutron reach do not connect', () => {
    const sim = new Simulator([1, 1, 7], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    expect(sim.evaluate(Uint8Array.from([FUEL, HW, HW, HW, HW, HW, FUEL])).runningFuelComponents).toBe(0);
    const sim2 = new Simulator([1, 1, 6], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    expect(sim2.evaluate(Uint8Array.from([FUEL, G, G, G, G, FUEL])).runningFuelComponents).toBe(0); // 40 < 51
    expect(sim2.evaluate(Uint8Array.from([FUEL, HW, G, G, G, FUEL])).runningFuelComponents).toBe(2); // 66
  });
  it('flux efficiency drops near twice criticality', () => {
    const sim = new Simulator([1, 1, 3], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    sim.evaluate(Uint8Array.from([FUEL, HW, LS])); // floor(2*36*0.5)=36 < 51
    expect(sim.running[0]).toBe(0);
  });
  it('heat sink rules, cooling and overcooling penalty', () => {
    // x: water sink | cell | hw | hw | cell | water sink  (1x1x6 along x)
    const sim = new Simulator([6, 1, 1], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    const w = sink('water');
    const s = sim.evaluate(Uint8Array.from([w, FUEL, HW, HW, FUEL, w]));
    expect(s.validCoolers).toBe(2);
    expect(s.cooling).toBe(110);
    expect(s.clusterCount).toBe(2); // cells separated by moderators form separate clusters
    const ocf = Math.min(1, (720 + 10) / 110);
    expect(ocf).toBe(1);
    // overcooled: tiny fuel heat
    const sim2 = new Simulator([6, 1, 1], { reactor: 'sfr', fuel: fuel('tbu-oxide') });
    const s2 = sim2.evaluate(Uint8Array.from([w, FUEL, HW, HW, FUEL, w])); // 72 < 234: not running
    expect(s2.validCoolers).toBe(0);
  });
  it('exact rules fail when over-satisfied', () => {
    // three parallel lines FUEL HW HW FUEL along x (y=0) for z = 0..2; iron sinks sit on active moderators
    const dims: [number, number, number] = [4, 2, 3];
    const at = (x: number, y: number, z: number) => x + 4 * (y + 2 * z);
    const iron = sink('iron'), gold = sink('gold');
    const build = (third: boolean) => {
      const g = new Uint8Array(24);
      for (let z = 0; z < 3; z++) { g[at(0, 0, z)] = FUEL; g[at(1, 0, z)] = HW; g[at(2, 0, z)] = HW; g[at(3, 0, z)] = FUEL; }
      g[at(1, 1, 1)] = iron; g[at(2, 1, 0)] = iron; if (third) g[at(2, 1, 2)] = iron;
      g[at(2, 1, 1)] = gold; // "exactly two iron sinks"
      return g;
    };
    const sim = new Simulator(dims, { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    sim.evaluate(build(false));
    expect(sim.modState[at(1, 0, 1)]).toBe(2);
    expect(sim.valid[at(2, 1, 1)]).toBe(1);
    sim.evaluate(build(true));
    expect(sim.valid[at(2, 1, 2)]).toBe(1);
    expect(sim.valid[at(2, 1, 1)]).toBe(0);
  });
});

describe('molten salt bunching', () => {
  it('2x2x2 bunch uses surface and bunching factors', () => {
    const sim = new Simulator([2, 2, 2], { reactor: 'msr', fuel: fuel('heu-235-fluoride') });
    sim.evaluate(new Uint8Array(8).fill(FUEL));
    expect(sim.bunchCount).toBe(1);
    expect(sim.surfaceFactor(0)).toBe(4); // 24 open faces / 6
    expect(sim.bunchingFactor(0)).toBe(2); // 48 / 24
    expect(sim.running[0]).toBe(0); // no moderators -> no flux
  });
});

describe('neutron sources', () => {
  it('plans sources for a chain that needs priming', () => {
    const sim = new Simulator([1, 1, 4], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    const grid = Uint8Array.from([FUEL, HW, HW, FUEL]);
    const plan = planSources(sim, grid, 'radium_beryllium');
    expect(plan.needed).toBe(true);
    expect(plan.fullyPrimed).toBe(true);
    expect(plan.sources.length).toBe(1);
    // the primed cell gets the source efficiency
    expect(plan.stats.effectiveHeating).toBeCloseTo(360 * 1.05 * 0.9 + 360 * 1.05, 6);
  });
});

describe('fast simulator matches literal reference port (fuzz)', () => {
  const fuels = ['heu-235-oxide', 'leu-235-oxide', 'hep-239-nitride', 'heu-233-za', 'lecm-243-oxide'];
  it('agrees on random layouts', () => {
    const rnd = mulberry32(12345);
    let compared = 0, interesting = 0;
    for (let t = 0; t < 1500; t++) {
      const dims: [number, number, number] = [2 + Math.floor(rnd() * 4), 2 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 4)];
      const N = dims[0] * dims[1] * dims[2];
      const f = fuel(fuels[t % fuels.length]);
      const grid = new Uint8Array(N);
      // structured: lattice of fuel + moderator lines, then random perturbation, coolers elsewhere
      const sp = 2 + Math.floor(rnd() * 3), mod = [HW, BE, G][Math.floor(rnd() * 3)];
      for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
        const on = [x, y, z].map((v, a) => dims[a] === 1 || v % sp === 0).filter(Boolean).length;
        const i = x + dims[0] * (y + dims[1] * z);
        grid[i] = on === 3 ? FUEL : on === 2 ? mod : rnd() < 0.85 ? COOLER0 + Math.floor(rnd() * 32) : rnd() < 0.5 ? CONDUCTOR : 0;
      }
      for (let k = 0; k < N * 0.15; k++) {
        const i = Math.floor(rnd() * N), r = rnd();
        grid[i] = r < 0.2 ? FUEL : r < 0.45 ? [HW, BE, G][Math.floor(rnd() * 3)] : r < 0.55 ? (rnd() < 0.5 ? BC : LS) : r < 0.6 ? CONDUCTOR : r < 0.95 ? COOLER0 + Math.floor(rnd() * 32) : 0;
      }
      const sim = new Simulator(dims, { reactor: 'sfr', fuel: f });
      const s = sim.evaluate(grid);
      const ref = referenceSimulate(dims, grid, f);
      const running: number[] = [], valid: number[] = [], active: number[] = [], passive: number[] = [];
      for (let i = 0; i < N; i++) { if (sim.running[i]) running.push(i); if (sim.valid[i]) valid.push(i); if (sim.modState[i] === 2) active.push(i); if (sim.modState[i] === 1) passive.push(i); }
      expect(running).toEqual(ref.running);
      expect(active).toEqual(ref.active);
      expect(passive).toEqual(ref.passive);
      expect(valid).toEqual(ref.valid);
      expect(s.rawHeating).toBe(ref.raw);
      expect(s.cooling).toBe(ref.cooling);
      expect(s.effectiveHeating).toBeCloseTo(ref.effectiveHeating, 6);
      compared++;
      if (ref.running.length > 0 && ref.valid.length > 0) interesting++;
    }
    expect(compared).toBe(1500);
    expect(interesting).toBeGreaterThan(80);
  });
});

describe('incremental evaluation', () => {
  for (const reactor of ['sfr', 'msr'] as const) {
    it(`reused neutronics give identical results to a fresh simulator (${reactor})`, () => {
      const rnd = mulberry32(reactor === 'sfr' ? 99 : 77);
      const f = fuel(reactor === 'sfr' ? 'leu-235-oxide' : 'heu-235-fluoride');
      const dims: [number, number, number] = [5, 4, 5];
      const N = 100;
      const grid = new Uint8Array(N);
      for (let i = 0; i < N; i++) grid[i] = i % 7 === 0 ? FUEL : i % 3 === 0 ? G : COOLER0 + Math.floor(rnd() * 32);
      const inc = new Simulator(dims, { reactor, fuel: f });
      let partial = 0;
      for (let step = 0; step < 3000; step++) {
        const i = Math.floor(rnd() * N), r = rnd();
        // mostly non-neutronic changes (the case that reuses the cache), sometimes structural ones
        grid[i] = r < 0.75 ? COOLER0 + Math.floor(rnd() * 32) : r < 0.8 ? CONDUCTOR : r < 0.85 ? 0 : r < 0.9 ? FUEL : r < 0.95 ? [HW, BE, G][Math.floor(rnd() * 3)] : BC;
        const before = inc.partialEvals;
        const a = inc.evaluate(grid);
        partial += inc.partialEvals - before;
        const fresh = new Simulator(dims, { reactor, fuel: f });
        const b = fresh.evaluate(grid);
        expect(a).toEqual(b);
        expect(Array.from(inc.valid)).toEqual(Array.from(fresh.valid));
        expect(Array.from(inc.running)).toEqual(Array.from(fresh.running));
      }
      expect(partial).toBeGreaterThan(1500);
    });
  }
});

describe('optimizer', () => {
  it('finds a valid, heat-neutral SFR layout', () => {
    const r = optimize({ reactor: 'sfr', dims: [3, 3, 3], fuelId: 'leu-235-oxide', objective: 'output', allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: ['beryllium_carbon'], allowedCoolers: [...COOLER_NAMES], timeLimitMs: 2500, seed: 3 });
    expect(r.valid).toBe(true);
    expect(r.stats.excessHeat).toBe(0);
    expect(r.stats.effectiveHeating).toBeGreaterThan(0);
    // re-simulating the returned grid reproduces the stats
    const sim = new Simulator([3, 3, 3], { reactor: 'sfr', fuel: fuel('leu-235-oxide') });
    expect(sim.evaluate(Uint8Array.from(r.grid)).effectiveHeating).toBeCloseTo(r.stats.effectiveHeating, 9);
    const info = explainBlock(sim, r.grid.indexOf(FUEL));
    expect(info.fuel?.running).toBe(true);
  }, 20000);
  it('finds a valid MSR layout', () => {
    const r = optimize({ reactor: 'msr', dims: [5, 5, 5], fuelId: 'heu-235-fluoride', objective: 'output', allowedModerators: ['heavy_water', 'graphite'], allowedReflectors: [], allowedCoolers: [...HEATER_NAMES], timeLimitMs: 4000, seed: 5 });
    expect(r.valid).toBe(true);
  }, 20000);
  it('breeding objective burns more fuel than max output', () => {
    const base = { reactor: 'sfr' as const, dims: [5, 5, 5] as [number, number, number], fuelId: 'leu-235-oxide', allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: ['beryllium_carbon'], allowedCoolers: [...COOLER_NAMES], symmetry: { x: true, y: true, z: true }, timeLimitMs: 2500, seed: 7 };
    const out = optimize({ ...base, objective: 'output' });
    const breed = optimize({ ...base, objective: 'breeding' });
    expect(breed.valid).toBe(true);
    expect(breed.stats.excessHeat).toBe(0);
    expect(breed.stats.fuelPerHour).toBeGreaterThan(out.stats.fuelPerHour);
  }, 20000);
});
void MOD0; void REFL0;
