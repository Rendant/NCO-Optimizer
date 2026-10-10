/** Visual identity of blocks (colors / short labels) shared by the 2D and 3D views. */
import { AIR, FUEL, MOD0, REFL0, CONDUCTOR, COOLER0, COOLER_NAMES, NUM_BLOCKS, blockName, blockKey, type ReactorType } from '@ncopt/engine';

const COOLER_COLORS: Record<string, string> = {
  water: '#3b82f6', iron: '#a8a29e', redstone: '#dc2626', quartz: '#e7e5e4', obsidian: '#4c1d95', nether_brick: '#7f1d1d',
  glowstone: '#facc15', lapis: '#1e3a8a', gold: '#eab308', prismarine: '#2dd4bf', slime: '#84cc16', end_stone: '#fef08a',
  purpur: '#c084fc', diamond: '#67e8f9', emerald: '#10b981', copper: '#c2410c', tin: '#cbd5e1', lead: '#475569',
  boron: '#78716c', lithium: '#f1f5f9', magnesium: '#f9a8d4', manganese: '#9f1239', aluminum: '#94a3b8', silver: '#d4d4d8',
  fluorite: '#4ade80', villiaumite: '#b91c1c', carobbiite: '#fde047', arsenic: '#6b7280', liquid_nitrogen: '#7dd3fc',
  liquid_helium: '#fda4af', enderium: '#0f766e', cryotheum: '#38bdf8',
};
const COOLER_ABBR: Record<string, string> = {
  water: 'Wa', iron: 'Fe', redstone: 'Rs', quartz: 'Qz', obsidian: 'Ob', nether_brick: 'NB', glowstone: 'Gs', lapis: 'La', gold: 'Au',
  prismarine: 'Pr', slime: 'Sl', end_stone: 'ES', purpur: 'Pu', diamond: 'Di', emerald: 'Em', copper: 'Cu', tin: 'Sn', lead: 'Pb',
  boron: 'B', lithium: 'Li', magnesium: 'Mg', manganese: 'Mn', aluminum: 'Al', silver: 'Ag', fluorite: 'Fl', villiaumite: 'Vi',
  carobbiite: 'Cb', arsenic: 'As', liquid_nitrogen: 'N₂', liquid_helium: 'He', enderium: 'En', cryotheum: 'Cr',
};

export function blockColor(b: number): string {
  if (b === AIR) return '#000000';
  if (b === FUEL) return '#22c55e';
  if (b === MOD0) return '#3f3f46';
  if (b === MOD0 + 1) return '#d6d3d1';
  if (b === MOD0 + 2) return '#0e7490';
  if (b === REFL0) return '#57534e';
  if (b === REFL0 + 1) return '#71717a';
  if (b === CONDUCTOR) return '#b45309';
  return COOLER_COLORS[COOLER_NAMES[b - COOLER0]] ?? '#888';
}

export function blockAbbr(b: number, reactor: ReactorType): string {
  if (b === AIR) return '';
  if (b === FUEL) return reactor === 'sfr' ? 'C' : 'V';
  if (b === MOD0) return 'Gr';
  if (b === MOD0 + 1) return 'Be';
  if (b === MOD0 + 2) return 'HW';
  if (b === REFL0) return 'BC';
  if (b === REFL0 + 1) return 'LS';
  if (b === CONDUCTOR) return 'Co';
  return COOLER_ABBR[COOLER_NAMES[b - COOLER0]] ?? '?';
}

export function textColor(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#f8fafc';
}

/** Perceptual-ish ramp used for heatmap color modes. t in [0,1]. */
export function ramp(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const stops = [[49, 54, 149], [69, 117, 180], [116, 173, 209], [254, 224, 144], [244, 109, 67], [215, 48, 39]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const CLUSTER_PALETTE = ['#f97316', '#06b6d4', '#a855f7', '#84cc16', '#ec4899', '#eab308', '#14b8a6', '#6366f1', '#ef4444', '#22c55e'];
export const clusterColor = (c: number) => (c < 0 ? '#3f3f46' : CLUSTER_PALETTE[c % CLUSTER_PALETTE.length]);

export const blockList = (reactor: ReactorType) => Array.from({ length: NUM_BLOCKS }, (_, b) => ({ id: b, key: blockKey(b, reactor), name: blockName(b, reactor) }));
export { blockName, blockKey };
