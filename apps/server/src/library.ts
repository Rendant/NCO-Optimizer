/**
 * Result library: the best layouts found so far per (reactor, size, fuel, coolant, objective), persisted as
 * JSON. New jobs use compatible entries (all blocks allowed) as extra seed layouts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODERATORS, REFLECTORS, COOLER_NAMES, HEATER_NAMES, MOD0, REFL0, CONDUCTOR, COOLER0, FUEL, AIR, type OptimizeConfig, type ReactorStats } from '@ncopt/engine';

export interface LibraryEntry {
  id: string;
  key: string;
  grid: number[];
  fitness: number;
  effectiveHeating: number;
  meanEfficiency: number;
  fuelComponents: number;
  fuelPerHour?: number;
  stable: boolean;
  symmetry: OptimizeConfig['symmetry'];
  createdAt: number;
  jobId?: string;
}

const PER_KEY = 10;

export function libraryKey(c: { reactor: string; dims: number[]; fuelId: string; sfrCoolant?: string; objective: string }) {
  return [c.reactor, c.dims.join('x'), c.fuelId, c.reactor === 'sfr' ? c.sfrCoolant ?? 'water' : '-', c.objective].join('|');
}

/** True if every block of the layout is allowed by the configuration. */
export function compatible(grid: number[], cfg: OptimizeConfig): boolean {
  const names: readonly string[] = cfg.reactor === 'sfr' ? COOLER_NAMES : HEATER_NAMES;
  for (const b of grid) {
    if (b === AIR || b === FUEL) continue;
    if (b >= MOD0 && b < MOD0 + MODERATORS.length) { if (!cfg.allowedModerators.includes(MODERATORS[b - MOD0].id)) return false; continue; }
    if (b >= REFL0 && b < REFL0 + REFLECTORS.length) { if (!cfg.allowedReflectors.includes(REFLECTORS[b - REFL0].id)) return false; continue; }
    if (b === CONDUCTOR) { if (!cfg.allowConductors) return false; continue; }
    if (b >= COOLER0) { if (!cfg.allowedCoolers.includes(names[b - COOLER0])) return false; continue; }
    return false;
  }
  return true;
}

export class Library {
  private entries: LibraryEntry[] = [];
  constructor(private file: string) {
    try { if (existsSync(file)) this.entries = JSON.parse(readFileSync(file, 'utf8')).entries ?? []; } catch { this.entries = []; }
  }
  list(key?: string) { return this.entries.filter((e) => !key || e.key === key).sort((a, b) => b.fitness - a.fitness); }
  /** Compatible entries for a configuration (best first). */
  forConfig(cfg: OptimizeConfig) {
    const key = libraryKey(cfg);
    return this.list(key).map((e) => ({ ...e, compatible: compatible(e.grid, cfg) }));
  }
  /** Adds valid results; keeps the PER_KEY best distinct layouts per key. Returns the number of new entries. */
  add(cfg: OptimizeConfig, results: { grid: number[]; stats: ReactorStats; fitness: number; valid: boolean }[], jobId?: string) {
    const key = libraryKey(cfg);
    let added = 0;
    for (const r of results) {
      if (!r.valid) continue;
      const g = r.grid.join(',');
      if (this.entries.some((e) => e.key === key && e.grid.join(',') === g)) continue;
      this.entries.push({
        id: randomUUID(), key, grid: r.grid, fitness: r.fitness, effectiveHeating: r.stats.effectiveHeating, meanEfficiency: r.stats.meanEfficiency,
        fuelComponents: r.stats.fuelComponents, fuelPerHour: r.stats.fuelPerHour, stable: r.stats.stable, symmetry: cfg.symmetry, createdAt: Date.now(), jobId,
      });
      added++;
    }
    const keep = new Set(this.list(key).slice(0, PER_KEY).map((e) => e.id));
    this.entries = this.entries.filter((e) => e.key !== key || keep.has(e.id));
    if (added) this.save();
    return added;
  }
  remove(id: string) {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== n) this.save();
    return this.entries.length !== n;
  }
  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }));
    renameSync(tmp, this.file);
  }
}
