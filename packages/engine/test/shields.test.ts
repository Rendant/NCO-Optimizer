import { describe, it, expect } from 'vitest';
import { Simulator, FUELS, FUEL, CONDUCTOR, COOLER0, SHIELD0, IRRADIATOR, mulberry32, blockFromKey, explainBlock, type FuelDef } from '../src/index.ts';
import { referenceSimulate } from './reference.ts';

const fuel = (id: string) => FUELS.find((f) => f.id === id)!;
const G = 2, BE = 3, HW = 4, BC = 5, LS = 6, BS = SHIELD0, GS = SHIELD0 + 1, IR = IRRADIATOR;
const sink = (name: string) => blockFromKey(`${name}_sink`, 'sfr');
const heu = fuel('heu-235-oxide'); // heat 360, crit 51, eff 1.05

describe('neutron shields', () => {
  it('pass flux like a moderator with flux factor 0 and take the line flux as heat', () => {
    // C HW BS HW C: line flux 72 >= 51, shield flux = 72 (fuel-to-fuel line: inner + outer)
    const sim = new Simulator([1, 1, 5], { reactor: 'sfr', fuel: heu });
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, BS, HW, FUEL]));
    expect(s.runningFuelComponents).toBe(2);
    expect(sim.flux[0]).toBe(72);
    expect(sim.shieldFunc[2]).toBe(1);
    expect(sim.shieldFlux(2)).toBe(72);
    expect(s.activeShields).toBe(1);
    expect(s.shieldRawHeating).toBe(72 * 5);
    expect(s.shieldEffectiveHeating).toBeCloseTo(72 * 5 * 0.5, 9);
    // the shield is not a moderator: both heavy water blocks are active (adjacent to a fuel cell), the shield is not counted
    expect(s.activeModerators).toBe(2);
    expect(s.passiveModerators).toBe(0);
    // line efficiency = mean of (1.0, 0.5, 1.0)
    expect(sim.moderatorEfficiencyFactor(0)).toBeCloseTo(2.5 / 3, 12);
    // separate clusters: cell | shield | cell (moderators are not heat conductors)
    expect(s.clusterCount).toBe(3);
    expect(s.stable).toBe(false); // the shield's 360 H/t is not cooled
  });
  it('a shielding shield blocks the line', () => {
    const sim = new Simulator([1, 1, 5], { reactor: 'sfr', fuel: heu, shieldsOn: true });
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, BS, HW, FUEL]));
    expect(s.runningFuelComponents).toBe(0);
  });
  it('a shield in an incomplete line is not functional', () => {
    const sim = new Simulator([1, 1, 5], { reactor: 'sfr', fuel: fuel('leu-235-oxide') }); // crit 102 > 72
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, GS, HW, FUEL]));
    expect(s.runningFuelComponents).toBe(0);
    expect(s.activeShields).toBe(0);
  });
  it('reflector lines give floor(total × (1 + reflectivity))', () => {
    // C HW BS BC: 2 blocks before the reflector, flux floor(2 × 36 × 1) = 72; shield flux floor(36 × 2) = 72
    const sim = new Simulator([1, 1, 4], { reactor: 'sfr', fuel: heu });
    const s = sim.evaluate(Uint8Array.from([FUEL, HW, BS, BC]));
    expect(s.runningFuelComponents).toBe(1);
    expect(sim.shieldFlux(2)).toBe(72);
    // lead-steel: floor(36 × 1.5) = 54, cell flux floor(2 × 36 × 0.5) = 36 < 51 -> not running
    const s2 = new Simulator([1, 1, 4], { reactor: 'sfr', fuel: heu }).evaluate(Uint8Array.from([FUEL, HW, BS, LS]));
    expect(s2.runningFuelComponents).toBe(0);
  });
});

