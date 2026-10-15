/**
 * NuclearCraft: Overhauled steam turbine model + optimizer.
 * Ported from nc.multiblock.turbine.{TurbineLogic, Turbine, TurbinePlacement, TurbineRotorBladeUtil, TurbineDynamoCoilType}
 * and nc.tile.turbine.TileTurbineDynamoPart with default NCConfig values.
 *
 * Geometry: interior D x D x L. The rotor axis runs along L between the two end walls, which carry the
 * bearings (sw x sw each, centered) and the dynamo coils. Each of the L interior layers is one blade set
 * of a single type (or a stator): 4 arms of (bladeLength x sw) around the sw x sw shaft; corners stay empty.
 */
import { FISSION_CONFIG, SFR_COOLANTS, type ReactorType } from './components.js';

export const TURBINE_CONFIG = {
  minSize: 1, maxSize: 24, // turbine_min_size / turbine_max_size
  mbPerBlade: 100, // turbine_mb_per_blade
  throughputLeniency: [0.5, 0.75] as const, // turbine_throughput_leniency_params
  tensionThroughputFactor: 2, // turbine_tension_throughput_factor
  tensionLeniency: 0.05, // turbine_tension_leniency
  powerBonusMultiplier: 1, // turbine_power_bonus_multiplier
  baseEnergyCapacity: 16000, // turbine_base_energy_capacity (per exterior block)
  baseMaxInput: 1000, baseMaxOutput: 4000, // Turbine.BASE_MAX_INPUT / OUTPUT (per exterior block)
  heatExchangerNakHeatMult: 2, // heat_exchanger_nak_coolant_heat_mult
};

export const TURBINE_BLADES = [
  { id: 'steel', name: 'Steel Rotor Blade', efficiency: 1.0, expansion: 1.4 },
  { id: 'extreme', name: 'Extreme Alloy Rotor Blade', efficiency: 1.1, expansion: 1.6 },
  { id: 'sic_sic_cmc', name: 'SiC-SiC CMC Rotor Blade', efficiency: 1.2, expansion: 1.8 },
] as const;
export const TURBINE_STATOR = { id: 'stator', name: 'Rotor Stator', expansion: 0.75 } as const;
export type BladeId = (typeof TURBINE_BLADES)[number]['id'] | 'stator';

/** Dynamo parts: 6 coils (turbine_coil_conductivity / turbine_coil_rule) + coil connector (no conductivity). */
export const TURBINE_COILS = [
  { id: 'magnesium', name: 'Magnesium Dynamo Coil', conductivity: 0.88, rule: 'one bearing || one connector' },
  { id: 'beryllium', name: 'Beryllium Dynamo Coil', conductivity: 0.9, rule: 'one magnesium coil' },
  { id: 'aluminum', name: 'Aluminum Dynamo Coil', conductivity: 1.0, rule: 'two magnesium coils' },
  { id: 'gold', name: 'Gold Dynamo Coil', conductivity: 1.04, rule: 'one aluminum coil' },
  { id: 'copper', name: 'Copper Dynamo Coil', conductivity: 1.06, rule: 'one beryllium coil' },
  { id: 'silver', name: 'Silver Dynamo Coil', conductivity: 1.12, rule: 'one gold coil && one copper coil' },
] as const;
export const TURBINE_CONNECTOR = { id: 'connector', name: 'Dynamo Coil Connector', rule: 'one of any coil' } as const;

/** TurbineRecipes: input fluid -> power per mB, ideal total expansion, product. */
export const TURBINE_FLUIDS = [
  { id: 'high_pressure_steam', name: 'High Pressure Steam', powerPerMB: 16, expansion: 4, product: 'Exhaust Steam', productPerMB: 4 },
  { id: 'low_pressure_steam', name: 'Low Pressure Steam', powerPerMB: 4, expansion: 2, product: 'Low Quality Steam', productPerMB: 2 },
  { id: 'steam', name: 'Steam', powerPerMB: 4, expansion: 2, product: 'Low Quality Steam', productPerMB: 2 },
  // pebble-bed gas coolers' hot gases (all sixteen share turbine_power_per_mb[3] / turbine_expansion_level[3])
  { id: 'hot_gas', name: 'Hot Gas Coolant', powerPerMB: 32, expansion: 2, product: 'Exhaust Gas', productPerMB: 2 },
] as const;

