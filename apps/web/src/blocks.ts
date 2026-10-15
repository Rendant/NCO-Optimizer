/** Visual identity of blocks (colors / short labels) shared by the 2D and 3D views. */
import {
  AIR, FUEL, MOD0, REFL0, CONDUCTOR, COOLER0, SHIELD0, IRRADIATOR, NUM_BLOCKS, blockName, blockKey, fuelSlot, isFuel, isShield, isValidBlock, coolerNames,
  type ReactorType,
} from '@ncopt/engine';

/** Colors of fuel slots 1..7 (slot 0 = green). */
const FUEL_COLORS = ['#22c55e', '#f472b6', '#fb923c', '#a3e635', '#e879f9', '#fde047', '#2dd4bf', '#f87171'];

const COOLER_COLORS: Record<string, string> = {
  water: '#3b82f6', iron: '#a8a29e', redstone: '#dc2626', quartz: '#e7e5e4', obsidian: '#4c1d95', nether_brick: '#7f1d1d',
  glowstone: '#facc15', lapis: '#1e3a8a', gold: '#eab308', prismarine: '#2dd4bf', slime: '#84cc16', end_stone: '#fef08a',
  purpur: '#c084fc', diamond: '#67e8f9', emerald: '#10b981', copper: '#c2410c', tin: '#cbd5e1', lead: '#475569',
  boron: '#78716c', lithium: '#f1f5f9', magnesium: '#f9a8d4', manganese: '#9f1239', aluminum: '#94a3b8', silver: '#d4d4d8',
  fluorite: '#4ade80', villiaumite: '#b91c1c', carobbiite: '#fde047', arsenic: '#6b7280', liquid_nitrogen: '#7dd3fc',
  liquid_helium: '#fda4af', enderium: '#0f766e', cryotheum: '#38bdf8',
  // PBR gas coolers
  oxygen: '#93c5fd', hydrogen: '#e0f2fe', helium: '#fef3c7', nitrogen: '#a5b4fc', fluorine: '#d9f99d', methane: '#fdba74', carbon_dioxide: '#a8a29e',
  carbon_monoxide: '#78716c', ethene: '#fcd34d', ethyne: '#f97316', fluoromethane: '#bef264', ammonia: '#c4b5fd', diborane: '#f0abfc',
  sulfur_dioxide: '#facc15', sulfur_trioxide: '#eab308', sulfur_hexafluoride: '#22d3ee',
};
const COOLER_ABBR: Record<string, string> = {
  water: 'Wa', iron: 'Fe', redstone: 'Rs', quartz: 'Qz', obsidian: 'Ob', nether_brick: 'NB', glowstone: 'Gs', lapis: 'La', gold: 'Au',
  prismarine: 'Pr', slime: 'Sl', end_stone: 'ES', purpur: 'Pu', diamond: 'Di', emerald: 'Em', copper: 'Cu', tin: 'Sn', lead: 'Pb',
  boron: 'B', lithium: 'Li', magnesium: 'Mg', manganese: 'Mn', aluminum: 'Al', silver: 'Ag', fluorite: 'Fl', villiaumite: 'Vi',
  carobbiite: 'Cb', arsenic: 'As', liquid_nitrogen: 'N₂', liquid_helium: 'He', enderium: 'En', cryotheum: 'Cr',
  oxygen: 'O₂', hydrogen: 'H₂', helium: 'He', nitrogen: 'N₂', fluorine: 'F₂', methane: 'CH₄', carbon_dioxide: 'CO₂', carbon_monoxide: 'CO',
  ethene: 'C₂H₄', ethyne: 'C₂H₂', fluoromethane: 'CH₃F', ammonia: 'NH₃', diborane: 'B₂H₆', sulfur_dioxide: 'SO₂', sulfur_trioxide: 'SO₃',
  sulfur_hexafluoride: 'SF₆',
};
const SHIELD_COLORS = ['#e2e8f0', '#be185d'];
const IRRADIATOR_COLOR = '#facc15';

export function blockColor(b: number, reactor: ReactorType = 'sfr'): string {
  if (b === AIR) return '#000000';
  if (isFuel(b)) return FUEL_COLORS[fuelSlot(b)] ?? '#22c55e';
  if (isShield(b)) return SHIELD_COLORS[b - SHIELD0];
  if (b === IRRADIATOR) return IRRADIATOR_COLOR;
  if (b === MOD0) return '#3f3f46';
  if (b === MOD0 + 1) return '#d6d3d1';
  if (b === MOD0 + 2) return '#0e7490';
  if (b === REFL0) return '#57534e';
  if (b === REFL0 + 1) return '#71717a';
  if (b === CONDUCTOR) return '#b45309';
  return COOLER_COLORS[coolerNames(reactor)[b - COOLER0]] ?? '#888';
}

const FUEL_ABBR: Record<ReactorType, string> = { sfr: 'C', msr: 'V', pbr: 'Ch' };

export function blockAbbr(b: number, reactor: ReactorType): string {
  if (b === AIR) return '';
  if (b === FUEL) return FUEL_ABBR[reactor];
  if (isFuel(b)) return `${FUEL_ABBR[reactor]}${fuelSlot(b) + 1}`;
  if (isShield(b)) return b === SHIELD0 ? 'BS' : 'GS';
  if (b === IRRADIATOR) return 'Ir';
  if (b === MOD0) return 'Gr';
  if (b === MOD0 + 1) return 'Be';
  if (b === MOD0 + 2) return 'HW';
  if (b === REFL0) return 'BC';
  if (b === REFL0 + 1) return 'LS';
  if (b === CONDUCTOR) return 'Co';
  return COOLER_ABBR[coolerNames(reactor)[b - COOLER0]] ?? '?';
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

/** Every block id that exists for the reactor type. */
export const blockList = (reactor: ReactorType) => Array.from({ length: NUM_BLOCKS }, (_, b) => b).filter((b) => isValidBlock(b, reactor))
  .map((b) => ({ id: b, key: blockKey(b, reactor), name: blockName(b, reactor) }));
/** Block name without the redundant component suffix (for compact lists). */
export const shortName = (name: string) => name.replace(/ (Heat Sink|Coolant Heater|Cooler|Block|Neutron Shield)$/, '');
export { blockName, blockKey };