describe('neutron irradiators', () => {
  it('take the line flux, add a heat multiplier to the source and lower its efficiency', () => {
    // BC HW C HW IR: the cell runs on the reflector line (72); the irradiator line adds heat multiplier 1, flux 36
    const sim = new Simulator([5, 1, 1], { reactor: 'sfr', fuel: heu });
    const s = sim.evaluate(Uint8Array.from([BC, HW, FUEL, HW, IR]));
    expect(s.runningFuelComponents).toBe(1);
    expect(sim.heatMult[2]).toBe(2);
    expect(sim.irrFlux[4]).toBe(36);
    expect(s.irradiatorFlux).toBe(36);
    expect(s.activeIrradiators).toBe(1);
    expect(s.irradiatorItemsPerHour).toBeCloseTo((72000 * 36) / 160000, 9);
    // thorium recipe efficiency 0: the irradiator line contributes 0 to the mean line efficiency
    expect(sim.moderatorEfficiencyFactor(2)).toBeCloseTo((0.5 * 1 + 0) / 2, 12);
    expect(s.rawHeating).toBe(720);
    // first moderator of the irradiator line is active, nothing at the irradiator end
    expect(sim.modState[3]).toBe(2);
    const bis = new Simulator([5, 1, 1], { reactor: 'sfr', fuel: heu, irradiatorRecipe: 'bismuth' });
    bis.evaluate(Uint8Array.from([BC, HW, FUEL, HW, IR]));
    expect(bis.moderatorEfficiencyFactor(2)).toBeCloseTo((0.5 + 0.5) / 2, 12);
  });
  it('do not feed flux back to the fuel', () => {
    const sim = new Simulator([3, 1, 1], { reactor: 'sfr', fuel: heu });
    expect(sim.evaluate(Uint8Array.from([FUEL, HW, IR])).runningFuelComponents).toBe(0);
  });
  it('shield on an irradiator line takes only the inner flux', () => {
    // BC HW C G BS HW IR: irradiator line flux 10 + 0 + 36 = 46, shield inner flux = 10
    const sim = new Simulator([7, 1, 1], { reactor: 'sfr', fuel: heu });
    sim.evaluate(Uint8Array.from([BC, HW, FUEL, G, BS, HW, IR]));
    expect(sim.running[2]).toBe(1);
    expect(sim.irrFlux[6]).toBe(46);
    expect(sim.shieldFlux(4)).toBe(10);
  });
  it('are explained by the inspector', () => {
    const sim = new Simulator([5, 1, 1], { reactor: 'sfr', fuel: heu });
    sim.evaluate(Uint8Array.from([BC, HW, FUEL, HW, IR]));
    const e = explainBlock(sim, 4);
    expect(e.category).toBe('irradiator');
    expect(e.irradiator!.flux).toBe(36);
    const f = explainBlock(sim, 2);
    expect(f.fuel!.lines.map((l) => l.kind).sort()).toEqual(['irradiator', 'reflector']);
  });
});

describe('intrinsic flux', () => {
  const tri: FuelDef = { ...heu, id: 'test-intrinsic', intrinsicFlux: 10 };
  it('adjacent fuel components exchange intrinsic flux and it adds to moderator lines', () => {
    // BC HW C C HW BC: reflector lines floor(2 × (10 + 36)) = 92, plus 10 from the neighbouring cell
    const sim = new Simulator([1, 1, 6], { reactor: 'sfr', fuel: tri });
    const s = sim.evaluate(Uint8Array.from([BC, HW, FUEL, FUEL, HW, BC]));
    expect(s.runningFuelComponents).toBe(2);
    expect(sim.flux[2]).toBe(102);
    expect(sim.heatMult[2]).toBe(2);
    expect(s.rawHeating).toBe(2 * 360 * 2);
    const plain = new Simulator([1, 1, 6], { reactor: 'sfr', fuel: heu });
    plain.evaluate(Uint8Array.from([BC, HW, FUEL, FUEL, HW, BC]));
    expect(plain.flux[2]).toBe(72);
    expect(plain.heatMult[2]).toBe(1);
  });
});

