import type { BlockInfo, ReactorStats, ReactorType } from '@ncopt/engine';
import { blockColor, clusterColor, ramp } from './blocks';

export interface LayoutEntry {
  id: string;
  name: string;
  origin: 'optimizer' | 'import' | 'edited' | 'live' | 'library';
  reactor: ReactorType;
  dims: [number, number, number];
  fuelId: string;
  sfrCoolant?: string;
  grid: number[];
  stats: ReactorStats;
  createdAt: number;
  note?: string;
  /** summary of the last turbine design for this layout */
  turbine?: { totalPower: number; turbines: number; size: string; rfPerMB: number };
}

export type ColorMode = 'block' | 'state' | 'cluster' | 'efficiency' | 'flux';

export const idx = (dims: [number, number, number], x: number, y: number, z: number) => x + dims[0] * (y + dims[1] * z);

export interface CellLook { color: string; dim: boolean }

export function cellLook(b: number, info: BlockInfo | undefined, mode: ColorMode, maxEff: number, maxFlux: number): CellLook {
  const active = info ? info.active : true;
  switch (mode) {
    case 'block': return { color: blockColor(b), dim: !active };
    case 'state': return { color: active ? '#22c55e' : '#ef4444', dim: false };
    case 'cluster': return { color: clusterColor(info?.cluster ?? -1), dim: !active };
    case 'efficiency':
      if (info?.fuel) return { color: info.fuel.running ? ramp(info.fuel.efficiency / Math.max(1e-9, maxEff)) : '#3f3f46', dim: !info.fuel.running };
      return { color: blockColor(b), dim: true };
    case 'flux':
      if (info?.fuel) return { color: ramp(info.fuel.bunch.flux / Math.max(1, maxFlux)), dim: !info.fuel.running };
      return { color: blockColor(b), dim: true };
  }
}

export function fmt(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export const pct = (v: number, d = 1) => `${fmt(v * 100, d)}%`;

export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
