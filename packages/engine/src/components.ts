/**
 * Static component data, copied verbatim from NuclearCraft: Overhauled (1.12.2o branch)
 * `nc/config/NCConfig.java` defaults and `nc/enumm/MetaEnums.java`.
 */
import fuelsJson from './data/fuels.json' with { type: 'json' };

/** Solid-fuel, molten-salt and pebble-bed fission reactors. */
export type ReactorType = 'sfr' | 'msr' | 'pbr';

export interface FuelDef {
  id: string;
  name: string;
  isotope: string;
  form: 'TRISO' | 'Oxide' | 'Nitride' | 'ZA' | 'Fluoride';
  reactor: ReactorType;
  /** Ticks per ingot (SFR / PBR) or per 144 mB (MSR) at 100% lifetime factor. */
  time: number;
  /** Base heat per tick (H/t) per fuel component, before heat multiplier. */
  heat: number;
  efficiency: number;
  criticality: number;
  /** Flux a fuel component gives each face-adjacent fuel component / irradiator and adds to its moderator lines (TRISO: 10). */
  intrinsicFlux: number;
  selfPriming: boolean;
  /** Decay heat / poison equilibrium factor (only used with fission_decay_mechanics). */
  decayFactor: number;
}
export const FUELS: FuelDef[] = fuelsJson as FuelDef[];

/** Cooling component names in meta order. Index 0 is "water" (sinks) / "standard" (heaters). */
export const COOLER_NAMES = [
  'water', 'iron', 'redstone', 'quartz', 'obsidian', 'nether_brick', 'glowstone', 'lapis',
  'gold', 'prismarine', 'slime', 'end_stone', 'purpur', 'diamond', 'emerald', 'copper',
  'tin', 'lead', 'boron', 'lithium', 'magnesium', 'manganese', 'aluminum', 'silver',
  'fluorite', 'villiaumite', 'carobbiite', 'arsenic', 'liquid_nitrogen', 'liquid_helium', 'enderium', 'cryotheum',
] as const;

/** fission_sink_cooling_rate / fission_heater_cooling_rate (identical defaults). */
export const COOLING_RATES = [
  55, 50, 85, 80, 70, 105, 90, 100, 110, 115, 145, 65, 95, 200, 195, 75,
  120, 60, 160, 130, 125, 150, 175, 170, 165, 180, 140, 135, 185, 190, 155, 205,
];

/** fission_sink_rule defaults. */
export const SINK_RULES = [
  'one cell', 'one moderator', 'one cell && one moderator', 'one redstone sink', 'two axial glowstone sinks',
  'one obsidian sink', 'two moderators', 'one cell && one casing', 'exactly two iron sinks', 'two water sinks',
  'exactly one water sink && two lead sinks', 'one reflector', 'one reflector && one iron sink', 'one cell && one gold sink',
  'one moderator && one prismarine sink', 'one water sink', 'two axial lapis sinks', 'one iron sink',
  'exactly one quartz sink && one casing', 'exactly two axial lead sinks && one casing', 'exactly one moderator && one casing',
  'two cells', 'one quartz sink && one lapis sink', 'two glowstone sinks && one tin sink', 'one gold sink && one prismarine sink',
  'one redstone sink && one end_stone sink', 'one end_stone sink && one copper sink', 'two axial reflectors',
  'two copper sinks && one purpur sink', 'exactly two redstone sinks', 'three moderators', 'three cells',
];

/** fission_heater_rule defaults. */
export const HEATER_RULES = [
  'one vessel', 'one moderator', 'one vessel && one moderator', 'one redstone heater', 'two axial glowstone heaters',
  'one obsidian heater', 'two moderators', 'one vessel && one casing', 'exactly two iron heaters', 'two standard heaters',
  'exactly one standard heater && two lead heaters', 'one reflector', 'one reflector && one iron heater', 'one vessel && one gold heater',
  'one moderator && one prismarine heater', 'one standard heater', 'two axial lapis heaters', 'one iron heater',
  'exactly one quartz heater && one casing', 'exactly two axial lead heaters && one casing', 'exactly one moderator && one casing',
  'two vessels', 'one quartz heater && one lapis heater', 'two glowstone heaters && one tin heater', 'one gold heater && one prismarine heater',
  'one redstone heater && one end_stone heater', 'one end_stone heater && one copper heater', 'two axial reflectors',
  'two copper heaters && one purpur heater', 'exactly two redstone heaters', 'three moderators', 'three vessels',
];

