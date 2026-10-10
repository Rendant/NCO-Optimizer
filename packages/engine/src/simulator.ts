/**
 * Steady-state simulator for NuclearCraft: Overhauled fission reactors (solid-fuel & molten-salt).
 *
 * Mirrors the refresh pipeline of nc/multiblock/fission/FissionReactorLogic.java:
 *   refreshFlux()      -> priming, moderator-line flux distribution, criticality (IFissionFuelComponent.defaultDistributeFlux)
 *   refreshClusters()  -> active/passive moderators, cooling component placement rules, cluster search
 *   refreshClusterStats / refreshReactorStats (SolidFuelFissionLogic / MoltenSaltFissionLogic)
 * with steady-state (fixed point) semantics instead of tick order.
 */
import { FISSION_CONFIG, FuelDef, MODERATORS, REFLECTORS, ReactorType, SINK_RULES, HEATER_RULES, COOLING_RATES, SFR_COOLANTS, HEATER_COOLANTS } from './components.js';
import { FUEL, MOD0, REFL0, CONDUCTOR, COOLER0, NUM_BLOCKS, isModerator, isReflector } from './blocks.js';

/** Blocks that take part in neutronics (fuel, moderators, reflectors). Everything else is equivalent for flux. */
const NEUTRONIC = new Uint8Array(NUM_BLOCKS);
for (let b = 0; b < NUM_BLOCKS; b++) NEUTRONIC[b] = b === FUEL || isModerator(b) || isReflector(b) ? 1 : 0;
const TARGET_CODE: Record<string, number> = { casing: 0, conductor: 1, moderator: 2, reflector: 3, fuel: 4, cooler: 5, unsupported: 6 };
import { PlacementRule, parseRule, adjacentSatisfied } from './rules.js';

/** EnumFacing order: DOWN, UP, NORTH, SOUTH, WEST, EAST */
export const DIRS: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
export const DIR_NAMES = ['down', 'up', 'north', 'south', 'west', 'east'];
export const opposite = (d: number) => d ^ 1;

export interface SimOptions {
  reactor: ReactorType;
  fuel: FuelDef;
  /** SFR heating fluid id (water / preheated_water) */
  sfrCoolant?: string;
  /**
   * Fuel-component indices primed by neutron sources, with the source efficiency applied to them.
   * When omitted, every fuel component is treated as primed with no source-efficiency penalty
   * (the usual planner assumption; use `planSources` for a concrete source layout).
   */
  primed?: { index: number; efficiency: number }[];
}

export interface ClusterStats {
  id: number;
  size: number;
  componentCount: number;
  fuelCount: number;
  connectedToWall: boolean;
  rawHeating: number;
  cooling: number;
  netHeating: number;
  totalBaseFuelHeating: number;
  effectiveHeating: number;
  meanHeatMult: number;
  meanEfficiency: number;
  overcoolingEfficiencyFactor: number;
  undercoolingLifetimeFactor: number;
  /** MSR only: heater heating-speed multiplier for this cluster */
  heatingSpeedMultiplier: number;
}

export interface ReactorStats {
  reactor: ReactorType;
  dims: [number, number, number];
  interiorVolume: number;
  fuelComponents: number;
  runningFuelComponents: number;
  coolers: number;
  validCoolers: number;
  activeModerators: number;
  passiveModerators: number;
  activeReflectors: number;
  usefulPartCount: number;
  usefulPartRatio: number;
  sparsityEfficiencyMult: number;
  clusterCount: number;
  rawHeating: number;
  cooling: number;
  netHeating: number;
  /** Highest net heating of any single cluster (must be <= 0 for a stable reactor) */
  maxClusterNetHeating: number;
  /** Sum over clusters of max(0, net heating) */
  excessHeat: number;
  totalBaseFuelHeating: number;
  /** Effective heating output (H/t) after all penalties. SFR: drives the heating recipe; MSR: heater output. */
  effectiveHeating: number;
  meanHeatMult: number;
  meanEfficiency: number;
  /** Clusters containing running fuel that do not touch the casing (SFR: produce nothing) */
  disconnectedFuelClusters: number;
  stable: boolean;
  /** SFR: coolant in / steam out (mB/t) and ideal turbine RF/t */
  coolantInput: number;
  outputFluid: number;
  outputFluidName: string;
  rfPerTick: number;
  /** Fuel consumption: SFR ingots per hour, MSR mB per hour */
  fuelPerHour: number;
  fuelUnit: string;
  /** MSR: hot coolant output per heater coolant (mB/t) */
  hotCoolant: Record<string, number>;
  meanHeatingSpeedMultiplier: number;
  clusters: ClusterStats[];
}

interface Line {
  /** 0 none, 1 fuel target, 2 reflector */
  type: number;
  target: number;
  flux: number;
  eff: number;
  /** number of moderators in the line */
  len: number;
}

interface NeutronSlot {
  sig: Uint8Array; ready: boolean; primed: SimOptions['primed']; fuelCount: number; bunchCount: number; version: number;
  fuelList: Int32Array; bunchOf: Int32Array; bunchSize: Int32Array; bunchOpenFaces: Int32Array; bunchFlux: Float64Array;
  bunchPrimed: Uint8Array; bunchEmit: Uint8Array; memberList: Int32Array; memberStart: Int32Array;
  lineType: Uint8Array; lineTarget: Int32Array; lineFlux: Float64Array; lineEff: Float64Array; lineLen: Uint8Array;
  running: Uint8Array; flux: Float64Array; heatMult: Int32Array; inEff: Float64Array; inFlux: Float64Array; inSet: Uint8Array;
  modState: Uint8Array; reflActive: Uint8Array; srcEff: Float64Array; bunchRaw: Float64Array; bunchEff: Float64Array; bunchBase: Float64Array; nCounts: Int32Array;
}

export class Simulator {
  readonly X: number; readonly Y: number; readonly Z: number; readonly N: number;
  readonly opts: SimOptions;
  readonly fuel: FuelDef;
  /** neighbor index per (i*6+d), -1 = casing */
  readonly nb: Int32Array;
  readonly rules: PlacementRule[];
  readonly reach = FISSION_CONFIG.neutronReach;

