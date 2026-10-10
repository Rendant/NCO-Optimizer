/** Per-block explanations and neutron source planning on top of the simulator state. */
import { Simulator, DIR_NAMES, DIRS, opposite, ReactorStats } from './simulator.js';
import { COOLER0, CONDUCTOR, AIR, isModerator, isReflector, isFuel, isCooler, MOD0, REFL0, blockKey, blockName } from './blocks.js';
import { MODERATORS, REFLECTORS, COOLING_RATES, SOURCES } from './components.js';
import { adjacentSatisfied } from './rules.js';

export interface LineInfo { dir: string; kind: 'fuel' | 'reflector'; length: number; flux: number; efficiency: number; partner: [number, number, number]; incoming: boolean }
export interface BlockInfo {
  index: number;
  pos: [number, number, number];
  block: number;
  key: string;
  name: string;
  category: 'air' | 'fuel' | 'moderator' | 'reflector' | 'conductor' | 'cooler';
  active: boolean;
  cluster: number;
  fuel?: {
    fuelId: string; fuelName: string;
    running: boolean; primed: boolean; flux: number; criticalityThreshold: number; heatMult: number; efficiency: number;
    moderatorEfficiencyFactor: number; fluxEfficiencyFactor: number; sourceEfficiency: number; rawHeating: number; effectiveHeating: number;
    bunch: { id: number; size: number; surfaceFactor: number; bunchingFactor: number; flux: number };
    lines: LineInfo[];
  };
  moderator?: { state: 'active' | 'passive' | 'unused'; fluxFactor: number; efficiency: number };
  reflector?: { active: boolean; efficiency: number; reflectivity: number };
  cooler?: { valid: boolean; failedRecheck: boolean; rule: string; cooling: number; conditions: { text: string; ok: boolean; matches: number }[] };
  notes: string[];
}