export const HEATER_NAMES = COOLER_NAMES.map((n, i) => (i === 0 ? 'standard' : n));
/** Coolant consumed by each MSR coolant heater (CoolantHeaterRecipes). */
export const HEATER_COOLANTS = COOLER_NAMES.map((n, i) => (i === 0 ? 'NaK' : `${titleCase(n)}-NaK`));

/** Pebble-bed gas cooler names in meta order (MetaEnums.GasCoolerType / GasCoolerRecipes.COOLANTS). */
export const GAS_COOLER_NAMES = [
  'oxygen', 'hydrogen', 'helium', 'nitrogen', 'fluorine', 'methane', 'carbon_dioxide', 'carbon_monoxide',
  'ethene', 'ethyne', 'fluoromethane', 'ammonia', 'diborane', 'sulfur_dioxide', 'sulfur_trioxide', 'sulfur_hexafluoride',
] as const;
/** fission_cooler_cooling_rate defaults. */
export const GAS_COOLING_RATES = [60, 110, 125, 115, 75, 100, 120, 105, 85, 80, 65, 95, 70, 50, 55, 90];
/** fission_cooler_rule defaults. */
export const GAS_COOLER_RULES = [
  'one chamber', 'exactly two chambers', 'three chambers', 'exactly two oxygen coolers', 'one moderator', 'two axial moderators',
  'three moderators', 'exactly one oxygen cooler', 'exactly one methane cooler', 'one ethene cooler && exactly one moderator',
  'one fluorine cooler', 'exactly two nitrogen coolers && one casing', 'two hydrogen coolers', 'one reflector',
  'one sulfur_dioxide cooler', 'two axial sulfur_trioxide coolers && one casing',
];
/** Hot gas produced by each gas cooler (GasCoolerRecipes: 1 mB gas -> 2 mB hot gas). */
export const GAS_COOLANTS = GAS_COOLER_NAMES.map((n) => `Hot ${titleCase(n)}`);

/** Cooling component names of a reactor type (heat sinks / coolant heaters / gas coolers). */
export const coolerNames = (r: ReactorType): readonly string[] => (r === 'sfr' ? COOLER_NAMES : r === 'msr' ? HEATER_NAMES : GAS_COOLER_NAMES);
export const coolingRates = (r: ReactorType): readonly number[] => (r === 'pbr' ? GAS_COOLING_RATES : COOLING_RATES);
export const coolerRules = (r: ReactorType): readonly string[] => (r === 'sfr' ? SINK_RULES : r === 'msr' ? HEATER_RULES : GAS_COOLER_RULES);
/** Cooling component noun used in names and placement rules. */
export const coolerNoun = (r: ReactorType) => (r === 'sfr' ? 'sink' : r === 'msr' ? 'heater' : 'cooler');
/** Fuel component noun used in names and placement rules. */
export const fuelNoun = (r: ReactorType) => (r === 'sfr' ? 'cell' : r === 'msr' ? 'vessel' : 'chamber');

/** fission_moderator_flux_factor / fission_moderator_efficiency (FissionModeratorRecipes). */
export const MODERATORS = [
  { id: 'graphite', name: 'Graphite Block', fluxFactor: 10, efficiency: 1.1 },
  { id: 'beryllium', name: 'Beryllium Block', fluxFactor: 22, efficiency: 1.05 },
  { id: 'heavy_water', name: 'Heavy Water Moderator', fluxFactor: 36, efficiency: 1.0 },
] as const;

/** fission_reflector_efficiency / fission_reflector_reflectivity (MetaEnums.NeutronReflectorType). */
export const REFLECTORS = [
  { id: 'beryllium_carbon', name: 'Beryllium-Carbon Reflector', efficiency: 0.5, reflectivity: 1.0 },
  { id: 'lead_steel', name: 'Lead-Steel Reflector', efficiency: 0.25, reflectivity: 0.5 },
] as const;