  // ---- per-evaluation state (reused buffers) ----
  grid!: Uint8Array;
  fuelList: Int32Array; fuelCount = 0;
  /** bunch id per position (-1 none) */
  bunchOf: Int32Array;
  bunchCount = 0;
  bunchSize: Int32Array; bunchOpenFaces: Int32Array;
  bunchFlux: Float64Array; bunchPrimed: Uint8Array; bunchEmit: Uint8Array;
  /** Per bunch (neutronics-only, cached): raw heating, efficiency-weighted heating, base heating. */
  bunchRaw: Float64Array; bunchEff: Float64Array; bunchBase: Float64Array;
  /** Neutronics-only counts: active moderators, passive moderators, active reflectors. */
  private nCounts: Int32Array = new Int32Array(3);
  memberList: Int32Array; memberStart: Int32Array;
  private incoming: Float64Array; private own: Float64Array; private primedFail: Uint8Array; private explicitPrimed: Uint8Array;
  private coolerCount = 0;
  private queue: Int32Array; private coolerList: Int32Array; private inQueue: Uint8Array; private bunchDone: Uint8Array;
  lineType: Uint8Array; lineTarget: Int32Array; lineFlux: Float64Array; lineEff: Float64Array; lineLen: Uint8Array;
  running: Uint8Array;
  /** per position */
  flux: Float64Array; heatMult: Int32Array;
  inEff: Float64Array; inFlux: Float64Array; inSet: Uint8Array; // per (i*6+d)
  modState: Uint8Array; // 0 unused, 1 passive, 2 active
  reflActive: Uint8Array;
  valid: Uint8Array; failed: Uint8Array;
  cluster: Int32Array;
  srcEff: Float64Array;
  stats!: ReactorStats;

  // ---- incremental evaluation ----
  /** Copy of the last evaluated grid; the neutronics phase is reused when only non-neutronic blocks changed. */
  /**
   * Two neutronics cache slots (double buffering): one for the current layout and one for the last
   * proposal, so evaluating a cooler-only move right after a rejected structural move stays cheap.
   */
  private slots: NeutronSlot[] = [];
  private cur = 0;
  /** Counters: full evaluations vs. evaluations that reused the cached neutronics. */
  fullEvals = 0; partialEvals = 0;
  /** Static per-position neighbour masks for cooler positions: [casing, conductor, active moderator, active reflector, running fuel]. */
  /** Packed static neighbour masks per position: casing | conductor<<6 | active moderator<<12 | active reflector<<18 | running fuel<<24. */
  private sp: Int32Array;
  // incremental cooler solve state (grid of the last cooler solve, scratch marks)
  private coolGrid: Uint8Array; private coolReady = false; private nVersion = 0; private coolVersion = -1; private nCode: Uint8Array;
  private mark: Uint8Array; private changedList: Int32Array; private dList: Int32Array;
  /** dep[a*32+b] = 1 if the rules of cooler types a and b reference each other (either way). */
  private dep: Uint8Array;
  /** Statistics: dynamic coolers re-solved vs. total dynamic coolers (incremental cooler solve). */
  coolerSolved = 0; coolerTotal = 0; solves = 0;
  private casingMask: Uint8Array;
  // compiled placement rules
  private ruleAnd: Uint8Array; private ruleStatic: Uint8Array; private subStart: Int32Array;
  private subTarget: Int8Array; private subType: Int8Array; private subTable: Uint8Array;

