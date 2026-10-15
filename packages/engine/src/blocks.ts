/**
 * Compact numeric block encoding used by the simulator and optimizer.
 *  0       air
 *  1       fuel component (SFR fuel cell / MSR fuel vessel / PBR fuel chamber) loaded with the selected fuel
 *  2..4    moderators (graphite, beryllium, heavy water)
 *  5..6    reflectors (beryllium-carbon, lead-steel)
 *  7       conductor
 *  8..39   cooling components (SFR heat sinks / MSR coolant heaters / PBR gas coolers 8..23), index = block - 8
 *  40..46  fuel components loaded with additional fuels (fuel slot 1..7 of a multi-fuel layout)
 *  47..48  neutron shields (boron-silver, gadolinium-samarium)
 *  49      neutron irradiator
 * New blocks are appended so that saved layouts keep their ids.
 */
import { MODERATORS, REFLECTORS, SHIELDS, titleCase, ReactorType, coolerNames, coolingRates, coolerNoun, fuelNoun } from './components.js';

export const AIR = 0;
export const FUEL = 1;
export const MOD0 = 2;
export const REFL0 = 5;
export const CONDUCTOR = 7;
export const COOLER0 = 8;
/** End of the cooling component id range (32 sink / heater types; PBR uses only the first 16). */
export const COOLER_END = COOLER0 + 32;
/** Fuel components of fuel slot k >= 1 use block FUELX0 + k - 1 (slot 0 is FUEL). */
export const FUELX0 = COOLER_END;
/** Maximum number of different fuels in one layout. */
export const MAX_FUELS = 8;
export const SHIELD0 = FUELX0 + MAX_FUELS - 1;
export const IRRADIATOR = SHIELD0 + SHIELDS.length;
export const NUM_BLOCKS = IRRADIATOR + 1;

export const isFuel = (b: number) => b === FUEL || (b >= FUELX0 && b < SHIELD0);
/** Fuel slot (index into the layout's fuel list) of a fuel block. */
export const fuelSlot = (b: number) => (b === FUEL ? 0 : b - FUELX0 + 1);
export const fuelBlock = (slot: number) => (slot === 0 ? FUEL : FUELX0 + slot - 1);

export const isModerator = (b: number) => b >= MOD0 && b < MOD0 + MODERATORS.length;
export const isReflector = (b: number) => b >= REFL0 && b < REFL0 + REFLECTORS.length;
export const isCooler = (b: number) => b >= COOLER0 && b < COOLER_END;
export const isShield = (b: number) => b >= SHIELD0 && b < SHIELD0 + SHIELDS.length;
export const isIrradiator = (b: number) => b === IRRADIATOR;
export const coolerIndex = (b: number) => b - COOLER0;

/** True if block id b exists for the reactor type (PBR has 16 cooler types). */
export const isValidBlock = (b: number, reactor: ReactorType) =>
  Number.isInteger(b) && b >= 0 && b < NUM_BLOCKS && (!isCooler(b) || b - COOLER0 < coolerNames(reactor).length);

export function blockKey(b: number, reactor: ReactorType): string {
  if (b === AIR) return 'air';
  if (b === FUEL) return fuelNoun(reactor);
  if (isFuel(b)) return `${fuelNoun(reactor)}_${fuelSlot(b) + 1}`;
  if (isModerator(b)) return MODERATORS[b - MOD0].id;
  if (isReflector(b)) return REFLECTORS[b - REFL0].id;
  if (b === CONDUCTOR) return 'conductor';
  if (isShield(b)) return `${SHIELDS[b - SHIELD0].id}_shield`;
  if (b === IRRADIATOR) return 'irradiator';
  const name = coolerNames(reactor)[b - COOLER0];
  return name === undefined ? `invalid_${b}` : `${name}_${coolerNoun(reactor)}`;
}

const FUEL_NAMES: Record<ReactorType, string> = { sfr: 'Fuel Cell', msr: 'Fuel Vessel', pbr: 'Fuel Chamber' };
const COOLER_SUFFIX: Record<ReactorType, string> = { sfr: 'Heat Sink', msr: 'Coolant Heater', pbr: 'Cooler' };

export function blockName(b: number, reactor: ReactorType): string {
  if (b === AIR) return 'Air';
  if (b === FUEL) return FUEL_NAMES[reactor];
  if (isFuel(b)) return `${FUEL_NAMES[reactor]} #${fuelSlot(b) + 1}`;
  if (isModerator(b)) return MODERATORS[b - MOD0].name;
  if (isReflector(b)) return REFLECTORS[b - REFL0].name;
  if (b === CONDUCTOR) return 'Conductor';
  if (isShield(b)) return SHIELDS[b - SHIELD0].name;
  if (b === IRRADIATOR) return 'Neutron Irradiator';
  const name = coolerNames(reactor)[b - COOLER0];
  return name === undefined ? `Invalid block ${b}` : `${titleCase(name)} ${COOLER_SUFFIX[reactor]}`;
}

export function blockFromKey(key: string, reactor: ReactorType): number {
  for (let b = 0; b < NUM_BLOCKS; b++) if (isValidBlock(b, reactor) && blockKey(b, reactor) === key) return b;
  throw new Error(`Unknown block key "${key}" for ${reactor}`);
}

export const coolingRate = (b: number, reactor: ReactorType = 'sfr') => (isCooler(b) ? coolingRates(reactor)[b - COOLER0] ?? 0 : 0);