// wall cell codes
export const W_EMPTY = 0; // plain casing / glass
export const W_COIL0 = 1; // 1..6 = coils in TURBINE_COILS order
export const W_CONNECTOR = 7;
export const W_BEARING = 8;
export const W_VALVE = 9; // inlet / outlet (+ room for a controller elsewhere)

// ------------------------------------------------------------------ coil placement rules
type Target = 'bearing' | 'connector' | 'casing' | { coil: number | 'any' };
interface Atom { amount: number; count: 'atLeast' | 'exactly' | 'atMost'; axial: boolean; target: Target }
interface CoilRule { text: string; or: Atom[][] } // OR of AND-groups

const NUM: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4 };
function parseAtom(s: string): Atom {
  s = s.toLowerCase();
  const exact = s.includes('exact'), atMost = s.includes('at most'), axial = s.includes('axial');
  const words = s.split(/\s+/).filter(Boolean);
  let amount = -1, target: Target | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in NUM) amount = NUM[w];
    else if (!target) {
      if (w.includes('wall') || w.includes('casing')) target = 'casing';
      else if (w.includes('bearing')) target = 'bearing';
      else if (w.includes('connector')) target = 'connector';
      else if (w.includes('coil')) {
        const type = words[i - 1];
        target = { coil: type === 'any' ? 'any' : TURBINE_COILS.findIndex((c) => c.id === type) };
      }
    }
  }
  if (amount < 0 || !target) throw new Error(`Cannot parse turbine rule "${s}"`);
  return { amount, count: exact ? 'exactly' : atMost ? 'atMost' : 'atLeast', axial, target };
}
export function parseCoilRule(text: string): CoilRule {
  return { text, or: text.split('||').map((g) => g.split('&&').map((a) => parseAtom(a.trim()))) };
}
export const COIL_RULES = TURBINE_COILS.map((c) => parseCoilRule(c.rule));
export const CONNECTOR_RULE = parseCoilRule(TURBINE_CONNECTOR.rule);

/** Rules compiled to flat atoms: target code (W_BEARING, W_CONNECTOR, coil code, ANY_COIL, CASING), amount, count kind, axial. */
const ANY_COIL = 100, CASING = 101;
interface CAtom { target: number; amount: number; kind: 0 | 1 | 2; axial: boolean }
const compile = (r: CoilRule): CAtom[][] => r.or.map((g) => g.map((a) => ({
  target: a.target === 'bearing' ? W_BEARING : a.target === 'connector' ? W_CONNECTOR : a.target === 'casing' ? CASING : a.target.coil === 'any' ? ANY_COIL : W_COIL0 + a.target.coil,
  amount: a.amount, kind: a.count === 'atLeast' ? 0 : a.count === 'exactly' ? 1 : 2, axial: a.axial,
})));
const COMPILED: CAtom[][][] = [];
for (let c = 0; c <= W_VALVE; c++) COMPILED.push(c >= W_COIL0 && c < W_CONNECTOR ? compile(COIL_RULES[c - W_COIL0]) : c === W_CONNECTOR ? compile(CONNECTOR_RULE) : []);
let qBuf = new Int32Array(0), inQBuf = new Uint8Array(0);

/**
 * Evaluate one end wall (D x D cells). Validity is the fixed point reached by TurbineLogic.refreshDynamos'
 * search from magnesium coils (all default rules are "at least" rules, so this is the least fixed point).
 * Returns the conductivity contribution of this wall: sum(conductivity of valid coils) / max(sw^2, validCoils).
 */
