import { describe, it, expect } from 'vitest';
import { simulateTurbine, optimizeTurbine, evaluateWall, blankWall, reactorSteam, W_COIL0, W_CONNECTOR, W_EMPTY, type TurbineDesign } from '../src/index.ts';

const MG = W_COIL0, BE = W_COIL0 + 1, AL = W_COIL0 + 2, AU = W_COIL0 + 3, CU = W_COIL0 + 4, AG = W_COIL0 + 5;

describe('turbine dynamo coils', () => {
  it('validates coil chains from the bearings (least fixed point)', () => {
    // 5x5 wall, sw=1, bearing at (2,2)
    const w = blankWall(5, 1);
    const set = (x: number, y: number, c: number) => { w[x + 5 * y] = c; };
    set(1, 2, MG); set(3, 2, MG); // both touch the bearing
    set(2, 1, AL);               // touches the bearing only -> needs two magnesium -> invalid
    set(1, 1, BE);               // next to magnesium (1,2) -> valid
    set(0, 1, CU);               // next to beryllium -> valid
    set(0, 0 + 2, AG);           // (0,2): next to Mg(1,2) and Cu? (0,1) yes, gold missing -> invalid
    const r = evaluateWall(5, 1, w);
    expect(r.valid[1 + 5 * 2]).toBe(1);
    expect(r.valid[2 + 5 * 1]).toBe(0);
    expect(r.valid[1 + 5 * 1]).toBe(1);
    expect(r.valid[0 + 5 * 1]).toBe(1);
    expect(r.valid[0 + 5 * 2]).toBe(0);
    expect(r.coils).toBe(4);
    expect(r.conductivity).toBeCloseTo((0.88 * 2 + 0.9 + 1.06) / 4, 12);
  });
  it('connectors extend the network and do not count as coils', () => {
    const w = blankWall(5, 1);
    w[1 + 5 * 2] = MG; w[0 + 5 * 2] = W_CONNECTOR; w[0 + 5 * 3] = MG; // Mg (0,3) valid via connector
    const r = evaluateWall(5, 1, w);
    expect(r.coils).toBe(2); expect(r.connectors).toBe(1);
    w[1 + 5 * 2] = W_EMPTY; // nothing touches the bearing -> everything invalid
    expect(evaluateWall(5, 1, w).coils).toBe(0);
  });
  it('dilutes conductivity when there are fewer coils than sw^2', () => {
    const w = blankWall(6, 2); // bearings at (2..3, 2..3)
    w[1 + 6 * 2] = MG;
    expect(evaluateWall(6, 2, w).conductivity).toBeCloseTo(0.88 / 4, 12);
  });
  void AL; void AU; void AG;
});

describe('turbine simulation', () => {
  it('matches the TurbineLogic formulas for a 3x3x1 steel turbine', () => {
    const wall = Array.from(blankWall(3, 1)); wall[1 + 3 * 0] = MG; // (1,0) touches bearing (1,1)
    const d: TurbineDesign = { diameter: 3, shaftWidth: 1, blades: ['steel'], walls: [wall, wall], fluidId: 'high_pressure_steam' };
    const s = simulateTurbine(d, 300);
    expect(s.bladeArea).toBe(4);
    expect(s.maxInputRate).toBe(400);
    expect(s.rotorEfficiency).toBeCloseTo(Math.sqrt(1.4) / 2, 12); // ideal 4^(0.5)=2 vs actual sqrt(1.4)
    expect(s.expansionIdeality).toBeCloseTo(1.4 / 4, 12);
    expect(s.conductivity).toBeCloseTo(0.88, 12);
    expect(s.effectiveMaxLength).toBe(24);
    // throughput: effMinLength = ceil(ln4/ln1.4) = 5 -> leniency 5*4*100 = 2000 -> ratio 1
    expect(s.throughputEfficiency).toBe(1);
    const lb = 300 / (100 * 4 * 24), ab = Math.sqrt((2 * 300) / (100 * 1 * 24 * 24));
    expect(s.powerBonus).toBeCloseTo(1 + Math.pow(lb * ab, 2 / 3), 12);
    expect(s.power).toBeCloseTo(300 * 16 * 0.88 * (Math.sqrt(1.4) / 2) * 0.35 * s.powerBonus, 9);
    expect(simulateTurbine(d, 500).overloaded).toBe(true);
  });
  it('optimizer returns a feasible design that re-simulates identically', () => {
    const r = optimizeTurbine({ steamRate: 4000, coilIterations: 20000 });
    const s = r.best.stats;
    expect(s.valid).toBe(true);
    expect(s.safeInputRate).toBeGreaterThanOrEqual(4000);
    expect(s.rotorEfficiency * s.expansionIdeality).toBeGreaterThan(1.0);
    expect(s.conductivity).toBeGreaterThan(0.98);
    expect(simulateTurbine(r.best.design, 4000).power).toBeCloseTo(s.power, 9);
    expect(s.powerPerMB).toBeGreaterThan(16);
  }, 20000);
  it('splits very large steam flows across several turbines', () => {
    const r = optimizeTurbine({ steamRate: 30000, maxDiameter: 5, maxLength: 8, coilIterations: 5000 });
    expect(r.turbines).toBeGreaterThan(1);
    expect(r.best.stats.overloaded).toBe(false);
  }, 20000);
  it('converts reactor output to steam', () => {
    expect(reactorSteam({ reactor: 'sfr', outputFluid: 123, hotCoolant: {} })).toBe(123);
    // MSR: 1 mB/t hot NaK = 128*2 H -> 4 mB water -> 16 mB HP steam
    expect(reactorSteam({ reactor: 'msr', outputFluid: 0, hotCoolant: { NaK: 1 } })).toBeCloseTo(16, 12);
  });
});
