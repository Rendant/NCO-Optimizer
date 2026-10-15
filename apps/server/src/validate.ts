/** Request validation for the HTTP API (kept explicit so errors are readable for the UI). */
import {
  HX_TUBES, TURBINE_FLUIDS, TURBINE_BLADES, TURBINE_COILS, FUELS, MODERATORS, REFLECTORS, SHIELDS, IRRADIATOR_RECIPES, SFR_COOLANTS, SOURCES, MAX_FUELS,
  coolerNames, isValidBlock, type OptimizeConfig, type ReactorType, type IrradiatorRecipeId,
} from '@ncopt/engine';
import os from 'node:os';

export class BadRequest extends Error {}
const fail = (m: string): never => { throw new BadRequest(m); };

export function parseDims(d: unknown): [number, number, number] {
  if (!Array.isArray(d) || d.length !== 3) fail('dims must be [x, y, z]');
  const dims = (d as unknown[]).map(Number) as [number, number, number];
  for (const v of dims) if (!Number.isInteger(v) || v < 1 || v > 24) fail('each dimension must be an integer 1..24 (interior size)');
  return dims;
}

export interface BaseConfig {
  reactor: ReactorType; dims: [number, number, number]; fuelId: string; fuelIds?: string[]; sfrCoolant?: string;
  irradiatorRecipe: IrradiatorRecipeId; decayMechanics: boolean;
}

export function parseBase(b: any): BaseConfig {
  const reactor = b?.reactor;
  if (reactor !== 'sfr' && reactor !== 'msr' && reactor !== 'pbr') fail('reactor must be "sfr", "msr" or "pbr"');
  const dims = parseDims(b.dims);
  const fuel = FUELS.find((f) => f.id === b.fuelId);
  if (!fuel) fail(`unknown fuel "${b.fuelId}"`);
  if (fuel!.reactor !== reactor) fail(`fuel ${fuel!.name} is not a ${reactor.toUpperCase()} fuel`);
  const sfrCoolant = b.sfrCoolant ?? 'water';
  if (reactor === 'sfr' && !SFR_COOLANTS.some((c) => c.id === sfrCoolant)) fail(`unknown SFR coolant "${sfrCoolant}"`);
  // multi-fuel: fuelIds = candidate fuel list (the primary fuelId first)
  let fuelIds: string[] | undefined;
  if (b.fuelIds != null) {
    if (!Array.isArray(b.fuelIds)) fail('fuelIds must be an array of fuel ids');
    const ids = [b.fuelId, ...(b.fuelIds as string[])].filter((x, k, a) => a.indexOf(x) === k);
    if (ids.length > MAX_FUELS) fail(`at most ${MAX_FUELS} fuels`);
    for (const id of ids) {
      const f = FUELS.find((x) => x.id === id);
      if (!f) fail(`unknown fuel "${id}"`);
      if (f!.reactor !== reactor) fail(`fuel ${f!.name} is not a ${reactor.toUpperCase()} fuel`);
    }
    if (ids.length > 1) fuelIds = ids;
  }
  const irradiatorRecipe = b.irradiatorRecipe ?? 'thorium';
  if (!IRRADIATOR_RECIPES.some((r) => r.id === irradiatorRecipe)) fail(`unknown irradiator recipe "${irradiatorRecipe}"`);
  return {
    reactor, dims, fuelId: b.fuelId, ...(fuelIds ? { fuelIds } : {}), sfrCoolant: reactor === 'sfr' ? sfrCoolant : undefined,
    irradiatorRecipe, decayMechanics: !!b.decayMechanics,
  };
}

