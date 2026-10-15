import { describe, it, expect } from 'vitest';
import {
  Simulator, FUELS, FUEL, COOLER0, SHIELD0, IRRADIATOR, blockFromKey, blockKey, toLayoutJSON, fromLayoutJSON, decayReport, shutdownCheck, optimize, parseRule,
  GAS_COOLER_RULES, GAS_COOLING_RATES, DECAY_CONFIG,
} from '../src/index.ts';

const fuel = (id: string) => FUELS.find((f) => f.id === id)!;
const HW = 4, BC = 5, BS = SHIELD0;
const gas = (name: string) => blockFromKey(`${name}_cooler`, 'pbr');

describe('pebble-bed reactor (TRISO)', () => {
  it('has the TRISO fuels from the NCConfig defaults', () => {
    const triso = FUELS.filter((f) => f.reactor === 'pbr');
    expect(triso.length).toBe(27);
    expect(triso.every((f) => f.form === 'TRISO' && f.intrinsicFlux === 10)).toBe(true);
    expect(fuel('heu-235-triso')).toMatchObject({ heat: 360, criticality: 43, efficiency: 1.05, time: 4800 });
    expect(fuel('tbu-triso')).toMatchObject({ heat: 40, criticality: 199 });
  });
  it('parses the gas cooler rules', () => {
    for (const r of GAS_COOLER_RULES) expect(() => parseRule(r, 'pbr')).not.toThrow();
    expect(parseRule('one chamber', 'pbr').subs[0].target).toBe('fuel');
    expect(parseRule('exactly two nitrogen coolers && one casing', 'pbr').subs[0]).toMatchObject({ target: 'cooler', coolerType: 3, count: 'exactly' });
    expect(parseRule('one chamber', 'sfr').subs[0].target).toBe('unsupported');
  });
  it('chambers bunch like vessels and exchange intrinsic flux', () => {
    // BC HW CH CH HW BC: reflector lines floor(2 × (10 + 36)) = 92 each, plus 10 + 10 intrinsic inside the bunch
    const sim = new Simulator([1, 1, 6], { reactor: 'pbr', fuel: fuel('heu-235-triso') });
    const s = sim.evaluate(Uint8Array.from([BC, HW, FUEL, FUEL, HW, BC]));
    expect(sim.bunchCount).toBe(1);
    expect(sim.bunchFlux[0]).toBe(204);
    expect(s.runningFuelComponents).toBe(2);
    expect(sim.heatMult[2]).toBe(2);
    expect(s.rawHeating).toBe(2 * 360 * 2);
    expect(s.fuelUnit).toBe('ingots/h');
  });
  it('gas coolers heat gas that drives a turbine', () => {
    // oxygen cooler: "one chamber"
    const ox = gas('oxygen');
    expect(blockKey(ox, 'pbr')).toBe('oxygen_cooler');
    const sim = new Simulator([1, 1, 7], { reactor: 'pbr', fuel: fuel('heu-235-triso') });
    const s = sim.evaluate(Uint8Array.from([BC, HW, FUEL, FUEL, HW, BC, 0]));
    expect(s.cooling).toBe(0);
    const s2 = sim.evaluate(Uint8Array.from([ox, FUEL, HW, BC, 0, 0, 0]));
    expect(s2.validCoolers).toBe(1);
    expect(s2.cooling).toBe(GAS_COOLING_RATES[0]);
    const c = s2.clusters[0];
    expect(s2.hotCoolant['Hot Oxygen']).toBeCloseTo((2 * c.heatingSpeedMultiplier * 60) / 32, 9);
    expect(s2.outputFluidName).toBe('Hot gas');
    expect(s2.rfPerTick).toBeCloseTo(s2.outputFluid * 32, 9);
  });
  it('rejects SFR-only cooler ids', () => {
    const sim = new Simulator([1, 1, 2], { reactor: 'pbr', fuel: fuel('heu-235-triso') });
    expect(() => sim.evaluate(Uint8Array.from([FUEL, COOLER0 + 20]))).toThrow();
  });
  it('layout JSON round-trips chambers, gas coolers, shields and irradiators', () => {
    const grid = Uint8Array.from([gas('helium'), FUEL, BS, IRRADIATOR]);
    const j = toLayoutJSON(grid, [4, 1, 1], 'pbr', 'heu-235-triso', undefined, undefined, 'bismuth');
    expect(j.blocks[0][0]).toEqual(['helium_cooler', 'chamber', 'boron_silver_shield', 'irradiator']);
    expect(j.irradiatorRecipe).toBe('bismuth');
    expect(Array.from(fromLayoutJSON(j))).toEqual(Array.from(grid));
  });
  it('optimizer finds a valid pebble-bed layout', () => {
    const r = optimize({
      reactor: 'pbr', dims: [3, 3, 3], fuelId: 'heu-235-triso', objective: 'output',
      allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: ['beryllium_carbon', 'lead_steel'],
      allowedCoolers: ['oxygen', 'hydrogen', 'helium', 'nitrogen', 'fluorine', 'methane', 'carbon_dioxide', 'ammonia'],
      symmetry: { x: true, y: true, z: true }, timeLimitMs: 2500, seed: 3,
    });
    expect(r.valid).toBe(true);
    expect(r.stats.outputFluid).toBeGreaterThan(0);
    const check = new Simulator([3, 3, 3], { reactor: 'pbr', fuel: fuel('heu-235-triso') }).evaluate(Uint8Array.from(r.grid));
    expect(check.effectiveHeating).toBeCloseTo(r.stats.effectiveHeating, 6);
  }, 20000);
});