  constructor(dims: [number, number, number], opts: SimOptions) {
    const [X, Y, Z] = dims;
    if ([X, Y, Z].some((v) => v < FISSION_CONFIG.minSize || v > FISSION_CONFIG.maxSize || !Number.isInteger(v))) {
      throw new Error(`Interior dimensions must be integers between ${FISSION_CONFIG.minSize} and ${FISSION_CONFIG.maxSize}`);
    }
    if (opts.fuel.reactor !== opts.reactor) throw new Error(`Fuel ${opts.fuel.name} cannot be used in a ${opts.reactor.toUpperCase()}`);
    if (opts.fuel.intrinsicFlux !== 0) throw new Error('Fuels with intrinsic flux (TRISO / pebble bed) are not supported');
    this.X = X; this.Y = Y; this.Z = Z; this.N = X * Y * Z;
    this.opts = opts; this.fuel = opts.fuel;
    const N = this.N;
    this.nb = new Int32Array(N * 6);
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      const i = this.index(x, y, z);
      for (let d = 0; d < 6; d++) {
        const [dx, dy, dz] = DIRS[d];
        const nx = x + dx, ny = y + dy, nz = z + dz;
        this.nb[i * 6 + d] = nx < 0 || ny < 0 || nz < 0 || nx >= X || ny >= Y || nz >= Z ? -1 : this.index(nx, ny, nz);
      }
    }
    this.rules = (opts.reactor === 'sfr' ? SINK_RULES : HEATER_RULES).map((r) => parseRule(r, opts.reactor));
    this.bunchOf = new Int32Array(N);
    this.fuelList = new Int32Array(N); this.memberList = new Int32Array(N); this.memberStart = new Int32Array(N + 1);
    this.bunchSize = new Int32Array(N); this.bunchOpenFaces = new Int32Array(N);
    this.bunchFlux = new Float64Array(N);
    this.bunchRaw = new Float64Array(N); this.bunchEff = new Float64Array(N); this.bunchBase = new Float64Array(N); this.bunchPrimed = new Uint8Array(N); this.bunchEmit = new Uint8Array(N);
    this.incoming = new Float64Array(N); this.own = new Float64Array(N); this.primedFail = new Uint8Array(N); this.explicitPrimed = new Uint8Array(N);
    this.queue = new Int32Array(N * 7 + 8); this.coolerList = new Int32Array(N); this.inQueue = new Uint8Array(N); this.bunchDone = new Uint8Array(N);
    this.lineType = new Uint8Array(N * 6); this.lineTarget = new Int32Array(N * 6);
    this.lineFlux = new Float64Array(N * 6); this.lineEff = new Float64Array(N * 6); this.lineLen = new Uint8Array(N * 6);
    this.running = new Uint8Array(N); this.flux = new Float64Array(N); this.heatMult = new Int32Array(N);
    this.inEff = new Float64Array(N * 6); this.inFlux = new Float64Array(N * 6); this.inSet = new Uint8Array(N * 6);
    this.modState = new Uint8Array(N); this.reflActive = new Uint8Array(N);
    this.valid = new Uint8Array(N); this.failed = new Uint8Array(N); this.cluster = new Int32Array(N);
    this.srcEff = new Float64Array(N);
    this.sp = new Int32Array(N);
    this.nCode = new Uint8Array(N);
    this.coolGrid = new Uint8Array(N); this.mark = new Uint8Array(N); this.changedList = new Int32Array(N); this.dList = new Int32Array(N);
    this.casingMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) { let m = 0; for (let d = 0; d < 6; d++) if (this.nb[i * 6 + d] < 0) m |= 1 << d; this.casingMask[i] = m; }
    // compile rules: per sub-rule a 64-entry truth table over the 6-direction satisfied mask
    const R = this.rules.length;
    this.ruleAnd = new Uint8Array(R); this.ruleStatic = new Uint8Array(R); this.subStart = new Int32Array(R + 1);
    const nSubs = this.rules.reduce((a, r) => a + r.subs.length, 0);
    this.subTarget = new Int8Array(nSubs); this.subType = new Int8Array(nSubs); this.subTable = new Uint8Array(nSubs * 64);
    let k = 0;
    for (let r = 0; r < R; r++) {
      const rule = this.rules[r];
      this.ruleAnd[r] = rule.op === 'and' ? 1 : 0;
      this.subStart[r] = k;
      let isStatic = 1;
      for (const sub of rule.subs) {
        this.subTarget[k] = TARGET_CODE[sub.target];
        this.subType[k] = sub.coolerType;
        if (sub.target === 'cooler') isStatic = 0;
        for (let m = 0; m < 64; m++) this.subTable[k * 64 + m] = adjacentSatisfied(sub, m) ? 1 : 0;
        k++;
      }
      this.ruleStatic[r] = isStatic;
    }
    this.subStart[R] = k;
    // cooler-type dependency matrix (symmetric)
    this.dep = new Uint8Array(R * 32);
    for (let a = 0; a < R; a++) for (const sub of this.rules[a].subs) {
      if (sub.target !== 'cooler') continue;
      for (let b = 0; b < R; b++) if (sub.coolerType < 0 || sub.coolerType === b) { this.dep[a * 32 + b] = 1; this.dep[b * 32 + a] = 1; }
    }
  }

  /** Forget cached state (forces a full evaluation next time). */
  invalidate() { for (const sl of this.slots) sl.ready = false; this.coolReady = false; }
  private ensureSlots() {
    if (this.slots.length) return;
    const mk = (copy: boolean): NeutronSlot => {
      const c = <T extends { slice(): T }>(x: T) => (copy ? x.slice() : x);
      return {
        sig: new Uint8Array(this.N), ready: false, primed: undefined, fuelCount: 0, bunchCount: 0, version: 0,
        fuelList: c(this.fuelList),
        bunchOf: c(this.bunchOf),
        bunchSize: c(this.bunchSize),
        bunchOpenFaces: c(this.bunchOpenFaces),
        bunchFlux: c(this.bunchFlux),
        bunchPrimed: c(this.bunchPrimed),
        bunchEmit: c(this.bunchEmit),
        memberList: c(this.memberList),
        memberStart: c(this.memberStart),
        lineType: c(this.lineType),
        lineTarget: c(this.lineTarget),
        lineFlux: c(this.lineFlux),
        lineEff: c(this.lineEff),
        lineLen: c(this.lineLen),
        running: c(this.running),
        flux: c(this.flux),
        heatMult: c(this.heatMult),
        inEff: c(this.inEff),
        inFlux: c(this.inFlux),
        inSet: c(this.inSet),
        modState: c(this.modState),
        reflActive: c(this.reflActive),
        srcEff: c(this.srcEff),
        bunchRaw: c(this.bunchRaw),
        bunchEff: c(this.bunchEff),
        bunchBase: c(this.bunchBase),
        nCounts: c(this.nCounts),
      };
    };
    this.slots = [mk(false), mk(true)];
  }
  private useSlot(k: number) {
    const o = this.slots[this.cur];
    o.fuelCount = this.fuelCount; o.bunchCount = this.bunchCount;
    this.cur = k;
    const s = this.slots[k];
    this.fuelCount = s.fuelCount; this.bunchCount = s.bunchCount;
    this.fuelList = s.fuelList;
    this.bunchOf = s.bunchOf;
    this.bunchSize = s.bunchSize;
    this.bunchOpenFaces = s.bunchOpenFaces;
    this.bunchFlux = s.bunchFlux;
    this.bunchPrimed = s.bunchPrimed;
    this.bunchEmit = s.bunchEmit;
    this.memberList = s.memberList;
    this.memberStart = s.memberStart;
    this.lineType = s.lineType;
    this.lineTarget = s.lineTarget;
    this.lineFlux = s.lineFlux;
    this.lineEff = s.lineEff;
    this.lineLen = s.lineLen;
    this.running = s.running;
    this.flux = s.flux;
    this.heatMult = s.heatMult;
    this.inEff = s.inEff;
    this.inFlux = s.inFlux;
    this.inSet = s.inSet;
    this.modState = s.modState;
    this.reflActive = s.reflActive;
    this.srcEff = s.srcEff;
    this.bunchRaw = s.bunchRaw;
    this.bunchEff = s.bunchEff;
    this.bunchBase = s.bunchBase;
    this.nCounts = s.nCounts;
  }
  private slotMatches(sl: NeutronSlot, grid: Uint8Array) {
    if (!sl.ready || sl.primed !== this.opts.primed) return false;
    const sig = sl.sig, N = this.N;
    for (let i = 0; i < N; i++) { const b = grid[i]; if ((NEUTRONIC[b] ? b : 0) !== sig[i]) return false; }
    return true;
  }

  index(x: number, y: number, z: number) { return x + this.X * (y + this.Y * z); }
  coords(i: number): [number, number, number] {
    const x = i % this.X, y = Math.floor(i / this.X) % this.Y, z = Math.floor(i / (this.X * this.Y));
    return [x, y, z];
  }

  /** Runs the full steady-state simulation. Returns aggregated stats; per-block state stays in the buffers. */
  evaluate(grid: Uint8Array): ReactorStats {
    if (grid.length !== this.N) throw new Error(`Grid length ${grid.length} != ${this.N}`);
    const N = this.N;
    for (let i = 0; i < N; i++) if (grid[i] >= NUM_BLOCKS) throw new Error(`Invalid block id ${grid[i]} at ${i}`);
    this.grid = grid;
    this.ensureSlots();
    if (this.slotMatches(this.slots[this.cur], grid)) this.partialEvals++;
    else if (this.slotMatches(this.slots[1 - this.cur], grid)) { this.useSlot(1 - this.cur); this.partialEvals++; }
    else {
      // flux / criticality / moderator activity only depend on fuel, moderator and reflector positions:
      // recompute them into the other slot (keeps the current one for a likely revert)
      // moderator lines of fuel components whose rays avoid every changed cell are reused from the slot
      const tgt = this.slots[1 - this.cur];
      let nchg = -1;
      if (tgt.ready) {
        nchg = 0;
        const sig = tgt.sig, chg = this.nChanged;
        for (let i = 0; i < N && nchg >= 0; i++) { const b = grid[i]; if ((NEUTRONIC[b] ? b : 0) !== sig[i]) { if (nchg >= 6) nchg = -1; else chg[nchg++] = i; } }
      }
      this.useSlot(1 - this.cur);
      const sl = this.slots[this.cur];
      sl.ready = false;
      this.buildFuelBunches();
      if (nchg >= 0) this.retraceAround(nchg); else this.traceLines();
      this.solveCriticality();
      this.computeModeratorsAndHeatMult();
      this.computeBunchHeat();
      for (let i = 0; i < N; i++) { const b = grid[i]; sl.sig[i] = NEUTRONIC[b] ? b : 0; }
      sl.primed = this.opts.primed; sl.ready = true; sl.version = ++this.nVersion;
      this.fullEvals++;
    }
    this.solveCoolers();
    this.buildClusters();
    return (this.stats = this.computeStats());
  }

  // ---------------------------------------------------------------- fuel bunches
  private buildFuelBunches() {
    const { grid, N, nb } = this;
    let fc = 0;
    const fl = this.fuelList;
    for (let i = 0; i < N; i++) if (grid[i] === FUEL) fl[fc++] = i;
    this.fuelCount = fc;
    const bunchOf = this.bunchOf; bunchOf.fill(-1);
    const ml = this.memberList, ms = this.memberStart;
    let B = 0, w = 0;
    if (this.opts.reactor === 'sfr') {
      // Solid fuel cells never bunch: each cell is its own unit (surface factor 1, bunching factor 1).
      for (let k = 0; k < fc; k++) { const i = fl[k]; bunchOf[i] = B; ms[B] = w; ml[w++] = i; B++; }
    } else {
      // MoltenSaltFissionLogic.formFuelBunches: face-adjacent vessels with the same fuel form one bunch.
      for (let k = 0; k < fc; k++) {
        const s0 = fl[k];
        if (bunchOf[s0] >= 0) continue;
        const id = B++; ms[id] = w; ml[w++] = s0; bunchOf[s0] = id;
        for (let q = ms[id]; q < w; q++) {
          const i = ml[q];
          for (let d = 0; d < 6; d++) { const j = nb[i * 6 + d]; if (j >= 0 && grid[j] === FUEL && bunchOf[j] < 0) { bunchOf[j] = id; ml[w++] = j; } }
        }
      }
    }
    ms[B] = w;
    this.bunchCount = B;
    for (let b = 0; b < B; b++) {
      this.bunchSize[b] = ms[b + 1] - ms[b];
      let open = 0;
      for (let q = ms[b]; q < ms[b + 1]; q++) { const i = ml[q]; for (let d = 0; d < 6; d++) { const j = nb[i * 6 + d]; if (j < 0 || bunchOf[j] !== b) open++; } }
      this.bunchOpenFaces[b] = open;
    }
  }
  /** Members of bunch b (allocates; for analysis code, not the hot path). */
  members(b: number): number[] { return Array.from(this.memberList.subarray(this.memberStart[b], this.memberStart[b + 1])); }
  /** FissionFuelBunch.getSurfaceFactor (integer division as in source) */
  surfaceFactor(b: number) { return Math.floor(this.bunchOpenFaces[b] / 6); }
  /** FissionFuelBunch.getBunchingFactor */
  bunchingFactor(b: number) { return Math.floor((6 * this.bunchSize[b]) / this.bunchOpenFaces[b]); }
  criticalityThreshold(b: number) { return this.surfaceFactor(b) * this.fuel.criticality; }

  // ---------------------------------------------------------------- moderator lines
  /** IFissionFuelComponent.defaultDistributeFlux, geometry part (independent of activity). */
  private traceLines() {
    for (let k = 0; k < this.fuelCount; k++) this.traceFuel(this.fuelList[k]);
  }
  /** Re-traces only the lines whose ray (reach + 1 blocks) passes through one of the changed cells. */
  private retraceAround(nchg: number) {
    const { nb, grid, reach } = this;
    if (this.retraceMark.length !== this.N) this.retraceMark = new Uint8Array(this.N);
    const m = this.retraceMark;
    const list = this.dList; let n = 0;
    for (let k = 0; k < nchg; k++) {
      const c = this.nChanged[k];
      if (grid[c] === FUEL && !m[c]) { m[c] = 1; list[n++] = c; }
      for (let d = 0; d < 6; d++) {
        let p = c;
        for (let s = 0; s <= reach; s++) {
          p = nb[p * 6 + d];
          if (p < 0) break;
          if (grid[p] === FUEL && !m[p]) { m[p] = 1; list[n++] = p; }
        }
      }
    }
    for (let k = 0; k < n; k++) { const f = list[k]; m[f] = 0; this.traceFuel(f); }
  }
  /** IFissionFuelComponent.defaultDistributeFlux, geometry part (independent of activity), for fuel component f. */
  private traceFuel(f: number) {
    const { grid, nb, reach } = this;
    for (let d = 0; d < 6; d++) {
      const li = f * 6 + d;
      this.lineType[li] = 0;
      let p = nb[li];
      if (p < 0 || !isModerator(grid[p])) continue; // first block must be a (non-blocking) moderator
      let fluxSum = MODERATORS[grid[p] - MOD0].fluxFactor;
      let effSum = MODERATORS[grid[p] - MOD0].efficiency;
      for (let i = 2; i <= reach + 1; i++) {
        p = nb[p * 6 + d];
        if (p < 0) break; // casing ends the line
        const b = grid[p];
        if (isModerator(b)) {
          fluxSum += MODERATORS[b - MOD0].fluxFactor; effSum += MODERATORS[b - MOD0].efficiency;
          continue;
        }
        const mods = i - 1;
        if (b === FUEL) {
          this.lineType[li] = 1; this.lineTarget[li] = p; this.lineFlux[li] = fluxSum; this.lineEff[li] = effSum / mods; this.lineLen[li] = mods;
        } else if (isReflector(b) && mods <= Math.floor(reach / 2)) {
          const r = REFLECTORS[b - REFL0];
          this.lineType[li] = 2; this.lineTarget[li] = p;
          this.lineFlux[li] = Math.floor(2 * fluxSum * r.reflectivity);
          this.lineEff[li] = (r.efficiency * effSum) / mods; this.lineLen[li] = mods;
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------- criticality
  /**
   * refreshFlux / distributeFlux fixed point:
   *  - primed units emit flux along all their moderator lines;
   *  - any unit whose accumulated flux reaches criticality starts running and emits too;
   *  - primed units that end up below criticality are put in the primed-fail cache and the search restarts.
   */
  private solveCriticality() {
    const B = this.bunchCount, ml = this.memberList, ms = this.memberStart;
    const { lineType, lineTarget, lineFlux, bunchOf, incoming, own, queue } = this;
    const primedFail = this.primedFail; primedFail.fill(0, 0, B);
    const srcEff = this.srcEff;
    for (let k = 0; k < this.fuelCount; k++) srcEff[this.fuelList[k]] = 1;
    let explicit = false;
    const explicitPrimed = this.explicitPrimed;
    if (this.opts.primed && !this.fuel.selfPriming) {
      // TileFissionSource.getPrimingTarget -> setSourceEfficiency(eff, maximize=true); FissionFuelBunch.tryPriming
      // needs at least surfaceFactor sources for a bunch to become primed (always 1 for solid fuel cells).
      explicit = true;
      const sources = new Int32Array(B);
      const best = new Map<number, number>();
      for (const p of this.opts.primed) {
        if (this.grid[p.index] !== FUEL) continue;
        sources[bunchOf[p.index]]++;
        best.set(p.index, Math.max(best.get(p.index) ?? 0, p.efficiency));
      }
      for (let b = 0; b < B; b++) explicitPrimed[b] = sources[b] > 0 && sources[b] >= this.surfaceFactor(b) ? 1 : 0;
      for (const [i, e] of best) srcEff[i] = e;
    }
    const emit = this.bunchEmit;
    for (;;) {
      emit.fill(0, 0, B); incoming.fill(0, 0, B); own.fill(0, 0, B);
      let qh = 0, qt = 0;
      for (let b = 0; b < B; b++) {
        const primed = explicit ? explicitPrimed[b] : 1;
        this.bunchPrimed[b] = primed && !primedFail[b] ? 1 : 0;
        if (this.bunchPrimed[b]) { emit[b] = 1; queue[qt++] = b; }
      }
      while (qh < qt) {
        const b = queue[qh++];
        for (let q = ms[b]; q < ms[b + 1]; q++) {
          const f = ml[q];
          for (let d = 0; d < 6; d++) {
            const li = f * 6 + d, t = lineType[li];
            if (t === 1) {
              const tb = bunchOf[lineTarget[li]];
              incoming[tb] += lineFlux[li];
              if (!emit[tb] && incoming[tb] >= this.criticalityThreshold(tb)) { emit[tb] = 1; queue[qt++] = tb; }
            } else if (t === 2) {
              own[b] += lineFlux[li];
            }
          }
        }
      }
      let anyFail = false;
      for (let b = 0; b < B; b++) {
        this.bunchFlux[b] = incoming[b] + (emit[b] ? own[b] : 0);
        if (emit[b] && this.bunchFlux[b] < this.criticalityThreshold(b)) { primedFail[b] = 1; anyFail = true; }
      }
      if (!anyFail) break;
    }
    this.running.fill(0);
    for (let b = 0; b < B; b++) if (emit[b]) for (let q = ms[b]; q < ms[b + 1]; q++) this.running[ml[q]] = 1;
  }

  // ---------------------------------------------------------------- heat multipliers & moderators
  private computeModeratorsAndHeatMult() {
    const { fuelList, fuelCount, lineType, lineTarget, lineFlux, lineEff, lineLen, running } = this;
    this.heatMult.fill(0); this.flux.fill(0); this.inSet.fill(0);
    this.modState.fill(0); this.reflActive.fill(0);
    for (let k = 0; k < fuelCount; k++) {
      const f = fuelList[k];
      if (!running[f]) continue; // only running (emitting) components distribute flux
      for (let d = 0; d < 6; d++) {
        const li = f * 6 + d, t = lineType[li];
        if (t === 0) continue;
        const target = lineTarget[li];
        if (t === 1) {
          const tli = target * 6 + opposite(d);
          this.heatMult[target]++;
          this.flux[target] += lineFlux[li];
          this.inSet[tli] = 1; this.inFlux[tli] = lineFlux[li]; this.inEff[tli] = lineEff[li];
          if (running[target]) this.markLine(f, d, lineLen[li], true);
        } else {
          this.heatMult[f]++;
          this.flux[f] += lineFlux[li];
          this.inSet[li] = 1; this.inFlux[li] = lineFlux[li]; this.inEff[li] = lineEff[li];
          this.markLine(f, d, lineLen[li], false);
          this.reflActive[target] = 1;
        }
      }
    }
  }
  /** First moderator (and last, for fuel-to-fuel lines) is active; the rest are passive. */
  private markLine(f: number, d: number, len: number, lastActive: boolean) {
    let p = f;
    for (let m = 1; m <= len; m++) {
      p = this.nb[p * 6 + d];
      const active = m === 1 || (lastActive && m === len);
      if (active) this.modState[p] = 2;
      else if (this.modState[p] === 0) this.modState[p] = 1;
    }
  }

  // ---------------------------------------------------------------- cooling components
  /** Bitmask of directions in which the rule's dependency is satisfied for position i. */
  satisfiedMask(i: number, sub: PlacementRule['subs'][number]): number {
    const t = TARGET_CODE[sub.target];
    return t === 5 ? this.coolerMask(i, sub.coolerType) : t === 6 ? 0 : this.staticMaskAt(i, t);
  }
  /** Mask of neighbours of i that are of static kind t (0 casing, 1 conductor, 2 active moderator, 3 active reflector, 4 running fuel). */
  private staticMaskAt(i: number, t: number): number {
    if (t === 0) return this.casingMask[i];
    const { nb, grid } = this;
    let m = 0;
    for (let d = 0; d < 6; d++) {
      const j = nb[i * 6 + d];
      if (j < 0) continue;
      const ok = t === 1 ? grid[j] === CONDUCTOR : t === 2 ? this.modState[j] === 2 : t === 3 ? this.reflActive[j] === 1 : this.running[j] === 1;
      if (ok) m |= 1 << d;
    }
    return m;
  }
  /** Packed static masks of position i (one neighbour pass). */
  private packedStatic(i: number): number {
    const { nb, grid } = this;
    let cond = 0, mod = 0, refl = 0, fuel = 0;
    for (let d = 0; d < 6; d++) {
      const j = nb[i * 6 + d];
      if (j < 0) continue;
      const b = grid[j], bit = 1 << d;
      if (b === CONDUCTOR) cond |= bit;
      else if (b === FUEL) { if (this.running[j]) fuel |= bit; }
      else if (this.modState[j] === 2) mod |= bit;
      else if (this.reflActive[j]) refl |= bit;
    }
    return this.casingMask[i] | (cond << 6) | (mod << 12) | (refl << 18) | (fuel << 24);
  }
  private coolerMask(i: number, type: number): number {
    const { nb, grid, valid } = this;
    let m = 0;
    for (let d = 0; d < 6; d++) {
      const j = nb[i * 6 + d];
      if (j >= 0 && valid[j] === 1 && grid[j] >= COOLER0 && (type < 0 || grid[j] - COOLER0 === type)) m |= 1 << d;
    }
    return m;
  }
  /** Rule check given the packed static masks of position i. */
  private checkRule(i: number, r: number, sp: number): boolean {
    const and = this.ruleAnd[r] === 1;
    const end = this.subStart[r + 1];
    for (let k = this.subStart[r]; k < end; k++) {
      const t = this.subTarget[k];
      const mask = t === 5 ? this.coolerMask(i, this.subType[k]) : t === 6 ? 0 : (sp >>> (6 * t)) & 63;
      const ok = this.subTable[k * 64 + mask] === 1;
      if (and ? !ok : ok) return !and;
    }
    return and;
  }
  ruleSatisfied(i: number, coolerType: number): boolean {
    return this.checkRule(i, coolerType, this.packedStatic(i));
  }
  /** First cooler type of `order` whose placement rule holds at i in the current state, or -1. */
  firstValidCooler(i: number, order: ArrayLike<number>): number {
    const p = this.packedStatic(i);
    for (let k = 0; k < order.length; k++) if (this.checkRule(i, order[k], p)) return order[k];
    return -1;
  }
  /** Cooler types of `types` whose placement rule holds at i in the current state. */
  validCoolerTypes(i: number, types: ArrayLike<number>, out: number[] = []): number[] {
    const p = this.packedStatic(i);
    out.length = 0;
    for (let k = 0; k < types.length; k++) if (this.checkRule(i, types[k], p)) out.push(types[k]);
    return out;
  }

  /**
   * Placement validity as reached by the cluster search: monotone growth of valid components, where
   * components with exact/at-most rules (requiresRecheck) that lose validity are added to the
   * component fail cache and the search restarts (FissionReactorLogic.refreshReactor loop).
   */
  private nseed = 0;
  private nChanged = new Int32Array(16); private retraceMark = new Uint8Array(0);
  /** Refreshes the static masks of cooler i; re-decides static rules; marks dynamic coolers whose inputs changed. */
  private visitCooler(i: number, full: boolean) {
    const { grid, nb, valid, failed, mark, dep, sp } = this;
    const t = grid[i] - COOLER0, p = this.packedStatic(i);
    const wasChanged = mark[i] === 2;
    if (wasChanged) mark[i] = 0;
    if (this.ruleStatic[t]) {
      const v = this.checkRule(i, t, p) ? 1 : 0;
      if (v !== valid[i] || wasChanged) {
        valid[i] = v;
        for (let d = 0; d < 6; d++) {
          const j = nb[i * 6 + d];
          if (j >= 0 && grid[j] >= COOLER0 && !this.ruleStatic[grid[j] - COOLER0] && dep[t * 32 + grid[j] - COOLER0] && mark[j] !== 1) { mark[j] = 1; this.nseed++; }
        }
      }
      failed[i] = 0;
    } else if ((full || wasChanged || p !== sp[i]) && mark[i] !== 1) { mark[i] = 1; this.nseed++; }
    sp[i] = p;
  }
  private solveCoolers() {
    const { grid, N, nb, valid, failed, mark, dep, sp, running, modState, reflActive, nCode } = this;
    const cl = this.coolerList, last = this.coolGrid, changed = this.changedList, D = this.dList;
    let nc = 0;
    for (let i = 0; i < N; i++) if (grid[i] >= COOLER0) cl[nc++] = i;
    this.coolerCount = nc; this.coolerTotal += nc; this.solves++;
    const version = this.slots.length ? this.slots[this.cur].version : 0;
    // touched cells: grid changes since the last solve, then cells whose neutronic outputs changed
    let nch = 0, nGrid = 0, full = !this.coolReady;
    if (!full) {
      for (let i = 0; i < N; i++) if (grid[i] !== last[i]) changed[nch++] = i;
      nGrid = nch;
      if (version !== this.coolVersion) {
        for (let i = 0; i < N; i++) {
          const c = running[i] | (modState[i] << 1) | (reflActive[i] << 3);
          if (c !== nCode[i]) changed[nch++] = i;
        }
      }
      if (nch * 6 > nc) full = true; // a full solve is cheaper than tracking many touched neighbourhoods
    }
    this.coolVersion = version;
    if (full) {
      this.coolReady = true; last.set(grid);
      for (let i = 0; i < N; i++) nCode[i] = running[i] | (modState[i] << 1) | (reflActive[i] << 3);
      valid.fill(0); failed.fill(0);
      let nd = 0;
      for (let k = 0; k < nc; k++) {
        const i = cl[k], t = grid[i] - COOLER0, p = this.packedStatic(i);
        sp[i] = p;
        if (this.ruleStatic[t]) valid[i] = this.checkRule(i, t, p) ? 1 : 0;
        else D[nd++] = i;
      }
      this.coolerSolved += nd;
      this.solveSubset(D, nd);
      return;
    }
    for (let k = 0; k < nGrid; k++) {
      const i = changed[k];
      last[i] = grid[i]; valid[i] = 0; failed[i] = 0;
      if (grid[i] >= COOLER0) mark[i] = 2; // changed cooler
    }
    for (let k = nGrid; k < nch; k++) { const i = changed[k]; nCode[i] = running[i] | (modState[i] << 1) | (reflActive[i] << 3); }
    // Static rules are re-decided directly around touched cells; dynamic coolers whose inputs may have changed are seeds.
    this.nseed = 0;
    for (let k = 0; k < nch; k++) {
      const c = changed[k];
      if (grid[c] >= COOLER0) this.visitCooler(c, false); // idempotent
      for (let d = 0; d < 6; d++) {
        const j = nb[c * 6 + d];
        if (j < 0 || grid[j] < COOLER0) continue;
        this.visitCooler(j, false);
        if (k < nGrid && !this.ruleStatic[grid[j] - COOLER0] && mark[j] !== 1) { mark[j] = 1; this.nseed++; }
      }
    }
    if (this.nseed === 0) return;
    // D = union of the dependency components (dynamic coolers linked through mutually referenced types) of the seeds
    const queue = this.queue;
    let qt = 0;
    for (let k = 0; k < nc; k++) { const i = cl[k]; if (mark[i] === 1) { queue[qt++] = i; mark[i] = 3; } }
    for (let qh = 0; qh < qt; qh++) {
      const i = queue[qh], ti = grid[i] - COOLER0;
      for (let d = 0; d < 6; d++) {
        const j = nb[i * 6 + d];
        if (j < 0 || grid[j] < COOLER0 || mark[j] === 3) continue;
        const tj = grid[j] - COOLER0;
        if (this.ruleStatic[tj] || !dep[ti * 32 + tj]) continue;
        mark[j] = 3; queue[qt++] = j;
      }
    }
    let nd = 0;
    for (let k = 0; k < nc; k++) { const i = cl[k]; if (mark[i] === 3) { D[nd++] = i; mark[i] = 0; valid[i] = 0; failed[i] = 0; } }
    this.coolerSolved += nd;
    this.solveSubset(D, nd);
  }

  /**
   * Monotone validity growth with fail-cache restarts over the dynamic coolers in L (index order); all other
   * coolers keep their (final) validity. Components that are not linked by rule dependencies are independent,
   * so solving only the affected ones reproduces the full solve.
   */
  private solveSubset(L: Int32Array, nc: number) {
    const { grid, nb, valid, failed, inQueue, queue, sp } = this;
    const cap = queue.length;
    for (let guard = 0; guard <= nc; guard++) {
      for (let k = 0; k < nc; k++) valid[L[k]] = 0;
      let restart = false;
      let qh = 0, qt = 0, size = 0;
      for (let k = 0; k < nc; k++) { const i = L[k]; if (!failed[i]) { queue[qt] = i; qt = (qt + 1) % cap; size++; inQueue[i] = 1; } }
      let budget = 64 * nc + 64;
      while (size > 0 && budget-- > 0) {
        const i = queue[qh]; qh = (qh + 1) % cap; size--; inQueue[i] = 0;
        const t = grid[i] - COOLER0;
        const ok = this.checkRule(i, t, sp[i]) ? 1 : 0;
        if (ok === valid[i]) continue;
        if (!ok && this.rules[t].requiresRecheck) { failed[i] = 1; restart = true; break; }
        valid[i] = ok;
        for (let d = 0; d < 6; d++) {
          const j = nb[i * 6 + d];
          if (j >= 0 && grid[j] >= COOLER0 && !failed[j] && !inQueue[j] && !this.ruleStatic[grid[j] - COOLER0] && this.dep[t * 32 + grid[j] - COOLER0]) { queue[qt] = j; qt = (qt + 1) % cap; size++; inQueue[j] = 1; }
        }
      }
      for (let k = 0; k < nc; k++) inQueue[L[k]] = 0;
      if (!restart) {
        // final recheck of assumed-valid components
        for (let k = 0; k < nc; k++) { const i = L[k]; if (valid[i] && !this.checkRule(i, grid[i] - COOLER0, sp[i])) { failed[i] = 1; restart = true; } }
      }
      if (!restart) return;
    }
  }

  // ---------------------------------------------------------------- clusters
  isHeatConductor(i: number) {
    const b = this.grid[i];
    return (b === FUEL && this.running[i] === 1) || (b >= COOLER0 && this.valid[i] === 1) || b === CONDUCTOR;
  }
  isFunctionalComponent(i: number) {
    const b = this.grid[i];
    return (b === FUEL && this.running[i] === 1) || (b >= COOLER0 && this.valid[i] === 1);
  }
  /** Cluster members are stored contiguously: clusterMembers[clusterStart[c] .. clusterStart[c+1]). */
  clusterCount = 0;
  clusterMembers = new Int32Array(0); clusterStart = new Int32Array(1);
  clusterWall = new Uint8Array(0);
  /** Members of cluster c (allocates; for analysis code, not the hot path). */
  clusterOf(c: number): number[] { return Array.from(this.clusterMembers.subarray(this.clusterStart[c], this.clusterStart[c + 1])); }
  private buildClusters() {
    const { N, nb, grid, running, valid } = this;
    if (this.clusterMembers.length !== N) { this.clusterMembers = new Int32Array(N); this.clusterStart = new Int32Array(N + 1); this.clusterWall = new Uint8Array(N); }
    const cl = this.cluster; cl.fill(-1);
    const m = this.clusterMembers, cs = this.clusterStart, cw = this.clusterWall;
    let C = 0, w = 0;
    const fl = this.fuelList, fc = this.fuelCount, kl = this.coolerList, kc = this.coolerCount;
    for (let a = 0, b = 0; a < fc || b < kc;) {
      // merge the (sorted) fuel and cooler lists so clusters are numbered in position order
      const s = b >= kc || (a < fc && fl[a] < kl[b]) ? fl[a++] : kl[b++];
      if (cl[s] >= 0) continue;
      const bs = grid[s];
      if (!((bs === FUEL && running[s] === 1) || (bs >= COOLER0 && valid[s] === 1))) continue;
      const id = C++; cs[id] = w; m[w++] = s; cl[s] = id; let wall = 0;
      for (let k = cs[id]; k < w; k++) {
        const i = m[k];
        for (let d = 0; d < 6; d++) {
          const j = nb[i * 6 + d];
          if (j < 0) { wall = 1; continue; }
          if (cl[j] >= 0) continue;
          const b = grid[j];
          if ((b === FUEL && running[j] === 1) || (b >= COOLER0 && valid[j] === 1) || b === CONDUCTOR) { cl[j] = id; m[w++] = j; }
        }
      }
      cw[id] = wall;
    }
    cs[C] = w;
    this.clusterCount = C;
  }

  /** Per fuel component efficiency (TileSolidFissionCell / TileSaltFissionVessel getEfficiency, without bunch scaling). */
  moderatorEfficiencyFactor(f: number) {
    let count = 0, eff = 0;
    for (let d = 0; d < 6; d++) {
      const li = f * 6 + d;
      if (this.inSet[li]) { count++; eff += this.inFlux[li] === 0 ? 0 : this.inEff[li]; }
    }
    return count === 0 ? 0 : eff / count;
  }
  fluxEfficiencyFactor(b: number) {
    const c = this.fuel.criticality;
    const fl = this.bunchFlux[b] / this.surfaceFactor(b);
    return (1 + Math.exp(-2 * c)) / (1 + Math.exp(2 * (fl - 2 * c)));
  }
  /** Efficiency of a single running fuel component as displayed in-game. */
  fuelEfficiency(f: number) {
    if (!this.running[f]) return 0;
    const b = this.bunchOf[f];
    const hm = this.bunchHeatMult(b) / this.bunchSize[b];
    return hm * this.fuel.efficiency * this.srcEff[f] * this.moderatorEfficiencyFactor(f) * this.fluxEfficiencyFactor(b);
  }
  bunchHeatMult(b: number) {
    let s = 0;
    for (let q = this.memberStart[b]; q < this.memberStart[b + 1]; q++) { const f = this.memberList[q]; if (this.running[f]) s += this.heatMult[f]; }
    return this.bunchingFactor(b) * s;
  }

  /** Heating contributions of each bunch; depends on neutronics only, so it is cached with it. */
  private computeBunchHeat() {
    const fuel = this.fuel;
    let am = 0, pm = 0, ar = 0;
    for (let i = 0; i < this.N; i++) { const m = this.modState[i]; if (m === 2) am++; else if (m === 1) pm++; if (this.reflActive[i]) ar++; }
    this.nCounts[0] = am; this.nCounts[1] = pm; this.nCounts[2] = ar;
    for (let b = 0; b < this.bunchCount; b++) {
      if (!this.bunchEmit[b]) { this.bunchRaw[b] = 0; this.bunchEff[b] = 0; this.bunchBase[b] = 0; continue; }
      const bf = this.bunchingFactor(b);
      const fluxEff = this.fluxEfficiencyFactor(b);
      let r = 0, e = 0, bs = 0;
      for (let q = this.memberStart[b]; q < this.memberStart[b + 1]; q++) {
        const f = this.memberList[q];
        if (!this.running[f]) continue;
        r += fuel.heat * this.heatMult[f];
        e += fuel.heat * this.heatMult[f] * fuel.efficiency * this.srcEff[f] * this.moderatorEfficiencyFactor(f) * fluxEff;
        bs += fuel.heat;
      }
      this.bunchRaw[b] = bf * r; this.bunchEff[b] = bf * e; this.bunchBase[b] = bf * bs;
    }
  }

  private computeStats(): ReactorStats {
    const { grid, N, fuel } = this;
    const cfg = FISSION_CONFIG;
    const sfr = this.opts.reactor === 'sfr';
    const clusters: ClusterStats[] = [];
    const activeMods = this.nCounts[0], passiveMods = this.nCounts[1], activeRefl = this.nCounts[2];
    const coolers = this.coolerCount;
    let validCoolers = 0;
    for (let k = 0; k < coolers; k++) if (this.valid[this.coolerList[k]]) validCoolers++;
    const bunchDone = this.bunchDone; bunchDone.fill(0, 0, this.bunchCount);
    const cm = this.clusterMembers, cs = this.clusterStart;
    for (let c = 0; c < this.clusterCount; c++) {
      let componentCount = 0, fuelCount = 0, raw = 0, cooling = 0, base = 0, eff = 0;
      for (let q = cs[c]; q < cs[c + 1]; q++) {
        const i = cm[q];
        const b = grid[i];
        if (!this.isFunctionalComponent(i)) continue;
        componentCount++;
        if (b === FUEL) {
          fuelCount++;
          const bunch = this.bunchOf[i];
          if (bunchDone[bunch]) continue;
          bunchDone[bunch] = 1;
          raw += this.bunchRaw[bunch]; eff += this.bunchEff[bunch]; base += this.bunchBase[bunch];
        } else {
          cooling += COOLING_RATES[b - COOLER0];
        }
      }
      const ocf = cooling === 0 ? 1 : Math.min(1, (raw + cfg.coolingEfficiencyLeniency) / cooling);
      const ulf = raw === 0 ? 1 : Math.min(1, (cooling + cfg.coolingEfficiencyLeniency) / raw);
      eff *= ocf;
      clusters.push({
        id: c, size: cs[c + 1] - cs[c], componentCount, fuelCount, connectedToWall: this.clusterWall[c] === 1,
        rawHeating: raw, cooling, netHeating: raw - cooling, totalBaseFuelHeating: base, effectiveHeating: eff,
        meanHeatMult: base <= 0 ? 0 : raw / base, meanEfficiency: base <= 0 ? 0 : eff / base,
        overcoolingEfficiencyFactor: ocf, undercoolingLifetimeFactor: ulf, heatingSpeedMultiplier: 0,
      });
    }
    // reactor totals
    let useful = 0, raw = 0, cooling = 0, base = 0, eff = 0, runningFuel = 0, disconnected = 0;
    for (const c of clusters) {
      if (c.fuelCount > 0 && !c.connectedToWall) disconnected++;
      if (sfr && !c.connectedToWall) continue; // SolidFuelFissionLogic only counts wall-connected clusters
      useful += c.componentCount; raw += c.rawHeating; cooling += c.cooling; base += c.totalBaseFuelHeating; eff += c.effectiveHeating;
      runningFuel += c.fuelCount;
    }
    useful += passiveMods + activeMods + activeRefl;
    const ratio = useful / N;
    const sparsity = ratio >= cfg.sparsityPenaltyThreshold ? 1
      : (1 - cfg.sparsityPenaltyMult) * Math.sin((ratio * Math.PI) / (2 * cfg.sparsityPenaltyThreshold)) + cfg.sparsityPenaltyMult;
    let effective = eff * sparsity;
    const hotCoolant: Record<string, number> = {};
    let meanHSM = 0;
    if (!sfr) {
      // MoltenSaltFissionLogic.refreshReactorStats: heater heating speed multipliers
      let weighted = 0, totalCooling = 0; effective = 0;
      for (const c of clusters) {
        c.heatingSpeedMultiplier = c.meanEfficiency * sparsity * (c.rawHeating >= c.cooling ? 1 : c.rawHeating / c.cooling);
        for (let q = cs[c.id]; q < cs[c.id + 1]; q++) {
          const i = cm[q];
          if (grid[i] >= COOLER0 && this.valid[i]) {
            const rate = COOLING_RATES[grid[i] - COOLER0];
            const hsm = c.heatingSpeedMultiplier;
            weighted += hsm * rate; totalCooling += rate; effective += hsm * rate;
            const key = HEATER_COOLANTS[grid[i] - COOLER0];
            hotCoolant[key] = (hotCoolant[key] ?? 0) + (hsm * rate) / cfg.heaterCoolantHeatPerMB;
          }
        }
      }
      meanHSM = totalCooling <= 0 ? 0 : weighted / totalCooling;
    }
    let maxNet = -Infinity, excess = 0;
    for (const c of clusters) {
      if (c.rawHeating > 0 || c.cooling > 0) maxNet = Math.max(maxNet, c.netHeating);
      if (c.netHeating > 0) excess += c.netHeating;
    }
    if (maxNet === -Infinity) maxNet = 0;
    let coolantInput = 0, outputFluid = 0, rf = 0, outputFluidName = '', fuelPerHour = 0;
    if (sfr) {
      const cool = SFR_COOLANTS.find((c) => c.id === (this.opts.sfrCoolant ?? 'water')) ?? SFR_COOLANTS[0];
      coolantInput = effective / cool.heatPerMB;
      outputFluid = coolantInput * cool.outputPerRecipe / cool.inputPerRecipe;
      outputFluidName = cool.product;
      rf = outputFluid * cool.rfPerOutputMB;
      // each running cell consumes one ingot per (time * undercoolingLifetimeFactor) ticks
      for (const c of clusters) if (c.connectedToWall && c.fuelCount > 0) fuelPerHour += (c.fuelCount * 72000) / (fuel.time * c.undercoolingLifetimeFactor);
    } else {
      outputFluid = Object.values(hotCoolant).reduce((a, b) => a + b, 0);
      outputFluidName = 'Hot coolant';
      for (const c of clusters) if (c.fuelCount > 0) fuelPerHour += (c.fuelCount * 72000 * 144) / (fuel.time * c.undercoolingLifetimeFactor);
    }
    const runningAll = clusters.reduce((a, c) => a + c.fuelCount, 0);
    const stable = excess <= 0;
    return {
      reactor: this.opts.reactor, dims: [this.X, this.Y, this.Z], interiorVolume: N,
      fuelComponents: this.fuelCount, runningFuelComponents: sfr ? runningFuel : runningAll,
      coolers, validCoolers, activeModerators: activeMods, passiveModerators: passiveMods, activeReflectors: activeRefl,
      usefulPartCount: useful, usefulPartRatio: ratio, sparsityEfficiencyMult: sparsity,
      clusterCount: clusters.length, rawHeating: raw, cooling, netHeating: raw - cooling, maxClusterNetHeating: maxNet, excessHeat: excess,
      totalBaseFuelHeating: base, effectiveHeating: effective,
      meanHeatMult: base <= 0 ? 0 : raw / base,
      meanEfficiency: base <= 0 ? 0 : (sfr ? effective / base : (eff * sparsity) / base),
      disconnectedFuelClusters: disconnected, stable,
      coolantInput, outputFluid, outputFluidName, rfPerTick: rf, fuelPerHour, fuelUnit: sfr ? 'ingots/h' : 'mB/h',
      hotCoolant, meanHeatingSpeedMultiplier: meanHSM, clusters,
    };
  }
}
