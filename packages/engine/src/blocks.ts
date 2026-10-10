/**
 * Compact numeric block encoding used by the simulator and optimizer.
 *  0       air
 *  1       fuel component (SFR fuel cell / MSR fuel vessel) loaded with the selected fuel
 *  2..4    moderators (graphite, beryllium, heavy water)
 *  5..6    reflectors (beryllium-carbon, lead-steel)
 *  7       conductor
 *  8..39   cooling components (SFR heat sinks / MSR coolant heaters), index = block - 8
 *  40..46  fuel components loaded with additional fuels (fuel slot 1..7 of a multi-fuel layout)
 */
import { COOLER_NAMES, HEATER_NAMES, MODERATORS, REFLECTORS, titleCase, ReactorType, COOLING_RATES } from './components.js';

export const AIR = 0;
export const FUEL = 1;
export const MOD0 = 2;
export const REFL0 = 5;
export const CONDUCTOR = 7;
export const COOLER0 = 8;
export const COOLER_END = COOLER0 + COOLER_NAMES.length;
/** Fuel components of fuel slot k >= 1 use block FUELX0 + k - 1 (slot 0 is FUEL). */
export const FUELX0 = COOLER_END;
/** Maximum number of different fuels in one layout. */
export const MAX_FUELS = 8;
export const NUM_BLOCKS = FUELX0 + MAX_FUELS - 1;

export const isFuel = (b: number) => b === FUEL || b >= FUELX0;
/** Fuel slot (index into the layout's fuel list) of a fuel block. */
export const fuelSlot = (b: number) => (b === FUEL ? 0 : b - FUELX0 + 1);
export const fuelBlock = (slot: number) => (slot === 0 ? FUEL : FUELX0 + slot - 1);

export const isModerator = (b: number) => b >= MOD0 && b < MOD0 + MODERATORS.length;
export const isReflector = (b: number) => b >= REFL0 && b < REFL0 + REFLECTORS.length;
export const isCooler = (b: number) => b >= COOLER0 && b < COOLER_END;
export const coolerIndex = (b: number) => b - COOLER0;

export function blockKey(b: number, reactor: ReactorType): string {
  if (b === AIR) return 'air';
  if (b === FUEL) return reactor === 'sfr' ? 'cell' : 'vessel';
  if (b >= FUELX0) return `${reactor === 'sfr' ? 'cell' : 'vessel'}_${fuelSlot(b) + 1}`;
  if (isModerator(b)) return MODERATORS[b - MOD0].id;
  if (isReflector(b)) return REFLECTORS[b - REFL0].id;
  if (b === CONDUCTOR) return 'conductor';
  return reactor === 'sfr' ? `${COOLER_NAMES[b - COOLER0]}_sink` : `${HEATER_NAMES[b - COOLER0]}_heater`;
}

export function blockName(b: number, reactor: ReactorType): string {
  if (b === AIR) return 'Air';
  if (b === FUEL) return reactor === 'sfr' ? 'Fuel Cell' : 'Fuel Vessel';
  if (b >= FUELX0) return `${reactor === 'sfr' ? 'Fuel Cell' : 'Fuel Vessel'} #${fuelSlot(b) + 1}`;
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