export function parseGrid(g: unknown, n: number, reactor: ReactorType): Uint8Array {
  if (!Array.isArray(g) || g.length !== n) fail(`grid must be an array of ${n} block ids`);
  const out = new Uint8Array(n);
  (g as unknown[]).forEach((v, i) => {
    const b = Number(v);
    if (!isValidBlock(b, reactor)) fail(`invalid block id at ${i}`);
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
  if (!['output', 'efficiency', 'balanced', 'breeding', 'irradiation'].includes(objective)) fail('objective must be output | efficiency | balanced | breeding | irradiation');
  const cfg: OptimizeConfig = {
    ...base,
    objective,
    allowedModerators: subset(b.allowedModerators, MODERATORS.map((m) => m.id), 'moderator'),
    allowedReflectors: subset(b.allowedReflectors, REFLECTORS.map((m) => m.id), 'reflector'),
    allowedCoolers: subset(b.allowedCoolers, coolerNames(base.reactor), 'cooler'),
    allowConductors: !!b.allowConductors,
    allowedShields: b.allowedShields === undefined ? [] : subset(b.allowedShields, SHIELDS.map((s) => s.id), 'shield'),
    allowIrradiators: !!b.allowIrradiators || objective === 'irradiation',
    controllable: !!b.controllable,
    symmetry: { x: !!b.symmetry?.x, y: !!b.symmetry?.y, z: !!b.symmetry?.z },
    timeLimitMs: Math.round(Math.min(600, Math.max(1, Number(b.timeLimitSec ?? 20))) * 1000),
  };
  if (!cfg.allowedModerators.length) fail('allow at least one moderator');
  if (!cfg.allowedCoolers.length) fail('allow at least one cooling component');
  if (cfg.controllable && !cfg.allowedShields!.length) fail('a controllable reactor needs at least one allowed neutron shield');
  if (b.maxFuel != null && b.maxFuel !== '') { const m = Number(b.maxFuel); if (!Number.isInteger(m) || m < 1) fail('maxFuel must be a positive integer'); cfg.maxFuel = m; }
  if (b.minEfficiency != null && b.minEfficiency !== '') { const m = Number(b.minEfficiency); if (!(m >= 0)) fail('minEfficiency must be >= 0'); cfg.minEfficiency = m; }
  if (b.minIrradiatorFlux != null && b.minIrradiatorFlux !== '') {
    const m = Number(b.minIrradiatorFlux); if (!(m > 0)) fail('minIrradiatorFlux must be > 0');
    cfg.minIrradiatorFlux = m; cfg.allowIrradiators = true;
  }
  if (cfg.fuelIds && b.requireAllFuels) cfg.requireAllFuels = true;
  if (b.seed != null && b.seed !== '') cfg.seed = Number(b.seed) >>> 0;
  if (b.initial != null) cfg.initial = Array.from(parseGrid(b.initial, base.dims[0] * base.dims[1] * base.dims[2], base.reactor));
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

export function parseHX(b: any) {
  const hc = b?.hotCoolant;
  if (!hc || typeof hc !== 'object') fail('hotCoolant must be an object {coolant name: mB/t}');
  const hotCoolant: Record<string, number> = {};
  for (const [k, v] of Object.entries(hc)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e8) fail(`hotCoolant["${k}"] must be a non-negative number of mB/t`);
    if (n > 0) hotCoolant[String(k).slice(0, 60)] = n;
  }
  if (!Object.keys(hotCoolant).length) fail('the reactor produces no hot coolant');
  if (Object.keys(hotCoolant).length > 64) fail('too many coolant types');
  const tubeType = b.tubeType == null || b.tubeType === '' || b.tubeType === 'auto' ? undefined : String(b.tubeType);
  if (tubeType && !HX_TUBES.some((t) => t.id === tubeType)) fail(`unknown tube type "${tubeType}"`);
  const coldFluid = b.coldFluid ?? 'water';
  if (!['water', 'preheated_water'].includes(coldFluid)) fail('coldFluid must be water | preheated_water');
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    if (v == null || v === '') return undefined;
    const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(`${name} must be an integer ${lo}..${hi}`); return n;
  };
  return { hotCoolant, tubeType: tubeType as any, coldFluid, maxSize: int(b.maxSize, 1, 24, 'maxSize'), exchangers: int(b.exchangers, 1, 64, 'exchangers') };
}