/** fission_shield_heat_per_flux / fission_shield_efficiency (MetaEnums.NeutronShieldType). */
export const SHIELDS = [
  { id: 'boron_silver', name: 'Boron-Silver Neutron Shield', heatPerFlux: 5, efficiency: 0.5 },
  { id: 'gadolinium_samarium', name: 'Gadolinium-Samarium Neutron Shield', heatPerFlux: 10, efficiency: 0.75 },
] as const;

/**
 * FissionIrradiatorRecipes defaults: flux needed per item, heat per flux and process efficiency
 * (fission_irradiator_heat_per_flux / fission_irradiator_efficiency). The efficiency multiplies the
 * moderator-line efficiency of the fuel component that irradiates.
 */
export const IRRADIATOR_RECIPES = [
  { id: 'thorium', name: 'Thorium → TBP', input: 'Thorium', output: 'TBP', fluxPerItem: 160000, heatPerFlux: 0, efficiency: 0 },
  { id: 'tbp', name: 'TBP → Protactinium-233', input: 'TBP', output: 'Protactinium-233', fluxPerItem: 2720000, heatPerFlux: 0, efficiency: 0 },
  { id: 'bismuth', name: 'Bismuth → Polonium', input: 'Bismuth', output: 'Polonium', fluxPerItem: 1920000, heatPerFlux: 0, efficiency: 0.5 },
] as const;
export type IrradiatorRecipeId = (typeof IRRADIATOR_RECIPES)[number]['id'];

/**
 * fission_decay_* defaults (decay heat, iodine, poison). The mechanics are off by default
 * (fission_decay_mechanics = false).
 */
export const DECAY_CONFIG = {
  buildUpTimes: [24000, 24000, 24000],
  lifetimes: [6000, 8000, 12000],
  equilibriumFactors: [1, 5, 1],
  daughterMultipliers: [5, 5],
  termMultipliers: [0.95, 0.05],
};

/** fission_source_efficiency (MetaEnums.NeutronSourceType). */
export const SOURCES = [
  { id: 'radium_beryllium', name: 'Ra-Be Neutron Source', efficiency: 0.9 },
  { id: 'polonium_beryllium', name: 'Po-Be Neutron Source', efficiency: 0.95 },
  { id: 'californium', name: 'Cf-252 Neutron Source', efficiency: 1.0 },
] as const;

/** Misc. fission config defaults. */
export const FISSION_CONFIG = {
  neutronReach: 4, // fission_neutron_reach
  coolingEfficiencyLeniency: 10, // fission_cooling_efficiency_leniency
  sparsityPenaltyMult: 0.5, // fission_sparsity_penalty_params[0]
  sparsityPenaltyThreshold: 0.75, // fission_sparsity_penalty_params[1]
  minSize: 1,
  maxSize: 24,
  heaterCoolantHeatPerMB: 128, // fission_heater_coolant_heat_per_mb
  coolerCoolantHeatPerMB: 32, // fission_cooler_coolant_heat_per_mb (PBR gas coolers)
  gasCoolerOutputPerMB: 2, // GasCoolerRecipes: 1 mB gas -> 2 mB hot gas
  intrinsicFluxEfficiency: 1, // fission_cell / vessel / chamber_intrinsic_flux_efficiency
  hotGasRFPerMB: 32, // turbine_power_per_mb[3], hot gas coolants
  nakHeatMult: 2, // fission_heating_nak_coolant_heat_mult (hot NaK -> heat exchanger)
  hpSteamRFPerMB: 16, // turbine_power_per_mb[0], high pressure steam
};

/** SFR heating fluids (FissionHeatingRecipes): input mB -> output mB of high pressure steam, heat per input mB. */
export const SFR_COOLANTS = [
  { id: 'water', name: 'Water → High Pressure Steam', inputPerRecipe: 1, outputPerRecipe: 4, heatPerMB: 64, product: 'High Pressure Steam', rfPerOutputMB: 16 },
  { id: 'preheated_water', name: 'Preheated Water → High Pressure Steam', inputPerRecipe: 1, outputPerRecipe: 4, heatPerMB: 32, product: 'High Pressure Steam', rfPerOutputMB: 16 },
] as const;

function titleCase(s: string) {
  return s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
export { titleCase };
