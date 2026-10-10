import { describe, it, expect } from 'vitest';
import { simulateHX, designHeatExchanger, buildCrossflowLayout, HX_TUBES, reactorSteam } from '../src/index.ts';

describe('heat exchanger', () => {
  it('cross-flow layout: contraflow, upward bonus, exact heat balance', () => {
    const l = buildCrossflowLayout([3, 2, 2], [{ y: 0, z: 0, coolant: 'NaK' }, { y: 1, z: 0, coolant: 'NaK' }], 2, 'water', { NaK: 1e9 });
    const s = simulateHX(l);
    expect(s.valid).toBe(true);
    expect(s.networks).toHaveLength(2);
    for (const n of s.networks) {
      expect(n.usefulTubes).toBe(3);
      expect(n.contraflow).toBe(true);
      expect(n.meanTempDiff).toBe(150); // ((800-600) + (400-300)) / 2
      expect(n.shellDirMult).toBe(1.5);
      expect(n.capacity).toBeCloseTo(150 * 1.5 * 3 * 32, 6);
    }
    // supply-limited: 10 mB/t hot NaK -> 2560 heat -> 40 mB water -> 160 mB steam (thermoconducting, retention 1)
    const l2 = buildCrossflowLayout([3, 1, 1], [{ y: 0, z: 0, coolant: 'NaK' }], 2, 'water', { NaK: 10 });
    const s2 = simulateHX(l2);
    expect(s2.networks[0].tubeInput).toBeCloseTo(10, 9);
    expect(s2.shellOutput).toBeCloseTo(160, 9);
  });
  it('parallel flow is rejected (temperature cross)', () => {
    const l = buildCrossflowLayout([3, 1, 1], [{ y: 0, z: 0, coolant: 'NaK' }], 0, 'water', { NaK: 10 });
    // swap the tube inlet/outlet so the coolant flows towards +X, with the shell flow
    for (const p of l.ports) if (p.label === 'NaK') p.kind = p.kind === 'inlet' ? 'outlet' : 'inlet';
    const west = l.ports.find((p) => p.label === 'NaK' && p.kind === 'inlet')!; west.recipe = 'hot_nak'; west.supply = 10;
    const s = simulateHX(l);
    expect(s.valid).toBe(true);
    expect(s.networks[0].contraflow).toBe(false);
    expect(s.networks[0].tubeHeat).toBe(0);
  });
  it('structure validation', () => {
    const l = buildCrossflowLayout([2, 1, 1], [{ y: 0, z: 0, coolant: 'NaK' }], 0, 'water', { NaK: 1 });
    const dangling = { ...l, settings: Uint8Array.from(l.settings) }; dangling.settings[1] = 1; // open UP face of the first tube
    expect(simulateHX(dangling).error).toMatch(/dangling/);
    expect(simulateHX({ ...l, ports: l.ports.filter((p) => p.label !== 'shell' || p.kind === 'inlet') }).error).toMatch(/Shell/);
  });
  it('designer covers every coolant; thermoconducting matches the lossless estimate', () => {
    const hot = { NaK: 300, 'Iron-NaK': 75 };
    const r = designHeatExchanger({ hotCoolant: hot });
    for (const d of [r.best, ...r.alternatives]) {
      for (const c of d.coolants) expect(c.processed).toBeGreaterThanOrEqual(c.supply - 1e-6);
      const t = HX_TUBES.find((x) => x.id === d.tubeType)!;
      expect(d.steam).toBeCloseTo(r.idealSteam * t.retention, 6);
    }
    expect(r.best.tubeType).toBe('thermoconducting');
    expect(r.idealSteam).toBeCloseTo(reactorSteam({ reactor: 'msr', outputFluid: 0, hotCoolant: hot }), 6);
  });
});
