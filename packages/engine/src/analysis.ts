/** Per-block explanations, neutron source planning, shutdown and decay analysis on top of the simulator state. */
import { Simulator, DIR_NAMES, DIRS, opposite, ReactorStats, LINE_FUEL, LINE_REFLECTOR, LINE_IRRADIATOR } from './simulator.js';
import { COOLER0, CONDUCTOR, AIR, SHIELD0, isModerator, isReflector, isFuel, isCooler, isShield, isIrradiator, MOD0, REFL0, blockKey, blockName } from './blocks.js';
import { MODERATORS, REFLECTORS, SHIELDS, SOURCES, DECAY_CONFIG } from './components.js';
import { adjacentSatisfied } from './rules.js';

export interface LineInfo {
  dir: string; kind: 'fuel' | 'reflector' | 'irradiator'; length: number; flux: number; efficiency: number; partner: [number, number, number]; incoming: boolean;
  /** Direct line to a face-adjacent component carrying only intrinsic flux (no moderators). */
  intrinsic: boolean;
}
export interface BlockInfo {
  index: number;
  pos: [number, number, number];
  block: number;
  key: string;
  name: string;
  category: 'air' | 'fuel' | 'moderator' | 'reflector' | 'conductor' | 'cooler' | 'shield' | 'irradiator';
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
  shield?: {
    functional: boolean; failed: boolean; flux: number; heatPerFlux: number; efficiency: number; rawHeating: number; effectiveHeating: number;
    /** flux contribution of the complete line along each axis */
    axes: { axis: 'x' | 'y' | 'z'; flux: number }[];
  };
  irradiator?: { flux: number; recipe: string; itemsPerHour: number; lines: number; heatPerFlux: number; efficiency: number };
  notes: string[];
}

const AXIS_NAMES = ['y', 'z', 'x'] as const; // DIRS axis order: down/up, north/south, west/east