export function evaluateWall(D: number, sw: number, wall: ArrayLike<number>, valid = new Uint8Array(D * D)) {
  valid.fill(0);
  const N = D * D;
  if (qBuf.length < N) { qBuf = new Int32Array(N); inQBuf = new Uint8Array(N); }
  const queue = qBuf, inQ = inQBuf; inQ.fill(0, 0, N);
  const matches = (j: number, target: number) => {
    const c = wall[j];
    if (target === W_BEARING) return c === W_BEARING;
    if (target === CASING) return false;
    if (!valid[j]) return false;
    if (target === W_CONNECTOR) return c === W_CONNECTOR;
    if (target === ANY_COIL) return c >= W_COIL0 && c < W_CONNECTOR;
    return c === target;
  };
  const ruleOk = (i: number) => {
    const groups = COMPILED[wall[i]];
    const x = i % D, y = (i / D) | 0;
    for (let g = 0; g < groups.length; g++) {
      let ok = true;
      for (const a of groups[g]) {
        let n = 0, h0 = false, h1 = false, h2 = false, h3 = false;
        h0 = x + 1 < D ? matches(i + 1, a.target) : a.target === CASING;
        h1 = x > 0 ? matches(i - 1, a.target) : a.target === CASING;
        h2 = y + 1 < D ? matches(i + D, a.target) : a.target === CASING;
        h3 = y > 0 ? matches(i - D, a.target) : a.target === CASING;
        n = +h0 + +h1 + +h2 + +h3;
        const sat = a.kind === 0 ? (a.axial ? ((h0 && h1) || (h2 && h3)) && n >= a.amount : n >= a.amount) : a.kind === 1 ? n === a.amount : n <= a.amount;
        if (!sat) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  };
  const isPart = (c: number) => c >= W_COIL0 && c <= W_CONNECTOR;
  let qn = 0;
  for (let i = 0; i < N; i++) if (isPart(wall[i])) { queue[qn++] = i; inQ[i] = 1; }
  while (qn > 0) {
    const i = queue[--qn]; inQ[i] = 0;
    if (valid[i] || !ruleOk(i)) continue;
    valid[i] = 1;
    const x = i % D, y = (i / D) | 0;
    if (x + 1 < D && !valid[i + 1] && !inQ[i + 1] && isPart(wall[i + 1])) { queue[qn++] = i + 1; inQ[i + 1] = 1; }
    if (x > 0 && !valid[i - 1] && !inQ[i - 1] && isPart(wall[i - 1])) { queue[qn++] = i - 1; inQ[i - 1] = 1; }
    if (y + 1 < D && !valid[i + D] && !inQ[i + D] && isPart(wall[i + D])) { queue[qn++] = i + D; inQ[i + D] = 1; }
    if (y > 0 && !valid[i - D] && !inQ[i - D] && isPart(wall[i - D])) { queue[qn++] = i - D; inQ[i - D] = 1; }
  }
  let coils = 0, sum = 0, connectors = 0, invalid = 0;
  const perType = TURBINE_COILS.map(() => 0);
  for (let i = 0; i < N; i++) {
    const c = wall[i];
    if (!isPart(c)) continue;
    if (!valid[i]) { invalid++; continue; }
    if (c === W_CONNECTOR) connectors++;
    else { coils++; sum += TURBINE_COILS[c - W_COIL0].conductivity; perType[c - W_COIL0]++; }
  }
  const conductivity = coils === 0 ? 0 : sum / Math.max(sw * sw, coils);
  return { conductivity, coils, connectors, invalid, perType, valid };
}

/** Blank end wall with the centered bearings and one valve slot in a corner. */
export function blankWall(D: number, sw: number): Uint8Array {
  const w = new Uint8Array(D * D);
  const bl = (D - sw) / 2;
  for (let y = bl; y < bl + sw; y++) for (let x = bl; x < bl + sw; x++) w[x + y * D] = W_BEARING;
  w[0] = W_VALVE;
  return w;
}

// ------------------------------------------------------------------ turbine simulation
export interface TurbineDesign {
  diameter: number; // interior width = height (D)
  shaftWidth: number;
  /** blade type per layer, from the inlet side; length = interior flow length L */
  blades: BladeId[];
  /** inlet-side and outlet-side end walls, D*D codes (W_*) */
  walls: [number[], number[]];
  fluidId: string;
}

export interface TurbineLayerStats { depth: number; type: BladeId; coefficient: number; idealExpansion: number; actualExpansion: number; ideality: number; efficiency: number }
export interface TurbineStats {
  valid: boolean;
  errors: string[];
  interior: [number, number, number];
  exterior: [number, number, number];
  bladeLength: number;
  bladeArea: number;
  bladeSets: number;
  statorSets: number;
  inputRate: number;
  /** recommended max input (mB/t) = blade volume x 100 */
  maxInputRate: number;
  /** above this the bearings accumulate tension and eventually fail */
  safeInputRate: number;
  overloaded: boolean;
  rawPower: number;
  conductivity: number;
  wallConductivity: [number, number];
  coilCounts: [number, number];
  rotorEfficiency: number;
  totalExpansion: number;
  idealTotalExpansion: number;
  expansionIdeality: number;
  throughputEfficiency: number;
  effectiveMaxLength: number;
  powerBonus: number;
  power: number;
  powerPerMB: number;
  /** product of all multipliers except raw power */
  overallEfficiency: number;
  outputFluid: string;
  outputRate: number;
  inertia: number;
  spinUpInertiaFactor: number;
  energyCapacity: number;
  inputTankCapacity: number;
  layers: TurbineLayerStats[];
  parts: Record<string, number>;
}

const coefOf = (t: BladeId) => (t === 'stator' ? TURBINE_STATOR.expansion : TURBINE_BLADES.find((b) => b.id === t)!.expansion);
const effOf = (t: BladeId) => (t === 'stator' ? -1 : TURBINE_BLADES.find((b) => b.id === t)!.efficiency);

export function throughputEfficiency(rate: number, maxRate: number, idealTotal: number, maxBladeExp: number) {
  const C = TURBINE_CONFIG;
  const effMinLen = idealTotal <= 1 || maxBladeExp <= 1 ? C.maxSize : Math.ceil(Math.log(idealTotal) / Math.log(maxBladeExp));
  const absLen = effMinLen * 4 * Math.max(1, C.minSize - 2) * C.mbPerBlade;
  const ratio = maxRate === 0 ? 1 : Math.min(1, (rate + absLen) / maxRate);
  const [m, t] = C.throughputLeniency;
  return ratio >= t ? 1 : (1 - m) * Math.sin((ratio * Math.PI) / (2 * t)) + m;
}
export function effectiveMaxLength(idealTotal: number, minBladeExp: number, minStatorExp: number) {
  const M = TURBINE_CONFIG.maxSize;
  if (minBladeExp <= 1 || minStatorExp >= 1) return M;
  const v = (Math.log(idealTotal) - M * Math.log(minStatorExp)) / (Math.log(minBladeExp) - Math.log(minStatorExp));
  return Math.ceil(Math.min(M, Math.max(1, v)));
}
export function powerBonus(rate: number, maxRate: number, bladeArea: number, flowLength: number, effMaxLen: number) {
  const C = TURBINE_CONFIG;
  const r = Math.min(rate, maxRate);
  const lengthBonus = r / (C.mbPerBlade * bladeArea * effMaxLen);
  const areaBonus = Math.sqrt((2 * r) / (C.mbPerBlade * flowLength * C.maxSize * effMaxLen));
  return 1 + C.powerBonusMultiplier * Math.pow(lengthBonus * areaBonus, 2 / 3);
}

/** Steady-state turbine performance for a constant input rate (mB/t), per TurbineLogic.onUpdateServer. */
export function simulateTurbine(design: TurbineDesign, inputRate: number): TurbineStats {
  const C = TURBINE_CONFIG;
  const { diameter: D, shaftWidth: sw, blades } = design;
  const L = blades.length;
  const fluid = TURBINE_FLUIDS.find((f) => f.id === design.fluidId) ?? TURBINE_FLUIDS[0];
  const errors: string[] = [];
  if (D < 3 || D > C.maxSize) errors.push(`diameter must be 3..${C.maxSize}`);
  if (L < C.minSize || L > C.maxSize) errors.push(`length must be ${C.minSize}..${C.maxSize}`);
  if (sw < 1 || sw > D - 2 || (D - sw) % 2 !== 0) errors.push('shaft width must leave equal blades (≥1) on both sides');
  const bl = (D - sw) / 2;
  const bladeArea = 4 * sw * bl;
  // blades / expansion
  let total = 1, nb = 0, ns = 0, minBlade = Infinity, maxBlade = 1, minStator = 1;
  const levels: number[] = [];
  for (const t of blades) {
    const k = coefOf(t);
    levels.push(total * Math.sqrt(k));
    total *= k;
    if (t === 'stator') { ns++; minStator = Math.min(minStator, k); } else { nb++; minBlade = Math.min(minBlade, k); maxBlade = Math.max(maxBlade, k); }
  }
  if (nb === 0) errors.push('needs at least one rotor blade set');
  const ideal = fluid.expansion;
  const layers: TurbineLayerStats[] = blades.map((t, d) => {
    const idealD = Math.pow(ideal, (d + 0.5) / L);
    const ideality = idealD < levels[d] ? idealD / levels[d] : levels[d] / idealD;
    return { depth: d, type: t, coefficient: coefOf(t), idealExpansion: idealD, actualExpansion: levels[d], ideality, efficiency: t === 'stator' ? 0 : effOf(t) * ideality };
  });
  const rotorEfficiency = nb === 0 ? 0 : layers.reduce((a, l) => a + l.efficiency, 0) / nb;
  const expansionIdeality = ideal <= 0 || total <= 0 ? 0 : ideal < total ? ideal / total : total / ideal;
  // dynamos
  const w0 = evaluateWall(D, sw, design.walls[0]), w1 = evaluateWall(D, sw, design.walls[1]);
  const conductivity = (w0.conductivity + w1.conductivity) / 2;
  if (w0.coils + w1.coils === 0) errors.push('no valid dynamo coils');
  // throughput
  const maxRate = bladeArea * nb * C.mbPerBlade;
  const safe = maxRate * (1 + C.tensionLeniency);
  const overloaded = inputRate > safe + 1e-9;
  const rate = Math.min(inputRate, maxRate * C.tensionThroughputFactor); // what the turbine can swallow at full tank
  const thr = throughputEfficiency(rate, maxRate, ideal, maxBlade);
  const eml = effectiveMaxLength(ideal, minBlade, minStator);
  const bonus = powerBonus(rate, maxRate, bladeArea, L, eml);
  const raw = rate * fluid.powerPerMB;
  const overall = conductivity * rotorEfficiency * expansionIdeality * thr * bonus;
  const power = nb === 0 ? 0 : raw * overall;
  // spin-up inertia (affects only how fast it reaches full power)
  const bearings = 2 * sw * sw;
  const mult = (Math.min(1, (1 + 2 * w0.coils) / bearings) + Math.min(1, (1 + 2 * w1.coils) / bearings)) / 2;
  const inertia = sw * (sw + 4 * bl) * L;
  const ext: [number, number, number] = [D + 2, D + 2, L + 2];
  const extVol = ext[0] * ext[1] * ext[2];
  const parts: Record<string, number> = { 'Rotor Bearing': bearings, 'Rotor Shaft': sw * sw * L, Inlet: 1, Outlet: 1, Controller: 1 };
  for (const t of blades) { const n = t === 'stator' ? TURBINE_STATOR.name : TURBINE_BLADES.find((b) => b.id === t)!.name; parts[n] = (parts[n] ?? 0) + bladeArea; }
  let dyn = 0;
  for (const w of design.walls) for (const c of w) {
    if (c >= W_COIL0 && c < W_CONNECTOR) { const n = TURBINE_COILS[c - W_COIL0].name; parts[n] = (parts[n] ?? 0) + 1; dyn++; }
    else if (c === W_CONNECTOR) { parts[TURBINE_CONNECTOR.name] = (parts[TURBINE_CONNECTOR.name] ?? 0) + 1; dyn++; }
  }
  const shell = extVol - D * D * L;
  parts['Turbine Casing / Glass'] = shell - bearings - dyn - 3;
  return {
    valid: errors.length === 0 && !overloaded, errors: overloaded ? [...errors, `input ${inputRate.toFixed(0)} mB/t exceeds the safe limit ${safe.toFixed(0)} mB/t (bearings would fail)`] : errors,
    interior: [D, D, L], exterior: ext, bladeLength: bl, bladeArea, bladeSets: nb, statorSets: ns,
    inputRate, maxInputRate: maxRate, safeInputRate: safe, overloaded, rawPower: raw,
    conductivity, wallConductivity: [w0.conductivity, w1.conductivity], coilCounts: [w0.coils, w1.coils],
    rotorEfficiency, totalExpansion: total, idealTotalExpansion: ideal, expansionIdeality, throughputEfficiency: thr, effectiveMaxLength: eml,
    powerBonus: bonus, power, powerPerMB: rate > 0 ? power / rate : 0, overallEfficiency: overall,
    outputFluid: fluid.product, outputRate: rate * fluid.productPerMB, inertia, spinUpInertiaFactor: mult,
    energyCapacity: C.baseEnergyCapacity * extVol, inputTankCapacity: C.baseMaxInput * extVol, layers, parts,
  };
}

// ------------------------------------------------------------------ optimization
export interface TurbineOptimizeConfig {
  /** total steam produced by the reactor, mB/t */
  steamRate: number;
  fluidId?: string;
  allowedBlades?: string[];
  allowStators?: boolean;
  allowedCoils?: string[];
  maxDiameter?: number;
  maxLength?: number;
  /** force this many identical turbines (default: as few as possible) */
  turbines?: number;
  seed?: number;
  /** coil-layout search effort (iterations per candidate wall) */
  coilIterations?: number;
}
export interface TurbineCandidate { design: TurbineDesign; stats: TurbineStats }
export interface TurbineOptimizeResult {
  turbines: number;
  steamPerTurbine: number;
  best: TurbineCandidate;
  totalPower: number;
  /** best design for each diameter (size / power trade-off) */
  alternatives: TurbineCandidate[];
  elapsedMs: number;
}

/** Steam (mB/t) a reactor's stats produce: SFR directly; MSR via an ideal heat exchanger (hot NaK -> water -> HP steam). */
export function reactorSteam(stats: { reactor: ReactorType; outputFluid: number; hotCoolant: Record<string, number> }): number {
  // SFR: high pressure steam; PBR: hot gas coolants drive the turbine directly
  if (stats.reactor !== 'msr') return stats.outputFluid;
  const water = SFR_COOLANTS[0];
  const hot = Object.values(stats.hotCoolant).reduce((a, b) => a + b, 0);
  const heat = hot * FISSION_CONFIG.heaterCoolantHeatPerMB * TURBINE_CONFIG.heatExchangerNakHeatMult;
  return (heat / water.heatPerMB) * (water.outputPerRecipe / water.inputPerRecipe);
}

/** Turbine fluid a reactor type produces (TURBINE_FLUIDS id). */
export const reactorTurbineFluid = (reactor: ReactorType) => (reactor === 'pbr' ? 'hot_gas' : 'high_pressure_steam');

interface BladePlan { blades: BladeId[]; q: number; nb: number; eml: number; maxBlade: number }

/**
 * Exact dynamic programme over blade sequences for a given flow length L. The per-layer contribution
 * depends only on the depth and the product of earlier coefficients, which is determined by how many blades
 * of each type came before - so (counts, used-type mask) is a sufficient state.
 * Returns, for every (bladeSets, effMaxLength, maxBlade) class, the plan maximising rotorEff x expansionIdeality.
 */
function bladePlans(L: number, ideal: number, types: BladeId[]): BladePlan[] {
  const T = types.length, B = L + 1;
  const coef = types.map(coefOf), eff = types.map(effOf);
  // state key = counts of the first T-1 types (base B) * 2^T + used mask; last type count = depth - others
  const enc = (cnt: number[], mask: number) => { let k = 0; for (let t = 0; t < T - 1; t++) k = k * B + cnt[t]; return k * (1 << T) + mask; };
  const dec = (key: number, depth: number) => {
    const mask = key % (1 << T); let k = Math.floor(key / (1 << T));
    const cnt = new Array(T).fill(0);
    for (let t = T - 2; t >= 0; t--) { cnt[t] = k % B; k = Math.floor(k / B); }
    cnt[T - 1] = depth - cnt.slice(0, T - 1).reduce((a, b) => a + b, 0);
    return { cnt, mask };
  };
  const logc = coef.map(Math.log);
  const levels: Map<number, { sum: number; parent: number; choice: number }>[] = [new Map([[enc(new Array(T).fill(0), 0), { sum: 0, parent: -1, choice: -1 }]])];
  for (let d = 0; d < L; d++) {
    const next = new Map<number, { sum: number; parent: number; choice: number }>();
    const lnIdeal = Math.log(ideal) * ((d + 0.5) / L);
    for (const [key, st] of levels[d]) {
      const { cnt, mask } = dec(key, d);
      let lnProd = 0; for (let t = 0; t < T; t++) lnProd += cnt[t] * logc[t];
      for (let t = 0; t < T; t++) {
        const lnLvl = lnProd + 0.5 * logc[t];
        const contrib = eff[t] < 0 ? 0 : eff[t] * Math.exp(-Math.abs(lnIdeal - lnLvl));
        cnt[t]++;
        const nk = enc(cnt, mask | (1 << t));
        cnt[t]--;
        const sum = st.sum + contrib;
        const prev = next.get(nk);
        if (!prev || prev.sum < sum) next.set(nk, { sum, parent: key, choice: t });
      }
    }
    levels.push(next);
  }
  const best = new Map<string, BladePlan & { key: number }>();
  for (const [key, st] of levels[L]) {
    const { cnt } = dec(key, L);
    let nb = 0, lnTotal = 0, minBlade = Infinity, maxBlade = 1, minStator = 1;
    for (let t = 0; t < T; t++) {
      lnTotal += cnt[t] * logc[t];
      if (!cnt[t]) continue;
      if (types[t] === 'stator') minStator = Math.min(minStator, coef[t]);
      else { nb += cnt[t]; minBlade = Math.min(minBlade, coef[t]); maxBlade = Math.max(maxBlade, coef[t]); }
    }
    if (nb === 0) continue;
    const q = (st.sum / nb) * Math.exp(-Math.abs(Math.log(ideal) - lnTotal));
    const eml = effectiveMaxLength(ideal, minBlade, minStator);
    const k = `${nb}|${eml}|${maxBlade}`;
    const prev = best.get(k);
    if (!prev || prev.q < q) best.set(k, { blades: [], q, nb, eml, maxBlade, key });
  }
  // reconstruct sequences
  const out: BladePlan[] = [];
  for (const p of best.values()) {
    const seq: BladeId[] = [];
    let key = p.key;
    for (let d = L; d > 0; d--) { const st = levels[d].get(key)!; seq.push(types[st.choice]); key = st.parent; }
    out.push({ blades: seq.reverse(), q: p.q, nb: p.nb, eml: p.eml, maxBlade: p.maxBlade });
  }
  return out;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Simulated annealing over one end wall maximising conductivity (sum / max(sw^2, coils)). */
export function optimizeWall(D: number, sw: number, allowedCoils: string[], iterations = 40000, seed = 1): { wall: number[]; conductivity: number } {
  const rnd = rng(seed);
  const wall = blankWall(D, sw);
  const free: number[] = [];
  for (let i = 0; i < D * D; i++) if (wall[i] === W_EMPTY) free.push(i);
  const codes = [W_EMPTY, W_CONNECTOR, ...TURBINE_COILS.map((c, k) => (allowedCoils.includes(c.id) ? W_COIL0 + k : -1)).filter((c) => c >= 0)];
  if (!free.length) return { wall: Array.from(wall), conductivity: 0 };
  const buf = new Uint8Array(D * D);
  // value with a small tie-breaker preferring fewer parts and no invalid parts
  const score = () => {
    const r = evaluateWall(D, sw, wall, buf);
    return r.conductivity - 1e-4 * r.invalid - 1e-6 * (r.coils + r.connectors);
  };
  // seed: ring of magnesium around the bearings
  const bl = (D - sw) / 2;
  for (const i of free) {
    const x = i % D, y = (i / D) | 0;
    if (x >= bl - 1 && x <= bl + sw && y >= bl - 1 && y <= bl + sw && allowedCoils.includes('magnesium')) wall[i] = W_COIL0;
  }
  let cur = score(), best = cur, bestWall = Array.from(wall);
  const T0 = 0.02;
  for (let it = 0; it < iterations; it++) {
    const T = T0 * Math.pow(1e-3, it / iterations);
    const i = free[Math.floor(rnd() * free.length)];
    const prev = wall[i];
    let c = codes[Math.floor(rnd() * codes.length)];
    if (c === prev) c = codes[(codes.indexOf(c) + 1) % codes.length];
    wall[i] = c;
    const s = score();
    if (s >= cur || rnd() < Math.exp((s - cur) / T)) {
      cur = s;
      if (s > best) { best = s; bestWall = Array.from(wall); }
    } else wall[i] = prev;
  }
  // cleanup: remove parts that are invalid or do not help
  const w = Uint8Array.from(bestWall);
  const base = evaluateWall(D, sw, w);
  for (let i = 0; i < w.length; i++) if (w[i] >= W_COIL0 && w[i] <= W_CONNECTOR && !base.valid[i]) w[i] = W_EMPTY;
  let ref = evaluateWall(D, sw, w).conductivity;
  for (let i = 0; i < w.length; i++) {
    if (w[i] < W_COIL0 || w[i] > W_CONNECTOR) continue;
    const p = w[i]; w[i] = W_EMPTY;
    const v = evaluateWall(D, sw, w).conductivity;
    if (v + 1e-12 >= ref) ref = v; else w[i] = p;
  }
  return { wall: Array.from(w), conductivity: ref };
}

export function optimizeTurbine(cfg: TurbineOptimizeConfig): TurbineOptimizeResult {
  const t0 = Date.now();
  const C = TURBINE_CONFIG;
  const fluid = TURBINE_FLUIDS.find((f) => f.id === (cfg.fluidId ?? 'high_pressure_steam')) ?? TURBINE_FLUIDS[0];
  const maxD = Math.min(C.maxSize, Math.max(3, cfg.maxDiameter ?? C.maxSize));
  const maxL = Math.min(C.maxSize, Math.max(1, cfg.maxLength ?? C.maxSize));
  const allowedBlades = (cfg.allowedBlades ?? TURBINE_BLADES.map((b) => b.id)).filter((b) => TURBINE_BLADES.some((x) => x.id === b)) as BladeId[];
  if (!allowedBlades.length) throw new Error('allow at least one rotor blade type');
  const types: BladeId[] = cfg.allowStators === false ? allowedBlades : [...allowedBlades, 'stator'];
  const allowedCoils = cfg.allowedCoils ?? TURBINE_COILS.map((c) => c.id);
  if (!allowedCoils.includes('magnesium')) throw new Error('magnesium coils are required: they are the only coils that attach to the bearings');
  if (!(cfg.steamRate > 0)) throw new Error('steam rate must be positive');

  // capacity of the largest allowed turbine -> number of turbines
  const capOf = (D: number) => { let best = 0; for (let sw = D % 2 === 0 ? 2 : 1; sw <= D - 2; sw += 2) best = Math.max(best, 4 * sw * ((D - sw) / 2)); return best; };
  const maxCap = capOf(maxD) * maxL * C.mbPerBlade * (1 + C.tensionLeniency);
  const turbines = Math.max(cfg.turbines ?? 1, Math.ceil(cfg.steamRate / maxCap - 1e-9));
  const S = cfg.steamRate / turbines;

  const plans: { L: number; plans: BladePlan[] }[] = [];
  for (let L = 1; L <= maxL; L++) plans.push({ L, plans: bladePlans(L, fluid.expansion, types) });

  // stage 1: best blades/geometry per (D, sw) ignoring conductivity (a common multiplier)
  type Cand = { D: number; sw: number; L: number; plan: BladePlan; score: number };
  const cands: Cand[] = [];
  for (let D = 3; D <= maxD; D++) for (let sw = D % 2 === 0 ? 2 : 1; sw <= D - 2; sw += 2) {
    const A = 4 * sw * ((D - sw) / 2);
    let best: Cand | null = null;
    for (const { L, plans: ps } of plans) for (const p of ps) {
      const maxRate = A * p.nb * C.mbPerBlade;
      if (S > maxRate * (1 + C.tensionLeniency) + 1e-9) continue;
      const thr = throughputEfficiency(S, maxRate, fluid.expansion, p.maxBlade);
      const bonus = powerBonus(S, maxRate, A, L, p.eml);
      const score = p.q * thr * bonus;
      // prefer the smaller turbine when equal within 1e-9
      if (!best || score > best.score + 1e-9) best = { D, sw, L, plan: p, score };
    }
    if (best) cands.push(best);
  }
  if (!cands.length) throw new Error('no turbine fits within the size limits');
  // stage 2: coil walls for the promising (D, sw) (conductivity ranges 0.88..1.12)
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0].score;
  const wallCache = new Map<string, { wall: number[]; conductivity: number }>();
  const cap = cfg.coilIterations ?? 120000;
  const evaluated: TurbineCandidate[] = [];
  for (const c of cands) {
    if (evaluated.length >= 8 || c.score * 1.12 < top * 0.88) break;
    const key = `${c.D}|${c.sw}`;
    let w = wallCache.get(key);
    if (!w) { w = optimizeWall(c.D, c.sw, allowedCoils, Math.min(cap, Math.max(15000, c.D * c.D * 300)), (cfg.seed ?? 1) + c.D * 31 + c.sw); wallCache.set(key, w); }
    const outlet = w.wall.slice();
    const design: TurbineDesign = { diameter: c.D, shaftWidth: c.sw, blades: c.plan.blades, walls: [w.wall, outlet], fluidId: fluid.id };
    evaluated.push({ design, stats: simulateTurbine(design, S) });
  }
  evaluated.sort((a, b) => b.stats.power - a.stats.power);
  const best = evaluated[0];
  // one alternative per diameter (best power), sorted by size
  const byD = new Map<number, TurbineCandidate>();
  for (const e of evaluated) { const p = byD.get(e.design.diameter); if (!p || p.stats.power < e.stats.power) byD.set(e.design.diameter, e); }
  const alternatives = [...byD.values()].sort((a, b) => a.design.diameter - b.design.diameter || a.design.blades.length - b.design.blades.length);
  return { turbines, steamPerTurbine: S, best, totalPower: best.stats.power * turbines, alternatives, elapsedMs: Date.now() - t0 };
}