describe('decay heat and poisoning (fission_decay_mechanics)', () => {
  it('uses the equilibrium criticality while running and the fresh-fuel criticality at start-up', () => {
    for (const id of ['leu-235-oxide', 'tbu-oxide', 'hecf-251-nitride', 'heu-235-fluoride']) {
      const f = fuel(id);
      const run = new Simulator([1, 1, 1], { reactor: f.reactor, fuel: f, decayMechanics: true });
      expect(run.critInt[0]).toBe(Math.trunc(f.criticality * (1 - f.decayFactor + DECAY_CONFIG.equilibriumFactors[2] * f.decayFactor)));
      const start = new Simulator([1, 1, 1], { reactor: f.reactor, fuel: f, decayMechanics: true, poisonLevel: 0 });
      expect(start.critInt[0]).toBe(Math.trunc(f.criticality * (1 - f.decayFactor)));
    }
  });
  it('reports decay heat and the restart window after a shutdown', () => {
    const f = fuel('heu-235-oxide'); // crit 51, heat 360, decay factor 0.065
    // C HW HW C: flux 72 per cell
    const sim = new Simulator([1, 1, 4], { reactor: 'sfr', fuel: f, decayMechanics: true });
    sim.evaluate(Uint8Array.from([FUEL, HW, HW, FUEL]));
    const r = decayReport(sim);
    expect(r.shutdownHeat).toBe(2 * Math.trunc(360 * 0.065));
    expect(r.fuels[0]).toMatchObject({ startupCriticality: 47, equilibriumCriticality: 51 });
    // iodine decays into poison: the criticality more than doubles before it falls back
    expect(r.fuels[0].peakCriticality).toBeGreaterThan(100);
    expect(r.fuels[0].peakAfterTicks).toBeGreaterThan(0);
    expect(r.restartBlocked).not.toBeNull();
    expect(r.restartBlocked!.fromTicks).toBeGreaterThan(0);
    expect(r.restartBlocked!.toTicks).toBeGreaterThan(r.restartBlocked!.fromTicks);
    // with a large flux margin a restart is always possible
    const easy = new Simulator([1, 1, 4], { reactor: 'sfr', fuel: { ...f, id: 'easy', criticality: 20 }, decayMechanics: true });
    easy.evaluate(Uint8Array.from([FUEL, HW, HW, FUEL]));
    expect(decayReport(easy).restartBlocked).toBeNull();
  });
});

describe('neutron shield shutdown', () => {
  it('detects whether the shields can stop the reactor', () => {
    const f = fuel('heu-235-oxide');
    const sim = new Simulator([1, 1, 5], { reactor: 'sfr', fuel: f });
    expect(shutdownCheck(sim, Uint8Array.from([FUEL, HW, BS, HW, FUEL]))).toEqual({ shields: 1, stillRunning: 0, controllable: true });
    // BC HW C HW BS HW C: the left cell keeps running on its unshielded reflector line
    const sim2 = new Simulator([1, 1, 7], { reactor: 'sfr', fuel: f });
    expect(shutdownCheck(sim2, Uint8Array.from([BC, HW, FUEL, HW, BS, HW, FUEL]))).toEqual({ shields: 1, stillRunning: 1, controllable: false });
  });
  it('the optimizer can require a controllable reactor', () => {
    const r = optimize({
      reactor: 'sfr', dims: [5, 5, 5], fuelId: 'heu-235-oxide', objective: 'output',
      allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: [],
      allowedCoolers: ['water', 'iron', 'redstone', 'quartz', 'lapis', 'gold', 'diamond', 'emerald', 'glowstone', 'obsidian', 'tin', 'copper'],
      allowedShields: ['boron_silver'], controllable: true, symmetry: { x: true, y: true, z: true }, timeLimitMs: 4000, seed: 5,
    });
    expect(r.valid).toBe(true);
    const sim = new Simulator([5, 5, 5], { reactor: 'sfr', fuel: fuel('heu-235-oxide') });
    expect(shutdownCheck(sim, Uint8Array.from(r.grid)).controllable).toBe(true);
  }, 30000);
  it('the irradiation objective feeds flux into irradiators', () => {
    const r = optimize({
      reactor: 'sfr', dims: [5, 5, 5], fuelId: 'heu-235-oxide', objective: 'irradiation',
      allowedModerators: ['graphite', 'beryllium', 'heavy_water'], allowedReflectors: ['beryllium_carbon'],
      allowedCoolers: ['water', 'iron', 'redstone', 'quartz', 'lapis', 'gold', 'diamond', 'emerald', 'glowstone', 'obsidian', 'tin', 'copper'],
      allowIrradiators: true, symmetry: { x: true, y: true, z: true }, timeLimitMs: 4000, seed: 5,
    });
    expect(r.valid).toBe(true);
    expect(r.stats.irradiatorFlux).toBeGreaterThan(0);
  }, 30000);
});
