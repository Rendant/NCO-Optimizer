/**
 * Port of NuclearCraft's placement-rule system:
 *  - nc/multiblock/fission/FissionPlacement.java (DefaultRuleParser.partialParse)
 *  - nc/multiblock/PlacementRule.java (And / Or / Adjacent.satisfied)
 * Facing indices follow Minecraft's EnumFacing: 0 DOWN, 1 UP, 2 NORTH, 3 SOUTH, 4 WEST, 5 EAST.
 */
import { COOLER_NAMES, HEATER_NAMES, ReactorType } from './components.js';

export type CountType = 'atLeast' | 'exactly' | 'atMost';
export type AdjacencyType = 'standard' | 'axial' | 'vertex' | 'edge';
export type RuleTarget = 'casing' | 'conductor' | 'moderator' | 'reflector' | 'fuel' | 'cooler' | 'unsupported';

export interface AdjacentRule {
  target: RuleTarget;
  /** cooler type index, or -1 for "any" (only for target === 'cooler') */
  coolerType: number;
  amount: number;
  count: CountType;
  adj: AdjacencyType;
  text: string;
}

export interface PlacementRule {
  op: 'and' | 'or';
  subs: AdjacentRule[];
  requiresRecheck: boolean;
  text: string;
}

const NUMBERS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

// EnumFacing constants
const D = 0, U = 1, N = 2, S = 3, W = 4, E = 5;
export const AXIAL_PAIRS: [number, number][] = [[W, E], [D, U], [N, S]];
export const VERTEX_DIRS: number[][] = [
  [D, N, W], [D, N, E], [D, S, W], [D, S, E], [U, N, W], [U, N, E], [U, S, W], [U, S, E],
];
/** Verbatim from PosHelper.EDGE_DIRS (note: the source lists NORTH/WEST and SOUTH/EAST twice). */
export const EDGE_DIRS: number[][] = [
  [D, N], [D, S], [D, W], [D, E], [U, N], [U, S], [U, W], [U, E], [N, W], [N, W], [S, E], [S, E],
];

function partialParse(raw: string, reactor: ReactorType): AdjacentRule | null {
  let s = raw.toLowerCase().replace(/at exactly one vertex/g, 'vertex');
  const exact = s.includes('exact'), atMost = s.includes('at most');
  const axial = s.includes('axial'), vertex = s.includes('vertex'), edge = s.includes('edge');
  if ((exact && atMost) || (axial && vertex)) return null;
  for (const r of ['at least', 'exactly', 'exact', 'at most', 'axially', 'axial', 'at one vertex', 'at a vertex', 'at vertex', 'vertex',
    'at one edge', 'at an edge', 'at edge', 'along one edge', 'along an edge', 'along edge', 'edge']) {
    s = s.split(r).join('');
  }
  let amount = -1;
  let target: RuleTarget | null = null;
  let typeName: string | null = null;
  const split = s.split(' ');
  for (let i = 0; i < split.length; i++) {
    const w = split[i];
    if (w in NUMBERS) amount = NUMBERS[w];
    else if (target === null) {
      if (w.includes('wall') || w.includes('casing')) target = 'casing';
      else if (w.includes('conductor')) target = 'conductor';
      else if (w.includes('moderator')) target = 'moderator';
      else if (w.includes('reflector')) target = 'reflector';
      else if (w.includes('irradiator') || w.includes('shield') || w.includes('chamber')) target = 'unsupported';
      else if (w.includes('cooler')) { if (i === 0) return null; target = 'unsupported'; }
      else if (w.includes('cell')) target = reactor === 'sfr' ? 'fuel' : 'unsupported';
      else if (w.includes('sink')) {
        if (i === 0) return null;
        target = reactor === 'sfr' ? 'cooler' : 'unsupported';
        typeName = split[i - 1];
      } else if (w.includes('vessel')) target = reactor === 'msr' ? 'fuel' : 'unsupported';
      else if (w.includes('heater')) {
        if (i === 0) return null;
        target = reactor === 'msr' ? 'cooler' : 'unsupported';
        typeName = split[i - 1];
      }
    }
  }
  if (amount < 0 || target === null) return null;
  const count: CountType = exact ? 'exactly' : atMost ? 'atMost' : 'atLeast';
  const adj: AdjacencyType = axial ? 'axial' : vertex ? 'vertex' : edge ? 'edge' : 'standard';
  let coolerType = -1;
  if (target === 'cooler' && typeName !== 'any') {
    const names: readonly string[] = reactor === 'sfr' ? COOLER_NAMES : HEATER_NAMES;
    coolerType = names.indexOf(typeName!);
    if (coolerType < 0) throw new Error(`Unknown cooler type "${typeName}" in rule "${raw}"`);
  }
  return { target, coolerType, amount, count, adj, text: raw.trim() };
}

export function parseRule(text: string, reactor: ReactorType): PlacementRule {
  const lower = text.toLowerCase();
  const op = lower.includes('&&') ? 'and' : 'or';
  const subs: AdjacentRule[] = [];
  for (const part of lower.split(op === 'and' ? '&&' : '||')) {
    const r = partialParse(part, reactor);
    if (!r) throw new Error(`The placement rule string "${text}" could not be parsed!`);
    subs.push(r);
  }
  return { op, subs, text, requiresRecheck: subs.some((s) => s.count !== 'atLeast') };
}

/**
 * Evaluates an Adjacent sub-rule given a per-direction predicate (PlacementRule.Adjacent.satisfied).
 * `sat` is a 6-bit mask of directions in which the dependency is satisfied.
 */
export function adjacentSatisfied(rule: AdjacentRule, sat: number): boolean {
  const { amount, count, adj } = rule;
  const has = (d: number) => (sat >> d) & 1;
  const total = has(0) + has(1) + has(2) + has(3) + has(4) + has(5);
  if (adj === 'standard') {
    if (count === 'atLeast') return total >= amount;
    if (count === 'exactly') return total === amount;
    return total <= amount;
  }
  if (adj === 'axial') {
    let pairs = 0;
    for (const [a, b] of AXIAL_PAIRS) if (has(a) && has(b)) pairs++;
    if (count === 'exactly') return total === amount && pairs === amount / 2;
    if (count === 'atLeast') return pairs >= amount / 2;
    return pairs <= amount / 2;
  }
  // vertex / edge
  if (count === 'exactly' && total !== amount) return false;
  for (const dirs of adj === 'vertex' ? VERTEX_DIRS : EDGE_DIRS) {
    if (dirs.every((d) => has(d))) return true;
  }
  return false;
}