export function explainBlock(sim: Simulator, i: number): BlockInfo {
  const b = sim.grid[i];
  const reactor = sim.opts.reactor;
  const pos = sim.coords(i);
  const info: BlockInfo = {
    index: i, pos, block: b, key: blockKey(b, reactor), name: blockName(b, reactor),
    category: b === AIR ? 'air' : isFuel(b) ? 'fuel' : isModerator(b) ? 'moderator' : isReflector(b) ? 'reflector' : b === CONDUCTOR ? 'conductor' : 'cooler',
    active: false, cluster: sim.cluster[i], notes: [],
  };
  if (isFuel(b)) {
    const fuelDef = sim.fuelAt(i);
    const bunch = sim.bunchOf[i];
    const running = sim.running[i] === 1;
    const lines: LineInfo[] = [];
    for (let d = 0; d < 6; d++) {
      const li = i * 6 + d;
      if (sim.lineType[li] === 1) {
        const t = sim.lineTarget[li];
        // incoming line from the partner (what actually counts for this component)
        const back = t * 6 + opposite(d);
        lines.push({ dir: DIR_NAMES[d], kind: 'fuel', length: sim.lineLen[li], flux: sim.lineFlux[back] || sim.lineFlux[li], efficiency: sim.lineEff[li], partner: sim.coords(t), incoming: sim.running[t] === 1 });
      } else if (sim.lineType[li] === 2) {
        lines.push({ dir: DIR_NAMES[d], kind: 'reflector', length: sim.lineLen[li], flux: sim.lineFlux[li], efficiency: sim.lineEff[li], partner: sim.coords(sim.lineTarget[li]), incoming: running });
      }
    }
    const fluxEff = running ? sim.fluxEfficiencyFactor(bunch) : 0;
    const raw = running ? (fuelDef.heat * sim.bunchHeatMult(bunch)) / sim.bunchSize[bunch] : 0;
    const eff = sim.fuelEfficiency(i);
    info.active = running;
    info.fuel = {
      fuelId: fuelDef.id, fuelName: fuelDef.name,
      running, primed: sim.bunchPrimed[bunch] === 1, flux: sim.bunchFlux[bunch], criticalityThreshold: sim.criticalityThreshold(bunch),
      heatMult: running ? sim.bunchHeatMult(bunch) / sim.bunchSize[bunch] : 0, efficiency: eff,
      moderatorEfficiencyFactor: sim.moderatorEfficiencyFactor(i), fluxEfficiencyFactor: fluxEff, sourceEfficiency: sim.srcEff[i],
      rawHeating: raw, effectiveHeating: fuelDef.heat * eff,
      bunch: { id: bunch, size: sim.bunchSize[bunch], surfaceFactor: sim.surfaceFactor(bunch), bunchingFactor: sim.bunchingFactor(bunch), flux: sim.bunchFlux[bunch] },
      lines,
    };
    if (!running) {
      info.notes.push(lines.length === 0
        ? 'No moderator line reaches this component: it receives no neutron flux.'
        : `Flux ${sim.bunchFlux[bunch]} is below the criticality threshold ${sim.criticalityThreshold(bunch)}.`);
    } else {
      if (fluxEff < 0.95) info.notes.push(`Flux ${sim.bunchFlux[bunch]} is close to/above 2× criticality, reducing efficiency (×${fluxEff.toFixed(3)}).`);
      if (sim.clusterWall[sim.cluster[i]] === 0 && reactor === 'sfr') info.notes.push('This cluster does not touch the casing, so its heat is not used.');
    }
  } else if (isModerator(b)) {
    const m = MODERATORS[b - MOD0];
    const state = sim.modState[i] === 2 ? 'active' : sim.modState[i] === 1 ? 'passive' : 'unused';
    info.active = state !== 'unused';
    info.moderator = { state, fluxFactor: m.fluxFactor, efficiency: m.efficiency };
    if (state === 'unused') info.notes.push('Not part of a complete moderator line between running fuel components / reflectors.');
    if (state === 'active') info.notes.push('Adjacent to a running fuel component at the end of a complete line: satisfies "moderator" placement rules.');
  } else if (isReflector(b)) {
    const r = REFLECTORS[b - REFL0];
    info.active = sim.reflActive[i] === 1;
    info.reflector = { active: info.active, efficiency: r.efficiency, reflectivity: r.reflectivity };
    if (!info.active) info.notes.push('Reflectors need a running fuel component 1-2 moderators away along a straight line.');
  } else if (isCooler(b)) {
    const t = b - COOLER0;
    const rule = sim.rules[t];
    const conditions = rule.subs.map((s) => {
      const mask = sim.satisfiedMask(i, s);
      let matches = 0; for (let d = 0; d < 6; d++) if ((mask >> d) & 1) matches++;
      return { text: s.text, ok: adjacentSatisfied(s, mask), matches };
    });
    info.active = sim.valid[i] === 1;
    info.cooler = { valid: info.active, failedRecheck: sim.failed[i] === 1, rule: rule.text, cooling: COOLING_RATES[t], conditions };
    if (!info.active) info.notes.push(sim.failed[i] ? 'Failed the exact/at-most rule recheck.' : `Placement rule "${rule.text}" is not satisfied.`);
  } else if (b === CONDUCTOR) {
    info.active = sim.cluster[i] >= 0;
    info.notes.push(info.active ? 'Connects heat between components of its cluster and the casing.' : 'Not connected to any functional component.');
  }
  return info;
}

export function explainAll(sim: Simulator): BlockInfo[] {
  const out: BlockInfo[] = [];
  for (let i = 0; i < sim.N; i++) out.push(explainBlock(sim, i));
  return out;
}

// ------------------------------------------------------------------ neutron sources
export interface SourcePlacement {
  /** wall position, interior coordinates extended by one (e.g. x = -1 or x = X) */
  wall: [number, number, number];
  /** facing of the source (towards the interior) */
  facing: string;
  target: [number, number, number];
  targetIndex: number;
}
export interface SourcePlan {
  needed: boolean;
  selfPriming: boolean;
  sourceType: string;
  sources: SourcePlacement[];
  fullyPrimed: boolean;
  unprimedRunning: number;
  stats: ReactorStats;
}

