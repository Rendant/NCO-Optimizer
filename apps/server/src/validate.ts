/** Request validation for the HTTP API (kept explicit so errors are readable for the UI). */
import { TURBINE_FLUIDS, TURBINE_BLADES, TURBINE_COILS, FUELS, MODERATORS, REFLECTORS, COOLER_NAMES, HEATER_NAMES, SFR_COOLANTS, SOURCES, NUM_BLOCKS, type OptimizeConfig, type ReactorType } from '@ncopt/engine';
import os from 'node:os';

export class BadRequest extends Error {}
const fail = (m: string): never => { throw new BadRequest(m); };

export function parseDims(d: unknown): [number, number, number] {
  if (!Array.isArray(d) || d.length !== 3) fail('dims must be [x, y, z]');
  const dims = (d as unknown[]).map(Number) as [number, number, number];
  for (const v of dims) if (!Number.isInteger(v) || v < 1 || v > 24) fail('each dimension must be an integer 1..24 (interior size)');
  return dims;
}

export function parseBase(b: any): { reactor: ReactorType; dims: [number, number, number]; fuelId: string; sfrCoolant?: string } {
  const reactor = b?.reactor;
  if (reactor !== 'sfr' && reactor !== 'msr') fail('reactor must be "sfr" or "msr"');
  const dims = parseDims(b.dims);
  const fuel = FUELS.find((f) => f.id === b.fuelId);
  if (!fuel) fail(`unknown fuel "${b.fuelId}"`);
  if (fuel!.reactor !== reactor) fail(`fuel ${fuel!.name} is not a ${reactor.toUpperCase()} fuel`);
  const sfrCoolant = b.sfrCoolant ?? 'water';
  if (reactor === 'sfr' && !SFR_COOLANTS.some((c) => c.id === sfrCoolant)) fail(`unknown SFR coolant "${sfrCoolant}"`);
  return { reactor, dims, fuelId: b.fuelId, sfrCoolant: reactor === 'sfr' ? sfrCoolant : undefined };
}

export function parseGrid(g: unknown, n: number): Uint8Array {
  if (!Array.isArray(g) || g.length !== n) fail(`grid must be an array of ${n} block ids`);
  const out = new Uint8Array(n);
  (g as unknown[]).forEach((v, i) => {
    const b = Number(v);
    if (!Number.isInteger(b) || b < 0 || b >= NUM_BLOCKS) fail(`invalid block id at ${i}`);
    out[i] = b;
  });
  return out;
}

const subset = (v: unknown, allowed: readonly string[], what: string): string[] => {
  if (v === undefined) return [...allowed];
  if (!Array.isArray(v)) fail(`${what} must be an array`);
  for (const x of v as string[]) if (!allowed.includes(x)) fail(`unknown ${what} "${x}"`);
  return v as string[];
};

export function parseOptimize(b: any): { cfg: OptimizeConfig; workers: number; options: { cooperate: boolean; useLibrary: boolean } } {
  const base = parseBase(b);
  const objective = b.objective ?? 'output';
  if (!['output', 'efficiency', 'balanced', 'breeding'].includes(objective)) fail('objective must be output | efficiency | balanced | breeding');
  const coolerIds = base.reactor === 'sfr' ? COOLER_NAMES : HEATER_NAMES;
  const cfg: OptimizeConfig = {
    ...base,
    objective,
    allowedModerators: subset(b.allowedModerators, MODERATORS.map((m) => m.id), 'moderator'),
    allowedReflectors: subset(b.allowedReflectors, REFLECTORS.map((m) => m.id), 'reflector'),
    allowedCoolers: subset(b.allowedCoolers, coolerIds, 'cooler'),
    allowConductors: !!b.allowConductors,
    symmetry: { x: !!b.symmetry?.x, y: !!b.symmetry?.y, z: !!b.symmetry?.z },
    timeLimitMs: Math.round(Math.min(600, Math.max(1, Number(b.timeLimitSec ?? 20))) * 1000),
  };
  if (!cfg.allowedModerators.length) fail('allow at least one moderator');
  if (!cfg.allowedCoolers.length) fail('allow at least one cooling component');
  if (b.maxFuel != null && b.maxFuel !== '') { const m = Number(b.maxFuel); if (!Number.isInteger(m) || m < 1) fail('maxFuel must be a positive integer'); cfg.maxFuel = m; }
  if (b.minEfficiency != null && b.minEfficiency !== '') { const m = Number(b.minEfficiency); if (!(m >= 0)) fail('minEfficiency must be >= 0'); cfg.minEfficiency = m; }
  if (b.seed != null && b.seed !== '') cfg.seed = Number(b.seed) >>> 0;
  if (b.initial != null) cfg.initial = Array.from(parseGrid(b.initial, base.dims[0] * base.dims[1] * base.dims[2]));
  const maxWorkers = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  const workers = Math.min(maxWorkers, Math.max(1, Math.floor(Number(b.workers ?? maxWorkers))));
  return { cfg, workers, options: { cooperate: b.cooperate !== false, useLibrary: b.useLibrary !== false } };
}

export function parseSource(s: unknown): string {
  if (s == null) return 'californium';
  if (!SOURCES.some((x) => x.id === s)) fail(`unknown source "${s}"`);
  return s as string;
}

export function parseTurbine(b: any) {
  const steamRate = Number(b?.steamRate);
  if (!(steamRate > 0) || steamRate > 1e8) fail('steamRate must be a positive number of mB/t');
  const fluids = TURBINE_FLUIDS.map((f) => f.id);
  const fluidId = b.fluidId ?? 'high_pressure_steam';
  if (!fluids.includes(fluidId)) fail(`unknown turbine fluid "${fluidId}"`);
  const allowedBlades = subset(b.allowedBlades, TURBINE_BLADES.map((x) => x.id), 'blade');
  if (!allowedBlades.length) fail('allow at least one rotor blade type');
  const allowedCoils = subset(b.allowedCoils, TURBINE_COILS.map((x) => x.id), 'coil');
  if (!allowedCoils.includes('magnesium')) fail('magnesium coils are required (only they connect to the bearings)');
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    if (v == null || v === '') return undefined;
    const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(`${name} must be an integer ${lo}..${hi}`); return n;
  };
  return {
    steamRate, fluidId, allowedBlades, allowedCoils, allowStators: b.allowStators !== false,
    maxDiameter: int(b.maxDiameter, 3, 24, 'maxDiameter'), maxLength: int(b.maxLength, 1, 24, 'maxLength'), turbines: int(b.turbines, 1, 1000, 'turbines'),
  };
}