describe('fast simulator matches literal reference port with shields / irradiators (fuzz)', () => {
  const fuels = ['heu-235-oxide', 'leu-235-oxide', 'hep-239-nitride', 'heu-233-za'];
  it('agrees on random layouts', () => {
    const rnd = mulberry32(777);
    let compared = 0, withShield = 0, withIrr = 0;
    for (let t = 0; t < 2400; t++) {
      const dims: [number, number, number] = [2 + Math.floor(rnd() * 4), 2 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 4)];
      const N = dims[0] * dims[1] * dims[2];
      const base = fuel(fuels[t % fuels.length]);
      const f: FuelDef = t % 3 === 0 ? { ...base, id: 'intrinsic', intrinsicFlux: 10 } : base;
      const recipe = (['thorium', 'tbp', 'bismuth'] as const)[t % 3];
      const grid = new Uint8Array(N);
      const sp = 2 + Math.floor(rnd() * 3), mod = [HW, BE, G][Math.floor(rnd() * 3)];
      for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
        const on = [x, y, z].map((v, a) => dims[a] === 1 || v % sp === 0).filter(Boolean).length;
        const i = x + dims[0] * (y + dims[1] * z);
        grid[i] = on === 3 ? FUEL : on === 2 ? (rnd() < 0.2 ? (rnd() < 0.5 ? BS : GS) : mod) : rnd() < 0.8 ? COOLER0 + Math.floor(rnd() * 32) : rnd() < 0.4 ? CONDUCTOR : rnd() < 0.5 ? IR : 0;
      }
      for (let k = 0; k < N * 0.15; k++) {
        const i = Math.floor(rnd() * N), r = rnd();
        grid[i] = r < 0.2 ? FUEL : r < 0.4 ? [HW, BE, G][Math.floor(rnd() * 3)] : r < 0.5 ? (rnd() < 0.5 ? BS : GS) : r < 0.58 ? IR
          : r < 0.65 ? (rnd() < 0.5 ? BC : LS) : r < 0.7 ? CONDUCTOR : r < 0.95 ? COOLER0 + Math.floor(rnd() * 32) : 0;
      }
      const sim = new Simulator(dims, { reactor: 'sfr', fuel: f, irradiatorRecipe: recipe });
      const s = sim.evaluate(grid);
      const ref = referenceSimulate(dims, grid, f, recipe);
      const running: number[] = [], valid: number[] = [], active: number[] = [], passive: number[] = [], shields: number[][] = [], irr: number[][] = [];
      for (let i = 0; i < N; i++) {
        if (sim.running[i]) running.push(i); if (sim.valid[i]) valid.push(i); if (sim.modState[i] === 2) active.push(i); if (sim.modState[i] === 1) passive.push(i);
        if (grid[i] === BS || grid[i] === GS) { if (sim.shieldFunc[i]) shields.push([i, sim.shieldFlux(i)]); }
        if (grid[i] === IR && sim.irrFlux[i] > 0) irr.push([i, sim.irrFlux[i]]);
      }
      expect(running).toEqual(ref.running);
      expect(active).toEqual(ref.active);
      expect(passive).toEqual(ref.passive);
      expect(valid).toEqual(ref.valid);
      expect(shields).toEqual(ref.shieldFlux);
      expect(irr).toEqual(ref.irradiatorFlux);
      expect(s.rawHeating).toBe(ref.raw);
      expect(s.cooling).toBe(ref.cooling);
      expect(s.effectiveHeating).toBeCloseTo(ref.effectiveHeating, 6);
      compared++;
      if (ref.shieldFlux.length) withShield++;
      if (ref.irradiatorFlux.length) withIrr++;
    }
    expect(compared).toBe(2400);
    expect(withShield).toBeGreaterThan(30);
    expect(withIrr).toBeGreaterThan(30);
  });
});