/** All wall positions with a clear ray to a fuel component (TileFissionSource.getPrimingTarget). */
export function sourceCandidates(sim: Simulator): SourcePlacement[] {
  const out: SourcePlacement[] = [];
  const { X, Y, Z } = sim;
  const dims = [X, Y, Z];
  for (let d = 0; d < 6; d++) {
    const [dx, dy, dz] = DIRS[d]; // ray direction into the interior
    const axis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
    const start = DIRS[d][axis] > 0 ? 0 : dims[axis] - 1;
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (let u = 0; u < dims[others[0]]; u++) for (let v = 0; v < dims[others[1]]; v++) {
      const p = [0, 0, 0]; p[axis] = start; p[others[0]] = u; p[others[1]] = v;
      const wall: [number, number, number] = [p[0] - dx, p[1] - dy, p[2] - dz];
      let [x, y, z] = p;
      while (x >= 0 && y >= 0 && z >= 0 && x < X && y < Y && z < Z) {
        const i = sim.index(x, y, z), b = sim.grid[i];
        if (isReflector(b) && REFLECTORS[b - REFL0].reflectivity >= 1) break;
        if (isFuel(b)) { out.push({ wall, facing: DIR_NAMES[d], target: [x, y, z], targetIndex: i }); break; }
        x += dx; y += dy; z += dz;
      }
    }
  }
  return out;
}

/**
 * Greedy minimal neutron-source plan that reproduces the "all primed" steady state, then re-simulates
 * with the chosen source efficiency applied to every primed fuel component.
 */
export function planSources(sim: Simulator, grid: Uint8Array, sourceTypeId = 'californium'): SourcePlan {
  const src = SOURCES.find((s) => s.id === sourceTypeId) ?? SOURCES[2];
  const ref = sim.evaluate(grid);
  const target = new Uint8Array(sim.running);
  const targetCount = target.reduce((a, v) => a + v, 0);
  // self-priming fuels need no source: only running components of other fuels are targets
  for (let i = 0; i < sim.N; i++) if (target[i] && sim.fuelAt(i).selfPriming) target[i] = 0;
  const allSelf = sim.fuels.every((f) => f.selfPriming);
  if (allSelf || target.reduce((a, v) => a + v, 0) === 0) {
    return { needed: false, selfPriming: allSelf || targetCount > 0, sourceType: src.id, sources: [], fullyPrimed: true, unprimedRunning: 0, stats: ref };
  }
  const targetCountNS = target.reduce((a, v) => a + v, 0);
  const cands = sourceCandidates(sim).filter((c) => target[c.targetIndex]);
  const probe = new Simulator([sim.X, sim.Y, sim.Z], { ...sim.opts, primed: [] });
  const chosen: SourcePlacement[] = [];
  const usedWalls = new Set<string>();
  const runCount = (list: SourcePlacement[]) => {
    probe.opts.primed = list.map((c) => ({ index: c.targetIndex, efficiency: src.efficiency }));
    probe.evaluate(grid);
    let n = 0; for (let i = 0; i < sim.N; i++) if (target[i] && probe.running[i]) n++;
    return n;
  };
  let current = runCount(chosen);
  while (current < targetCountNS) {
    let best: SourcePlacement | null = null, bestN = current;
    const seenTargets = new Map<number, number>();
    for (const c of cands) {
      const k = c.wall.join(',');
      if (usedWalls.has(k)) continue;
      // prefer distinct targets (needed for bunches); evaluate each target once
      const prevCount = chosen.filter((s) => s.targetIndex === c.targetIndex).length;
      const key = c.targetIndex * 64 + prevCount;
      if (seenTargets.has(key)) continue;
      const n = runCount([...chosen, c]);
      seenTargets.set(key, n);
      if (n > bestN) { bestN = n; best = c; }
    }
    if (!best) {
      // a bunch may need several sources before anything happens: add the candidate targeting the
      // not-yet-running component with the fewest sources already
      best = cands.find((c) => !usedWalls.has(c.wall.join(',')) && !probe.running[c.targetIndex]) ?? null;
      if (!best) break;
      chosen.push(best); usedWalls.add(best.wall.join(','));
      const n = runCount(chosen);
      if (n <= current && chosen.length > 3 * targetCountNS) break;
      current = n;
      continue;
    }
    chosen.push(best); usedWalls.add(best.wall.join(',')); current = bestN;
  }
  // prune redundant sources
  for (let k = chosen.length - 1; k >= 0; k--) {
    const without = chosen.filter((_, j) => j !== k);
    if (runCount(without) >= current) chosen.splice(k, 1);
  }
  probe.opts.primed = chosen.map((c) => ({ index: c.targetIndex, efficiency: src.efficiency }));
  const stats = probe.evaluate(grid);
  return { needed: true, selfPriming: false, sourceType: src.id, sources: chosen, fullyPrimed: current >= targetCountNS, unprimedRunning: targetCountNS - current, stats };
}
