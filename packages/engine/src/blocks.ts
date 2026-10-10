/**
 * Compact numeric block encoding used by the simulator and optimizer.
 *  0       air
 *  1       fuel component (SFR fuel cell / MSR fuel vessel) loaded with the selected fuel
 *  2..4    moderators (graphite, beryllium, heavy water)
 *  5..6    reflectors (beryllium-carbon, lead-steel)
 *  7       conductor
 *  8..39   cooling components (SFR heat sinks / MSR coolant heaters), index = block - 8
 */
import { COOLER_NAMES, HEATER_NAMES, MODERATORS, REFLECTORS, titleCase, ReactorType, COOLING_RATES } from './components.js';

export const AIR = 0;
export const FUEL = 1;
export const MOD0 = 2;
export const REFL0 = 5;
export const CONDUCTOR = 7;
export const COOLER0 = 8;
export const NUM_BLOCKS = COOLER0 + COOLER_NAMES.length;

export const isModerator = (b: number) => b >= MOD0 && b < MOD0 + MODERATORS.length;
export const isReflector = (b: number) => b >= REFL0 && b < REFL0 + REFLECTORS.length;
export const isCooler = (b: number) => b >= COOLER0;
export const coolerIndex = (b: number) => b - COOLER0;

export function blockKey(b: number, reactor: ReactorType): string {
  if (b === AIR) return 'air';
  if (b === FUEL) return reactor === 'sfr' ? 'cell' : 'vessel';
  if (isModerator(b)) return MODERATORS[b - MOD0].id;
  if (isReflector(b)) return REFLECTORS[b - REFL0].id;
  if (b === CONDUCTOR) return 'conductor';
  return reactor === 'sfr' ? `${COOLER_NAMES[b - COOLER0]}_sink` : `${HEATER_NAMES[b - COOLER0]}_heater`;
}

export function blockName(b: number, reactor: ReactorType): string {
  if (b === AIR) return 'Air';
  if (b === FUEL) return reactor === 'sfr' ? 'Fuel Cell' : 'Fuel Vessel';
  if (isModerator(b)) return MODERATORS[b - MOD0].name;
  if (isReflector(b)) return REFLECTORS[b - REFL0].name;
  if (b === CONDUCTOR) return 'Conductor';
  return reactor === 'sfr' ? `${titleCase(COOLER_NAMES[b - COOLER0])} Heat Sink` : `${titleCase(HEATER_NAMES[b - COOLER0])} Coolant Heater`;
}

export function blockFromKey(key: string, reactor: ReactorType): number {
  for (let b = 0; b < NUM_BLOCKS; b++) if (blockKey(b, reactor) === key) return b;
  throw new Error(`Unknown block key "${key}" for ${reactor}`);
}

export const coolingRate = (b: number) => (isCooler(b) ? COOLING_RATES[b - COOLER0] : 0);