export function explainBlock(sim: Simulator, i: number): BlockInfo {
  const b = sim.grid[i];
  const reactor = sim.opts.reactor;
  const pos = sim.coords(i);
  const info: BlockInfo = {
    index: i, pos, block: b, key: blockKey(b, reactor), name: blockName(b, reactor),
    category: b === AIR ? 'air' : isFuel(b) ? 'fuel' : isModerator(b) ? 'moderator' : isReflector(b) ? 'reflector' : b === CONDUCTOR ? 'conductor'
      : isShield(b) ? 'shield' : isIrradiator(b) ? 'irradiator' : 'cooler',
    active: false, cluster: sim.cluster[i], notes: [],
  };
  if (isFuel(b)) {
    const fuelDef = sim.fuelAt(i);
    const bunch = sim.bunchOf[i];
    const running = sim.running[i] === 1;
    const lines: LineInfo[] = [];
    for (let d = 0; d < 6; d++) {
      const li = i * 6 + d;
      const intrinsic = sim.lineLen[li] === 0;
      if (sim.lineType[li] === LINE_FUEL) {
        const t = sim.lineTarget[li];
        // incoming line from the partner (what actually counts for this component)
        const back = t * 6 + opposite(d);
        lines.push({ dir: DIR_NAMES[d], kind: 'fuel', length: sim.lineLen[li], flux: sim.lineFlux[back] || sim.lineFlux[li], efficiency: sim.lineEff[li], partner: sim.coords(t), incoming: sim.running[t] === 1, intrinsic });
      } else if (sim.lineType[li] === LINE_REFLECTOR || sim.lineType[li] === LINE_IRRADIATOR) {
        lines.push({
          dir: DIR_NAMES[d], kind: sim.lineType[li] === LINE_REFLECTOR ? 'reflector' : 'irradiator', length: sim.lineLen[li], flux: sim.lineFlux[li],
          efficiency: sim.lineEff[li], partner: sim.coords(sim.lineTarget[li]), incoming: running, intrinsic,
        });
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
    info.cooler = { valid: info.active, failedRecheck: sim.failed[i] === 1, rule: rule.text, cooling: sim.rates[t], conditions };
    if (!info.active) info.notes.push(sim.failed[i] ? 'Failed the exact/at-most rule recheck.' : `Placement rule "${rule.text}" is not satisfied.`);
  } else if (isShield(b)) {
    const sh = SHIELDS[b - SHIELD0];
    const flux = sim.shieldFlux(i);
    info.active = sim.shieldFunc[i] === 1;
    const axes = AXIS_NAMES.map((axis, k) => ({ axis, flux: sim.shieldAxis[i * 3 + k] })).filter((_, k) => sim.shieldAxis[i * 3 + k] > 0 || info.active);
    info.shield = {
      functional: info.active, failed: sim.shieldFail[i] === 1, flux, heatPerFlux: sh.heatPerFlux, efficiency: sh.efficiency,
      rawHeating: info.active ? Math.floor(flux * sh.heatPerFlux) : 0, effectiveHeating: info.active ? flux * sh.heatPerFlux * sh.efficiency : 0,
      axes: info.active ? axes : [],
    };
    if (sim.opts.shieldsOn) info.notes.push('Shielding: blocks every moderator line through it.');
    else if (info.active) info.notes.push(`In a complete moderator line: passes neutrons (flux factor 0, efficiency ${sh.efficiency}) and turns ${sh.heatPerFlux} H/t per flux into heat that its cluster must cool. Switching the shield manager on blocks the line.`);
    else info.notes.push(sim.shieldFail[i]
      ? 'Its moderator lines end at an inactive fuel component / irradiator: the shield is in the component fail cache and blocks them.'
      : 'Not part of a complete moderator line between running fuel components / reflectors / irradiators.');
  } else if (isIrradiator(b)) {
    const r = sim.irradiator;
    const flux = sim.irrFlux[i];
    info.active = flux > 0;
    let lines = 0;
    for (let k = 0; k < sim.fuelCount; k++) {
      const f = sim.fuelList[k];
      if (!sim.running[f]) continue;
      for (let d = 0; d < 6; d++) if (sim.lineType[f * 6 + d] === LINE_IRRADIATOR && sim.lineTarget[f * 6 + d] === i) lines++;
    }
    info.irradiator = { flux, recipe: r.name, itemsPerHour: (72000 * flux) / r.fluxPerItem, lines, heatPerFlux: r.heatPerFlux, efficiency: r.efficiency };
    info.notes.push(info.active
      ? `Receives ${flux} flux from ${lines} moderator line(s): ${r.fluxPerItem.toLocaleString('en-US')} flux per item (${r.name}). Each line adds a heat multiplier to its fuel component, with line efficiency × ${r.efficiency}.`
      : 'No moderator line from a running fuel component ends here (lines need at least one moderator, or intrinsic flux from an adjacent fuel component).');
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
        // IFissionComponent.isNullifyingSources: irradiators (with inputs) and shielding shields block the ray
        if (isIrradiator(b) || (isShield(b) && sim.opts.shieldsOn)) break;
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

// ------------------------------------------------------------------ shutdown with neutron shields
export interface ShutdownCheck {
  /** Shields in the layout */
  shields: number;
  /** Fuel components still running with every shield shielding */
  stillRunning: number;
  /** True if switching the shields on stops every fuel component */
  controllable: boolean;
}

/**
 * Switches every neutron shield on (FissionReactorLogic.onShieldUpdated -> refresh): the running components stay
 * primed (isInitiallyPrimed = functional) and keep running only if they still reach criticality without the
 * shielded lines.
 */
export function shutdownCheck(sim: Simulator, grid: Uint8Array): ShutdownCheck {
  const stats = sim.evaluate(grid);
  const primed: { index: number; efficiency: number }[] = [];
  for (let i = 0; i < sim.N; i++) if (sim.running[i]) primed.push({ index: i, efficiency: sim.srcEff[i] });
  const on = new Simulator([sim.X, sim.Y, sim.Z], { ...sim.opts, shieldsOn: true, primed });
  const s = on.evaluate(grid);
  return { shields: stats.shields, stillRunning: s.runningFuelComponents, controllable: stats.shields > 0 && s.runningFuelComponents === 0 };
}

// ------------------------------------------------------------------ decay heat and neutron poisoning
export interface DecayFuelReport {
  fuelId: string;
  name: string;
  decayFactor: number;
  /** getCriticality with fresh fuel (no poison yet) */
  startupCriticality: number;
  /** getCriticality at the running equilibrium (what the steady state uses) */
  equilibriumCriticality: number;
  /** highest criticality after a shutdown from equilibrium (iodine decaying into poison) and when it occurs */
  peakCriticality: number;
  peakAfterTicks: number;
}
export interface DecayReport {
  fuels: DecayFuelReport[];
  /** Decay heat right after a shutdown from equilibrium (H/t), total and per cluster with the cluster's cooling */
  shutdownHeat: number;
  clusters: { id: number; decayHeat: number; cooling: number }[];
  /** Ticks until the decay heat falls below 1% of its initial value */
  decayHeatTicks: number;
  /**
   * Restarting after a shutdown: ticks after the shutdown during which some running fuel component would not reach
   * its (poisoned) criticality with the layout's flux, or null if a restart is always possible.
   */
  restartBlocked: { fromTicks: number; toTicks: number } | null;
}

/** One tick of TileSolidFissionCell / TileSaltFissionVessel.updateDecayFractions for a component that is not processing. */
function decayTick(s: { heat: number; iodine: number; poison: number }, d: number) {
  const C = DECAY_CONFIG, [m0, m1] = C.termMultipliers;
  const eqH = C.equilibriumFactors[0] * d, eqI = C.equilibriumFactors[1] * d, eqP = C.equilibriumFactors[2] * d;
  const redH = Math.min(s.heat, (m0 * s.heat + m1 * eqH) / C.lifetimes[0]);
  s.heat = Math.max(0, s.heat - redH);
  const redI = Math.min(s.iodine, (m0 * s.iodine + m1 * eqI) / C.lifetimes[1]);
  s.iodine = Math.max(0, s.iodine - redI + C.daughterMultipliers[0] * redH);
  const redP = Math.min(s.poison, (m0 * s.poison + m1 * eqP) / C.lifetimes[2]);
  s.poison = Math.max(0, s.poison - redP + C.daughterMultipliers[1] * redI);
}

/**
 * Decay heat and poisoning (fission_decay_mechanics) for the simulator's current state, which must have been evaluated
 * with decayMechanics on. While running, decay heat is zero and the poison sits at its equilibrium, so the steady state
 * itself is unchanged; after a shutdown the fuel keeps producing decay heat and iodine decays into poison, which raises
 * the criticality before it falls back.
 */
export function decayReport(sim: Simulator, horizonTicks = 72000 * 3): DecayReport {
  const C = DECAY_CONFIG;
  const slots = sim.fuels.length;
  // per fuel slot: criticality and decay-heat fraction over time after a shutdown (one sample per 20 ticks)
  const step = 20, samples = Math.ceil(horizonTicks / step) + 1;
  const crit: Float64Array[] = [], heatFrac: Float64Array[] = [];
  const fuels: DecayFuelReport[] = sim.fuels.map((f, k) => {
    const d = f.decayFactor;
    const s = { heat: C.equilibriumFactors[0] * d, iodine: C.equilibriumFactors[1] * d, poison: C.equilibriumFactors[2] * d };
    const cs = new Float64Array(samples), hs = new Float64Array(samples);
    let peak = 0, peakAt = 0;
    for (let t = 0, n = 0; n < samples; t++) {
      if (t % step === 0) {
        const c = Math.trunc(f.criticality * (1 - d + s.poison));
        cs[n] = c; hs[n] = s.heat; n++;
        if (c > peak) { peak = c; peakAt = t; }
      }
      decayTick(s, d);
    }
    crit[k] = cs; heatFrac[k] = hs;
    return {
      fuelId: f.id, name: f.name, decayFactor: d,
      startupCriticality: Math.trunc(f.criticality * (1 - d)), equilibriumCriticality: sim.critInt[k],
      peakCriticality: peak, peakAfterTicks: peakAt,
    };
  });
  // decay heat right after the shutdown: bunching factor × Σ toInt(base heat × decay-heat fraction) of running members
  const clusters = new Map<number, { id: number; decayHeat: number; cooling: number }>();
  let total = 0;
  for (let b = 0; b < sim.bunchCount; b++) {
    if (!sim.bunchEmit[b]) continue;
    const k = sim.bunchSlot(b), f = sim.fuels[k];
    let h = 0, c = -1;
    for (let q = sim.memberStart[b]; q < sim.memberStart[b + 1]; q++) {
      const i = sim.memberList[q];
      if (!sim.running[i]) continue;
      h += Math.trunc(f.heat * heatFrac[k][0]);
      c = sim.cluster[i];
    }
    h *= sim.bunchingFactor(b);
    total += h;
    if (c >= 0) {
      const e = clusters.get(c) ?? { id: c, decayHeat: 0, cooling: sim.stats.clusters[c].cooling };
      e.decayHeat += h; clusters.set(c, e);
    }
  }
  let decayHeatTicks = 0;
  for (let k = 0; k < slots; k++) {
    const h0 = heatFrac[k][0];
    let n = 0; while (n < samples - 1 && heatFrac[k][n] > 0.01 * h0) n++;
    decayHeatTicks = Math.max(decayHeatTicks, n * step);
  }
  // restart window: every running bunch needs flux >= surface factor × criticality(t), i.e. criticality(t) <= flux / surface factor
  const maxCrit = new Array<number>(slots).fill(Infinity);
  for (let b = 0; b < sim.bunchCount; b++) {
    if (!sim.bunchEmit[b]) continue;
    const k = sim.bunchSlot(b);
    maxCrit[k] = Math.min(maxCrit[k], sim.bunchFlux[b] / sim.surfaceFactor(b));
  }
  let from = -1, to = -1;
  for (let n = 0; n < samples; n++) {
    let ok = true;
    for (let k = 0; k < slots && ok; k++) if (crit[k][n] > maxCrit[k]) ok = false;
    if (!ok) { if (from < 0) from = n * step; to = n * step; }
  }
  return {
    fuels, shutdownHeat: total, clusters: [...clusters.values()].sort((a, b) => a.id - b.id), decayHeatTicks,
    restartBlocked: from < 0 ? null : { fromTicks: from, toTicks: to + step },
  };
}
