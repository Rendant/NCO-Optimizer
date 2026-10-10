/**
 * Layout optimizer: simulated annealing over symmetry orbits using the exact simulator as the
 * fitness function, seeded by constructive lattice layouts, followed by a greedy polish pass and a
 * cleanup pass that turns useless blocks into air.
 *
 * Structural proposals (anything touching fuel, moderators or reflectors) are compound moves: the
 * change is followed by a greedy cooler repair (air / invalid coolers -> best valid cooler, until the
 * excess heat is covered), and the pair is accepted or rejected as one move. The simulator caches the
 * neutronics phase, so cooler-only evaluations are cheaper than structural ones.
 */
import { Simulator, ReactorStats } from './simulator.js';
import { FUELS, FuelDef, ReactorType, COOLER_NAMES, HEATER_NAMES, MODERATORS, REFLECTORS, COOLING_RATES, FISSION_CONFIG } from './components.js';
import { AIR, FUEL, MOD0, REFL0, CONDUCTOR, COOLER0, isCooler, isModerator, isReflector } from './blocks.js';

const ENV = (globalThis as any).process?.env ?? {};
const PORTF = Number(ENV.PORTF ?? 8), PORT_FRAC = Number(ENV.PORT_FRAC ?? 0.6), REHEAT = Number(ENV.REHEAT ?? 0.3);
const P_REPAIR = Number(ENV.P_REPAIR ?? 1), REPAIR_FULL = Number(ENV.REPAIR_FULL ?? -1);
const P_RANDOM = Number(ENV.P_RANDOM ?? 0.45), P_SMART = Number(ENV.P_SMART ?? 0.72), P_LINE = Number(ENV.P_LINE ?? 0.84);
const P_SWAP = Number(ENV.P_SWAP ?? 0.95), P_NSWAP = Number(ENV.P_NSWAP ?? 1);
/** inner cooler moves per compound structural move (anneal / polish), heat-balancing steps */
const INNER = Number(ENV.INNER ?? 0), INNER_POLISH = Number(ENV.INNER_POLISH ?? 8), BAL_STEPS = Number(ENV.BAL_STEPS ?? 0);
/** racing (successive halving) of annealing chains */
const RACE = Number(ENV.RACE ?? 1), RACE_K = Number(ENV.RACE_K ?? 16), RACE_DECAY = Number(ENV.RACE_DECAY ?? 0.6);
/** breeding: weight of effective heat as tie-breaker */
const BREED_W = Number(ENV.BREED_W ?? 1e-4);
const POLISH_FRAC = Number(ENV.POLISH_FRAC ?? 0.2), IMPROVE_T = Number(ENV.IMPROVE_T ?? 0.3);

/** breeding = maximize fuel consumption rate (running, fully cooled fuel components) */
export type Objective = 'output' | 'efficiency' | 'balanced' | 'breeding';

export interface OptimizeConfig {
  reactor: ReactorType;
  dims: [number, number, number];
  fuelId: string;
  sfrCoolant?: string;
  objective: Objective;
  /** Allowed component ids: moderator ids, reflector ids, cooler names (sink/heater type names) */
  allowedModerators: string[];
  allowedReflectors: string[];
  allowedCoolers: string[];
  allowConductors?: boolean;
  /** Maximum number of fuel components placed */
  maxFuel?: number;
  /** Minimum mean efficiency (e.g. 1.5 = 150%) */
  minEfficiency?: number;
  symmetry?: { x?: boolean; y?: boolean; z?: boolean };
  timeLimitMs?: number;
  seed?: number;
  /** Optional starting layout ("improve this layout": all chains start from it, at a lower temperature) */
  initial?: number[];
  /** Extra seed layouts (e.g. from the result library); ranked together with the constructive seeds */
  seedLayouts?: number[][];
}

/** Cooperation between parallel workers (best-layout exchange). */
export interface OptimizeHooks {
  /** Called with the best valid layout found so far (throttled). */
  publish?(grid: Uint8Array, objective: number): void;
  /** Best layout published by any worker, if any. */
  fetch?(): { grid: Uint8Array; objective: number } | null;
}

export interface Progress {
  elapsedMs: number;
  evaluations: number;
  phase: 'anneal' | 'polish' | 'cleanup' | 'done';
  temperature: number;
  bestFitness: number;
  bestValid: boolean;
  bestStats: ReactorStats | null;
  bestGrid: number[] | null;
}

export interface OptimizeResult {
  grid: number[];
  stats: ReactorStats;
  fitness: number;
  valid: boolean;
  evaluations: number;
  elapsedMs: number;
  seed: number;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolveFuel(id: string): FuelDef {
  const f = FUELS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown fuel "${id}"`);
  return f;
}

export class Optimizer {
  readonly cfg: OptimizeConfig;
  readonly sim: Simulator;
  readonly fuel: FuelDef;
  readonly rnd: () => number;
  readonly orbits: number[][];
  readonly orbitOf: Int32Array;
  readonly allowedCoolerBlocks: number[];
  readonly allowedModBlocks: number[];
  readonly allowedReflBlocks: number[];
  readonly allBlocks: number[];
  evaluations = 0;
  readonly allowedTypes: Int32Array;
  /** allowed cooler types, highest cooling rate first */
  readonly typesByRate: Int32Array;

  constructor(cfg: OptimizeConfig) {
    this.cfg = cfg;
    this.fuel = resolveFuel(cfg.fuelId);
    this.sim = new Simulator(cfg.dims, { reactor: cfg.reactor, fuel: this.fuel, sfrCoolant: cfg.sfrCoolant });
    this.rnd = mulberry32(cfg.seed ?? (Math.random() * 2 ** 31) | 0);
    const names: readonly string[] = cfg.reactor === 'sfr' ? COOLER_NAMES : HEATER_NAMES;
    this.allowedCoolerBlocks = cfg.allowedCoolers.map((n) => {
      const k = names.indexOf(n);
      if (k < 0) throw new Error(`Unknown cooler "${n}"`);
      return COOLER0 + k;
    });
    this.allowedModBlocks = cfg.allowedModerators.map((m) => {
      const k = MODERATORS.findIndex((x) => x.id === m); if (k < 0) throw new Error(`Unknown moderator "${m}"`); return MOD0 + k;
    });
    this.allowedReflBlocks = cfg.allowedReflectors.map((m) => {
      const k = REFLECTORS.findIndex((x) => x.id === m); if (k < 0) throw new Error(`Unknown reflector "${m}"`); return REFL0 + k;
    });
    this.allowedTypes = Int32Array.from(this.allowedCoolerBlocks.map((b) => b - COOLER0));
    this.typesByRate = Int32Array.from([...this.allowedTypes].sort((a, b) => COOLING_RATES[b] - COOLING_RATES[a]));
    if (this.allowedModBlocks.length === 0) throw new Error('At least one moderator must be allowed');
    this.allBlocks = [AIR, FUEL, ...this.allowedModBlocks, ...this.allowedReflBlocks, ...(cfg.allowConductors ? [CONDUCTOR] : []), ...this.allowedCoolerBlocks];
    // symmetry orbits
    const { X, Y, Z } = this.sim;
    const sym = cfg.symmetry ?? {};
    this.orbitOf = new Int32Array(this.sim.N).fill(-1);
    this.orbits = [];
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      const i = this.sim.index(x, y, z);
      if (this.orbitOf[i] >= 0) continue;
      const set = new Set<number>();
      for (const mx of sym.x ? [x, X - 1 - x] : [x]) for (const my of sym.y ? [y, Y - 1 - y] : [y]) for (const mz of sym.z ? [z, Z - 1 - z] : [z]) set.add(this.sim.index(mx, my, mz));
      const id = this.orbits.length;
      for (const j of set) this.orbitOf[j] = id;
      this.orbits.push([...set]);
    }
  }

  // ------------------------------------------------------------ fitness
  objectiveValue(s: ReactorStats): number {
    switch (this.cfg.objective) {
      case 'efficiency': return s.meanEfficiency * 1000 + s.effectiveHeating * 1e-3;
      case 'balanced': return s.effectiveHeating * s.meanEfficiency;
      // fuel use rescaled to "fuel components × base heat" (same scale as output); effective heat breaks ties
      case 'breeding': {
        // fuel use at full cooling: running fuel components in producing clusters (= fuelPerHour × time / 72000 for
        // stable layouts). The undercooling lifetime factor is deliberately ignored — it would reward overheating.
        let n = 0;
        const sfr = this.cfg.reactor === 'sfr';
        for (const c of s.clusters) if (c.fuelCount > 0 && (!sfr || c.connectedToWall)) n += c.fuelCount;
        return n * this.fuel.heat + s.effectiveHeating * BREED_W;
      }
      default: return s.effectiveHeating;
    }
  }
  constraintViolation(s: ReactorStats): number {
    let v = 0;
    if (this.cfg.maxFuel !== undefined && s.fuelComponents > this.cfg.maxFuel) v += (s.fuelComponents - this.cfg.maxFuel) / Math.max(1, this.cfg.maxFuel);
    if (this.cfg.minEfficiency !== undefined && s.runningFuelComponents > 0 && s.meanEfficiency < this.cfg.minEfficiency) v += (this.cfg.minEfficiency - s.meanEfficiency) / this.cfg.minEfficiency;
    return v;
  }
  isValid(s: ReactorStats) {
    return s.excessHeat <= 0 && this.constraintViolation(s) <= 0 && s.runningFuelComponents > 0;
  }
  lambda = 3;
  /** Weight of the criticality-progress shaping term (annealed to 0). */
  shaping = 1;
  fitness(s: ReactorStats): number {
    const obj = this.objectiveValue(s);
    const heatFrac = s.excessHeat / Math.max(1, s.rawHeating);
    let f = obj * (1 - this.lambda * heatFrac) - this.lambda * 2 * Math.abs(obj) * this.constraintViolation(s) - s.excessHeat * 1e-3;
    if (this.shaping > 0) {
      // gradient towards criticality: reward partial flux on fuel components that are not yet running
      const sim = this.sim;
      let progress = 0;
      for (let b = 0; b < sim.bunchCount; b++) {
        if (sim.bunchEmit[b]) continue;
        const th = sim.criticalityThreshold(b);
        let potential = sim.bunchFlux[b];
        for (let q = sim.memberStart[b]; q < sim.memberStart[b + 1]; q++) {
          const f = sim.memberList[q];
          for (let d = 0; d < 6; d++) if (sim.lineType[f * 6 + d] === 2) potential += sim.lineFlux[f * 6 + d];
        }
        progress += th > 0 ? Math.min(1, potential / th) * sim.bunchSize[b] : 0;
      }
      const unit = this.cfg.objective === 'efficiency' ? 50 : this.fuel.heat * 0.25;
      f += this.shaping * unit * progress;
    }
    return f;
  }
  evalGrid(grid: Uint8Array): { stats: ReactorStats; fit: number } {
    this.evaluations++;
    const stats = this.sim.evaluate(grid);
    return { stats, fit: this.fitness(stats) };
  }

  // ------------------------------------------------------------ helpers
  setOrbit(grid: Uint8Array, orbit: number, b: number) { for (const i of this.orbits[orbit]) grid[i] = b; }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.rnd() * arr.length)]; }
  randomBlock(): number {
    const r = this.rnd();
    const hasRefl = this.allowedReflBlocks.length > 0, hasCond = !!this.cfg.allowConductors, hasCool = this.allowedCoolerBlocks.length > 0;
    const w = [0.07, 0.14, 0.24, hasRefl ? 0.07 : 0, hasCond ? 0.02 : 0, hasCool ? 0.46 : 0];
    const total = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    const x = r * total;
    for (let k = 0; k < w.length; k++) {
      acc += w[k];
      if (x < acc) {
        switch (k) {
          case 0: return AIR;
          case 1: return FUEL;
          case 2: return this.pick(this.allowedModBlocks);
          case 3: return this.pick(this.allowedReflBlocks);
          case 4: return CONDUCTOR;
          default: return this.pick(this.allowedCoolerBlocks);
        }
      }
    }
    return AIR;
  }
  /** Coolers whose placement rule is satisfied at i given the simulator's current state. */
  validCoolersAt(i: number): number[] {
    return this.sim.validCoolerTypes(i, this.allowedTypes).map((t) => t + COOLER0);
  }
  /** Highest-rate allowed cooler block valid at i, or -1. */
  bestCoolerAt(i: number): number {
    const t = this.sim.firstValidCooler(i, this.typesByRate);
    return t < 0 ? -1 : t + COOLER0;
  }
  smartCooler(i: number, preferHigh: boolean): number {
    const v = this.validCoolersAt(i);
    if (v.length === 0) return this.allowedCoolerBlocks.length && this.rnd() < 0.5 ? this.pick(this.allowedCoolerBlocks) : AIR;
    if (preferHigh) return v.reduce((a, b) => (COOLING_RATES[b - COOLER0] > COOLING_RATES[a - COOLER0] ? b : a));
    return this.pick(v);
  }
  /** Repeatedly fills air / invalid coolers with the best valid cooler. */
  fillCoolers(grid: Uint8Array, passes = 4) {
    for (let p = 0; p < passes; p++) {
      this.sim.evaluate(grid); this.evaluations++;
      let changed = false;
      for (let o = 0; o < this.orbits.length; o++) {
        const i = this.orbits[o][0];
        const b = grid[i];
        if (b === AIR || (isCooler(b) && !this.sim.valid[i])) {
          const v = this.validCoolersAt(i);
          if (v.length) {
            const best = v.reduce((a, c) => (COOLING_RATES[c - COOLER0] > COOLING_RATES[a - COOLER0] ? c : a));
            if (best !== b) { this.setOrbit(grid, o, best); changed = true; }
          }
        }
      }
      if (!changed) break;
    }
  }

  /** Constructive seed: a lattice of fuel components joined by straight moderator lines. */
  latticeSeed(spacingIn?: number, modIn?: number): Uint8Array {
    const { X, Y, Z, N } = this.sim;
    const grid = new Uint8Array(N);
    const spacing = spacingIn ?? 2 + Math.floor(this.rnd() * 4); // 1-4 moderators between fuel
    const mod = modIn ?? this.pick(this.allowedModBlocks);
    const off = [0, 0, 0].map(() => Math.floor(this.rnd() * spacing));
    const dims = [X, Y, Z];
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      const c = [x, y, z];
      const on = c.map((v, a) => (dims[a] === 1 ? true : (v - off[a] + spacing) % spacing === 0));
      const k = on.filter(Boolean).length;
      const i = this.sim.index(x, y, z);
      if (k === 3) grid[i] = FUEL;
      else if (k === 2) grid[i] = mod;
    }
    this.symmetrize(grid);
    this.fillCoolers(grid);
    return grid;
  }
  randomSeed(): Uint8Array {
    const grid = new Uint8Array(this.sim.N);
    for (let o = 0; o < this.orbits.length; o++) this.setOrbit(grid, o, this.rnd() < 0.15 ? FUEL : this.rnd() < 0.4 ? this.pick(this.allowedModBlocks) : AIR);
    this.fillCoolers(grid);
    return grid;
  }
  symmetrize(grid: Uint8Array) { for (let o = 0; o < this.orbits.length; o++) this.setOrbit(grid, o, grid[this.orbits[o][0]]); }

  // ------------------------------------------------------------ main loop
  run(onProgress?: (p: Progress) => void, shouldStop?: () => boolean, hooks?: OptimizeHooks): OptimizeResult {
    const t0 = Date.now();
    const limit = this.cfg.timeLimitMs ?? 10000;
    const annealEnd = t0 + limit * (1 - POLISH_FRAC);
    const O = this.orbits.length;
    const stop = () => !!shouldStop?.();

    // ---- starting layouts
    const improving = !!(this.cfg.initial && this.cfg.initial.length === this.sim.N);
    const rankedSeeds: Uint8Array[] = [];
    if (improving) {
      // "improve this layout": every chain starts from the given layout
      rankedSeeds.push(this.sanitize(Uint8Array.from(this.cfg.initial!)));
    } else {
      const seeds: Uint8Array[] = [];
      for (const m of this.allowedModBlocks) for (let sp = 2; sp <= 5; sp++) for (let r = 0; r < 2; r++) seeds.push(this.latticeSeed(sp, m));
      seeds.push(this.randomSeed(), this.randomSeed());
      for (const l of this.cfg.seedLayouts ?? []) if (l.length === this.sim.N) seeds.push(this.sanitize(Uint8Array.from(l)));
      const scored = seeds.map((g) => ({ g, f: this.evalGrid(g).fit })).sort((a, b) => b.f - a.f);
      for (const x of scored) rankedSeeds.push(x.g);
    }
    let cur = rankedSeeds[0].slice();
    let { stats: curStats, fit: curFit } = this.evalGrid(cur);
    let best = cur.slice(), bestFit = curFit, bestStats = structuredClone(curStats);
    let bestValidGrid: Uint8Array | null = this.isValid(curStats) ? cur.slice() : null;
    let bestValidObj = bestValidGrid ? this.objectiveValue(curStats) : -Infinity;
    let bestValidStats: ReactorStats | null = bestValidGrid ? structuredClone(curStats) : null;

    // temperature calibration: mean worsening of random single-orbit moves from the seed
    let T0 = 1;
    {
      let sum = 0, n = 0;
      for (let k = 0; k < 200; k++) {
        const o = Math.floor(this.rnd() * O), prev = cur[this.orbits[o][0]];
        this.setOrbit(cur, o, this.randomBlock());
        const d = this.evalGrid(cur).fit - curFit;
        this.setOrbit(cur, o, prev);
        if (d < 0) { sum += -d; n++; }
      }
      T0 = Math.max(1, n ? (0.7 * sum) / n : Math.abs(curFit) * 0.05 + 1);
      this.evalGrid(cur);
    }
    let lastReport = 0, lastPublish = 0;
    const changed: number[] = [], prevBlocks: number[] = [];
    const report = (phase: Progress['phase'], T: number) => {
      const g = bestValidGrid ?? best;
      onProgress?.({
        elapsedMs: Date.now() - t0, evaluations: this.evaluations, phase, temperature: T,
        bestFitness: bestValidGrid ? bestValidObj : bestFit, bestValid: !!bestValidGrid,
        bestStats: bestValidStats ?? bestStats, bestGrid: Array.from(g),
      });
    };
    const publish = (force = false) => {
      if (!hooks?.publish || !bestValidGrid) return;
      const now = Date.now();
      if (!force && now - lastPublish < 250) return;
      lastPublish = now; hooks.publish(bestValidGrid, bestValidObj);
    };
    // chain-local best (valid objective first, then raw fitness)
    let cbGrid: Uint8Array | null = null, cbObj = -Infinity, cbFit = -Infinity;
    const consider = (g: Uint8Array, s: ReactorStats, f: number) => {
      if (f > bestFit) { bestFit = f; best = g.slice(); bestStats = structuredClone(s); }
      const valid = this.isValid(s);
      if (valid) {
        const obj = this.objectiveValue(s);
        if (obj > bestValidObj) { bestValidObj = obj; bestValidGrid = g.slice(); bestValidStats = structuredClone(s); publish(); }
        if (obj > cbObj) { cbObj = obj; cbGrid = g.slice(); cbFit = f; }
      } else if (cbObj === -Infinity && f > cbFit) { cbFit = f; cbGrid = g.slice(); }
    };
    const fetchMigrant = (): Uint8Array | null => {
      const m = hooks?.fetch?.();
      if (!m || m.grid.length !== this.sim.N || m.objective <= bestValidObj) return null;
      const g = m.grid.slice();
      const r = this.evalGrid(g);
      consider(g, r.stats, r.fit);
      return g;
    };

    // ---- one annealing chain from `start` until `end`
    let T = T0;
    const runChain = (start: Uint8Array, tScale: number, end: number) => {
      cur = start.slice();
      cbGrid = null; cbObj = -Infinity; cbFit = -Infinity;
      ({ stats: curStats, fit: curFit } = this.evalGrid(cur));
      consider(cur, curStats, curFit);
      const cs = Date.now(), dur = Math.max(1, end - cs);
      let iter = 0;
      while (!stop()) {
        const now = Date.now();
        if (now >= end) break;
        iter++;
        const cp = (now - cs) / dur;
        T = T0 * tScale * Math.pow(1e-4, cp);
        this.lambda = 0.4 + 6 * cp * cp;
        this.shaping = Math.max(0, 1 - 1.5 * cp);
        if ((iter & 1023) === 0) { curFit = this.fitness(this.sim.evaluate(cur)); this.evaluations++; }
        // ---- propose
        changed.length = 0; prevBlocks.length = 0;
        const mv = this.rnd();
        const o = Math.floor(this.rnd() * O);
        const i0 = this.orbits[o][0];
        const record = (orb: number) => { changed.push(orb); prevBlocks.push(cur[this.orbits[orb][0]]); };
        if (mv < P_RANDOM) {
          const b = this.randomBlock();
          if (b === cur[i0]) continue;
          record(o); this.setOrbit(cur, o, b);
        } else if (mv < P_SMART) {
          const b = this.smartCooler(i0, this.rnd() < 0.3);
          if (b === cur[i0]) continue;
          record(o); this.setOrbit(cur, o, b);
        } else if (mv < P_LINE) {
          // structural move: a straight moderator line from a fuel component, ending in fuel or a reflector
          if (!this.lineMove(cur, i0, record)) {
            for (let k = changed.length - 1; k >= 0; k--) this.setOrbit(cur, changed[k], prevBlocks[k]);
            continue;
          }
        } else if (mv < P_SWAP) {
          const o2 = Math.floor(this.rnd() * O);
          const a = cur[i0], b = cur[this.orbits[o2][0]];
          if (a === b) continue;
          record(o); record(o2); this.setOrbit(cur, o, b); this.setOrbit(cur, o2, a);
        } else if (mv < P_NSWAP) {
          // move a block to a neighbouring orbit (small structural shift)
          const nbr = this.sim.nb[i0 * 6 + Math.floor(this.rnd() * 6)];
          if (nbr < 0) continue;
          const o2 = this.orbitOf[nbr];
          const a = cur[i0], b = cur[nbr];
          if (a === b || o2 === o) continue;
          record(o); record(o2); this.setOrbit(cur, o, b); this.setOrbit(cur, o2, a);
        } else {
          // heat balancing: shave cooling off overcooled clusters
          if (!this.balance(cur, record)) continue;
        }
        let { stats, fit } = this.evalGrid(cur);
        if (P_REPAIR > 0 && this.isStructural(changed, prevBlocks, cur) && this.rnd() < P_REPAIR) {
          // compound move: structural change + cooler re-optimisation around it, accepted or rejected as one
          ({ stats, fit } = this.coolerReopt(cur, changed, stats, fit, record, INNER));
        }
        const delta = fit - curFit;
        if (delta >= 0 || this.rnd() < Math.exp(delta / T)) {
          curFit = fit; curStats = stats;
          consider(cur, stats, fit);
        } else {
          for (let k = changed.length - 1; k >= 0; k--) this.setOrbit(cur, changed[k], prevBlocks[k]);
        }
        if (now - lastReport > 300) { lastReport = now; report('anneal', T); }
      }
      return { grid: cbGrid ?? cur.slice(), obj: cbObj, fit: cbFit };
    };

    // ---- schedule: stages of chains; each stage keeps the best half (racing) and re-anneals them cooler
    const stages: { n: number; frac: number; t: number }[] = [];
    if (RACE) {
      const k0 = Math.max(1, Math.min(RACE_K, improving ? RACE_K : rankedSeeds.length));
      let n = k0; const ns: number[] = [];
      for (;;) { ns.push(n); if (n === 1) break; n = Math.ceil(n / 2); }
      ns.forEach((n, r) => stages.push({ n, frac: 1 / ns.length, t: (improving ? IMPROVE_T : 1) * (r === 0 ? 1 : Math.max(REHEAT, Math.pow(RACE_DECAY, r))) }));
    } else if (rankedSeeds.length > 1 || improving) {
      stages.push({ n: PORTF, frac: PORT_FRAC, t: improving ? IMPROVE_T : 1 }, { n: 1, frac: 1 - PORT_FRAC, t: REHEAT * (improving ? IMPROVE_T : 1) });
    } else stages.push({ n: 1, frac: 1, t: 1 });
    let starts: Uint8Array[] = [];
    for (let k = 0; k < stages[0].n; k++) starts.push(rankedSeeds[k % rankedSeeds.length]);
    const annealStart = Date.now(), annealDur = Math.max(1, annealEnd - annealStart);
    let stageStart = annealStart;
    for (let si = 0; si < stages.length && !stop(); si++) {
      const st = stages[si];
      const stageEnd = si === stages.length - 1 ? annealEnd : stageStart + annealDur * st.frac;
      const results: { grid: Uint8Array; obj: number; fit: number }[] = [];
      for (let c = 0; c < starts.length && !stop(); c++) {
        const end = stageStart + ((stageEnd - stageStart) * (c + 1)) / starts.length;
        results.push(runChain(starts[c], st.t, end));
      }
      stageStart = stageEnd;
      publish(true);
      if (si + 1 >= stages.length) break;
      // rank chains, keep the best n of the next stage; a better layout from another worker joins the race
      const mig = fetchMigrant();
      if (mig) results.push({ grid: mig, obj: Infinity, fit: Infinity });
      results.sort((a, b) => (b.obj - a.obj) || (b.fit - a.fit));
      const nNext = stages[si + 1].n;
      starts = [];
      for (let k = 0; k < nNext; k++) starts.push(results[k % results.length].grid);
      if (nNext === 1 && bestValidGrid && !mig) starts[0] = bestValidGrid;
    }

    // ---- polish the best layout (prefer valid): greedy single-orbit pass, then exhaustive compound neighbourhood
    fetchMigrant(); // a better layout from another worker becomes the polish start
    this.lambda = 6; this.shaping = 0;
    const polishEnd = t0 + limit;
    const timeUp = () => Date.now() >= polishEnd || stop();
    let g = (bestValidGrid ?? best).slice();
    let gs = this.evalGrid(g);
    consider(g, gs.stats, gs.fit);
    for (let round = 0; round < 4 && !timeUp(); round++) {
      const before = gs.fit;
      gs = this.greedyPolish(g, gs, consider, timeUp, () => { if (Date.now() - lastReport > 300) { lastReport = Date.now(); report('polish', 0); } });
      if (timeUp()) break;
      gs = this.compoundPolish(g, gs, consider, timeUp, () => { if (Date.now() - lastReport > 300) { lastReport = Date.now(); report('polish', 0); } });
      if (gs.fit <= before + 1e-9) break;
    }
    publish(true);

    // ---- cleanup: replace blocks that do nothing with air
    report('cleanup', 0);
    const finalGrid = (bestValidGrid ?? best).slice();
    this.cleanup(finalGrid);
    const fin = this.evalGrid(finalGrid);
    const result: OptimizeResult = {
      grid: Array.from(finalGrid), stats: fin.stats, fitness: this.isValid(fin.stats) ? this.objectiveValue(fin.stats) : fin.fit,
      valid: this.isValid(fin.stats), evaluations: this.evaluations, elapsedMs: Date.now() - t0, seed: this.cfg.seed ?? 0,
    };
    onProgress?.({ elapsedMs: result.elapsedMs, evaluations: this.evaluations, phase: 'done', temperature: 0, bestFitness: result.fitness, bestValid: result.valid, bestStats: result.stats, bestGrid: result.grid });
    return result;
  }

  /** Replaces blocks that are not allowed in this configuration with air and applies the symmetry. */
  sanitize(g: Uint8Array): Uint8Array {
    const allowed = new Set(this.allBlocks);
    for (let i = 0; i < g.length; i++) if (!allowed.has(g[i])) g[i] = AIR;
    this.symmetrize(g);
    return g;
  }

  /** Single-orbit greedy pass: every orbit takes the block with the best fitness. */
  greedyPolish(g: Uint8Array, gs: { stats: ReactorStats; fit: number }, consider: (g: Uint8Array, s: ReactorStats, f: number) => void, timeUp: () => boolean, tick: () => void) {
    const O = this.orbits.length;
    let improved = true;
    while (improved && !timeUp()) {
      improved = false;
      const order = [...Array(O).keys()].sort(() => this.rnd() - 0.5);
      for (const o of order) {
        if (timeUp()) break;
        const orig = g[this.orbits[o][0]];
        let bestB = orig, bestF = gs.fit;
        for (const b of this.allBlocks) {
          if (b === orig) continue;
          this.setOrbit(g, o, b);
          const r = this.evalGrid(g);
          consider(g, r.stats, r.fit);
          if (r.fit > bestF + 1e-9) { bestF = r.fit; bestB = b; }
        }
        this.setOrbit(g, o, bestB);
        if (bestB !== orig) { improved = true; gs = this.evalGrid(g); }
      }
      tick();
    }
    return gs;
  }

  /**
   * Exhaustive compound neighbourhood: every structural change of every orbit (air / fuel / each moderator /
   * each reflector) followed by cooler re-optimisation; first improvement is kept, until a local optimum.
   */
  compoundPolish(g: Uint8Array, gs: { stats: ReactorStats; fit: number }, consider: (g: Uint8Array, s: ReactorStats, f: number) => void, timeUp: () => boolean, tick: () => void) {
    const O = this.orbits.length;
    const structural = [AIR, FUEL, ...this.allowedModBlocks, ...this.allowedReflBlocks];
    const changed: number[] = [], prev: number[] = [];
    const record = (orb: number) => { changed.push(orb); prev.push(g[this.orbits[orb][0]]); };
    let improved = true;
    while (improved && !timeUp()) {
      improved = false;
      const order = [...Array(O).keys()].sort(() => this.rnd() - 0.5);
      for (const o of order) {
        if (timeUp()) break;
        for (const b of structural) {
          const orig = g[this.orbits[o][0]];
          if (b === orig || (b === AIR && !(orig === FUEL || isModerator(orig) || isReflector(orig)))) continue;
          changed.length = 0; prev.length = 0;
          record(o); this.setOrbit(g, o, b);
          let r = this.evalGrid(g);
          r = this.coolerReopt(g, changed, r.stats, r.fit, record, INNER_POLISH);
          consider(g, r.stats, r.fit);
          if (r.fit > gs.fit + 1e-9) { gs = r; improved = true; break; }
          for (let k = changed.length - 1; k >= 0; k--) this.setOrbit(g, changed[k], prev[k]);
        }
        tick();
      }
    }
    this.evalGrid(g);
    return gs;
  }

  /**
   * Cooler re-optimisation after a structural change (the inner level of the bilevel search): greedy repair
   * (fill air / invalid coolers with the best valid cooler while heat is uncovered), heat balancing
   * (shave cooling off overcooled clusters), then `budget` greedy cooler-only moves around the change —
   * cheap, because cooler-only changes reuse the cached neutronics. Returns the resulting stats/fitness.
   */
  coolerReopt(cur: Uint8Array, changed: number[], stats: ReactorStats, fit: number, record: (orb: number) => void, budget: number) {
    const cand = this.neighbourhood(changed.slice());
    const loc: number[] = []; // (orbit, previous block) pairs recorded by this call
    const rec = (o: number) => { loc.push(o, cur[this.orbits[o][0]]); record(o); };
    let res = { stats, fit };
    if (this.repair(cur, cand, stats, rec)) res = this.evalGrid(cur);
    for (let k = 0; k < BAL_STEPS; k++) {
      const mark = loc.length;
      if (!this.balance(cur, rec)) break;
      const r = this.evalGrid(cur);
      if (r.fit > res.fit) { res = r; continue; }
      for (let q = loc.length - 2; q >= mark; q -= 2) this.setOrbit(cur, loc[q], loc[q + 1]);
      this.sim.evaluate(cur);
      break;
    }
    let dirty = false;
    for (let k = 0; k < budget && cand.length; k++) {
      const o = cand[Math.floor(this.rnd() * cand.length)];
      const i = this.orbits[o][0], b = cur[i];
      if (!(b === AIR || isCooler(b))) continue;
      const v = this.validCoolersAt(i);
      const nb = this.rnd() < 0.15 ? AIR : v.length ? v[Math.floor(this.rnd() * v.length)] : AIR;
      if (nb === b) continue;
      rec(o); this.setOrbit(cur, o, nb);
      const r = this.evalGrid(cur);
      if (r.fit > res.fit) { res = r; dirty = false; }
      else { this.setOrbit(cur, o, b); dirty = true; }
    }
    if (dirty) this.sim.evaluate(cur); // keep the simulator state in sync with `cur`
    return res;
  }

  /** Orbits within two blocks of the given orbits (all orbits for small symmetric problems). */
  neighbourhood(orbs: number[]): number[] {
    const O = this.orbits.length;
    if (REPAIR_FULL < 0 ? O <= 40 : REPAIR_FULL === 1) return [...Array(O).keys()];
    const sim = this.sim;
    const seen = new Set<number>(orbs);
    const cand: number[] = [...orbs];
    for (const o of orbs) for (const i of this.orbits[o]) {
      for (let d = 0; d < 6; d++) {
        const j = sim.nb[i * 6 + d];
        if (j < 0) continue;
        const oj = this.orbitOf[j];
        if (!seen.has(oj)) { seen.add(oj); cand.push(oj); }
        for (let e = 0; e < 6; e++) {
          const k = sim.nb[j * 6 + e];
          if (k >= 0 && !seen.has(this.orbitOf[k])) { seen.add(this.orbitOf[k]); cand.push(this.orbitOf[k]); }
        }
      }
    }
    return cand;
  }

  /**
   * Heat balancing on the simulator's current state: in clusters whose cooling exceeds heating plus the
   * leniency, downgrade valid coolers (to a lower-rate valid cooler or air) so the surplus shrinks without
   * dropping below the heating. Returns true if anything changed (the caller re-evaluates).
   */
  balance(cur: Uint8Array, record: (orb: number) => void): boolean {
    const sim = this.sim, st = sim.stats;
    if (!st) return false;
    const len = FISSION_CONFIG.coolingEfficiencyLeniency;
    let any = false;
    for (const c of st.clusters) {
      if (c.rawHeating <= 0 || c.cooling <= c.rawHeating + len) continue;
      let surplus = c.cooling - c.rawHeating;
      for (let step = 0; step < 3 && surplus > len; step++) {
        let bestO = -1, bestB = -1, bestRed = 0;
        for (let q = sim.clusterStart[c.id]; q < sim.clusterStart[c.id + 1]; q++) {
          const i = sim.clusterMembers[q], b = cur[i];
          if (!isCooler(b) || !sim.valid[i]) continue;
          const o = this.orbitOf[i];
          if (this.orbits[o][0] !== i && sim.cluster[this.orbits[o][0]] === c.id) continue; // handle each orbit once
          const mult = this.orbits[o].filter((j) => sim.cluster[j] === c.id).length;
          const rate = COOLING_RATES[b - COOLER0];
          for (const nb of [AIR, ...this.validCoolersAt(i)]) {
            const r2 = nb === AIR ? 0 : COOLING_RATES[nb - COOLER0];
            const red = (rate - r2) * mult;
            if (red > bestRed && red <= surplus) { bestRed = red; bestO = o; bestB = nb; }
          }
        }
        if (bestO < 0) break;
        record(bestO); this.setOrbit(cur, bestO, bestB); any = true;
        surplus -= bestRed;
      }
    }
    return any;
  }

  /** Builds fuel -> L moderators -> (fuel | reflector) starting at (or next to) position i. */
  lineMove(cur: Uint8Array, i: number, record: (orb: number) => void): boolean {
    const sim = this.sim;
    let start = i;
    if (cur[start] !== FUEL) {
      // look for a nearby fuel component to anchor on, otherwise create one here
      if (this.rnd() < 0.7) {
        for (let k = 0; k < sim.fuelCount; k++) { if (this.rnd() < 1 / Math.max(1, sim.fuelCount - k)) { start = sim.fuelList[k]; break; } }
      }
    }
    const d = Math.floor(this.rnd() * 6);
    const toReflector = this.allowedReflBlocks.length > 0 && this.rnd() < 0.3;
    const L = 1 + Math.floor(this.rnd() * (toReflector ? 2 : 4));
    const mod = this.pick(this.allowedModBlocks);
    const path: number[] = [start];
    let p = start;
    for (let k = 0; k <= L; k++) { p = sim.nb[p * 6 + d]; if (p < 0) return false; path.push(p); }
    const want = [FUEL, ...Array(L).fill(mod), toReflector ? this.pick(this.allowedReflBlocks) : FUEL];
    const touched = new Set<number>();
    for (let k = 0; k < path.length; k++) {
      const o = this.orbitOf[path[k]];
      if (touched.has(o)) { if (cur[path[k]] !== want[k]) return false; continue; }
      if (cur[path[k]] === want[k]) continue;
      touched.add(o); record(o); this.setOrbit(cur, o, want[k]);
    }
    return touched.size > 0;
  }

  /** True if the proposal touched fuel, moderators or reflectors (before or after). */
  isStructural(changed: number[], prevBlocks: number[], cur: Uint8Array): boolean {
    for (let k = 0; k < changed.length; k++) {
      const a = prevBlocks[k], b = cur[this.orbits[changed[k]][0]];
      if (a === FUEL || b === FUEL || isModerator(a) || isModerator(b) || isReflector(a) || isReflector(b)) return true;
    }
    return false;
  }
  /**
   * Greedy local cooler repair after a structural change: around the changed orbits, air and invalid
   * coolers are replaced by the highest-rate cooler whose rule is satisfied, until the excess heat is covered.
   * Uses the simulator state of the last evaluation. Returns true if anything changed.
   */
  /** Greedy cooler repair over the candidate orbits: air / invalid coolers -> best valid cooler while heat is uncovered. */
  repair(cur: Uint8Array, cand: number[], stats: ReactorStats, record: (orb: number) => void): boolean {
    const sim = this.sim;
    let need = stats.excessHeat;
    let any = false;
    for (const o of cand) {
      const i = this.orbits[o][0], b = cur[i];
      const invalid = isCooler(b) && !sim.valid[i];
      if (b !== AIR && !invalid) continue;
      if (b === AIR && need <= 0) continue;
      const best = this.bestCoolerAt(i);
      if (best < 0 || best === b) continue;
      record(o); this.setOrbit(cur, o, best); any = true;
      need -= COOLING_RATES[best - COOLER0] * this.orbits[o].length;
    }
    return any;
  }

  cleanup(grid: Uint8Array) {
    const base = this.evalGrid(grid);
    const baseObj = this.objectiveValue(base.stats), baseValid = this.isValid(base.stats);
    for (let o = 0; o < this.orbits.length; o++) {
      this.sim.evaluate(grid);
      const i = this.orbits[o][0], b = grid[i];
      const useless = (b === FUEL && !this.sim.running[i]) || (isCooler(b) && !this.sim.valid[i]) ||
        (isModerator(b) && this.sim.modState[i] === 0) || (isReflector(b) && !this.sim.reflActive[i]) || (b === CONDUCTOR && this.sim.cluster[i] < 0);
      if (!useless) continue;
      this.setOrbit(grid, o, AIR);
      const r = this.evalGrid(grid);
      if (this.objectiveValue(r.stats) < baseObj - 1e-9 || (baseValid && !this.isValid(r.stats))) this.setOrbit(grid, o, b);
    }
  }
}

export function optimize(cfg: OptimizeConfig, onProgress?: (p: Progress) => void, shouldStop?: () => boolean, hooks?: OptimizeHooks): OptimizeResult {
  return new Optimizer(cfg).run(onProgress, shouldStop, hooks);
}
