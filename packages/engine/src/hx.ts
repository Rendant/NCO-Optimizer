/**
 * NC:O heat exchanger (HX) — exact steady-state port of HeatExchangerLogic / HeatExchangerFlowHelper /
 * HeatExchangerTubeNetwork / HeatExchangerRecipes (default config), plus a designer that sizes a cross-flow HX for
 * the hot coolant of a molten-salt reactor (hot NaK in the tubes, water → high-pressure steam in the shell).
 *
 * Mechanics (per tick, steady state, all inputs supplied):
 *  - tubes connected through open faces form networks; each needs ≥ 1 inlet and ≥ 1 outlet on the casing; the shell
 *    (all non-baffle interior space) needs ≥ 1 inlet and ≥ 1 outlet that are not tube ports.
 *  - flow directions: for every inlet/outlet pair, every block on a shortest path gets the set of normalized
 *    (outgoing − incoming) directions; a tube's tube-/shell-flow is the normalized sum. Tubes that have both are
 *    "useful".
 *  - per network: tubeFlow / shellFlow = mean over useful tubes, flowCosine = mean dot product; contraflow if
 *    flowCosine < 1/24 (so cross-flow counts as contraflow).
 *  - temperature difference (arithmetic mean, LMTD off): contraflow compares the tube inlet with the shell outlet.
 *    Both end differences must have the same sign, matching the tube recipe's heating/cooling direction.
 *  - shared rate = ΔT × flow-direction multiplier(tube recipe, tubeFlow) × multiplier(shell recipe, shellFlow);
 *    the cooled side processes shared × Σ coefficient heat units / t, the heated side receives shared ×
 *    Σ coefficient × retention (tube type: copper 16 / 0.9, hard carbon 24 / 0.95, thermoconducting 32 / 1).
 *  - recipes: hot NaK (any heater coolant) 1 mB → 1 mB, 256 heat, 800 → 400 K; water 1 mB → 4 mB HP steam, 64 heat,
 *    300 → 600 K, prefers upward flow (+50 % when the mean flow points up, −50 % when down).
 */

export const HX_TUBES = [
  { id: 'copper', name: 'Copper Heat Exchanger Tube', coefficient: 16, retention: 0.9 },
  { id: 'hard_carbon', name: 'Hard Carbon Heat Exchanger Tube', coefficient: 24, retention: 0.95 },
  { id: 'thermoconducting', name: 'Thermoconducting Heat Exchanger Tube', coefficient: 32, retention: 1 },
] as const;
export type HxTubeId = (typeof HX_TUBES)[number]['id'];

export interface HxRecipe {
  id: string; name: string; input: string; inputSize: number; output: string; outputSize: number;
  /** heat per recipe ("heat difference") */
  heat: number; inT: number; outT: number; heatingFlag: boolean;
  /** preferred flow direction: 1 up, -1 down, 0 horizontal */
  dir: number; bonus: number;
}
/** heat_exchanger_nak_coolant_heat_mult (2) × fission_heater_coolant_heat_per_mb (128) */
export const HX_NAK_HEAT = 256;
export const HX_RECIPES: Record<string, HxRecipe> = {
  water: { id: 'water', name: 'Water → HP steam', input: 'water', inputSize: 1, output: 'high_pressure_steam', outputSize: 4, heat: 64, inT: 300, outT: 600, heatingFlag: false, dir: 1, bonus: 0.5 },
  preheated_water: { id: 'preheated_water', name: 'Preheated water → HP steam', input: 'preheated_water', inputSize: 1, output: 'high_pressure_steam', outputSize: 4, heat: 32, inT: 400, outT: 600, heatingFlag: false, dir: 1, bonus: 0.5 },
  hot_nak: { id: 'hot_nak', name: 'Hot NaK → NaK', input: 'nak_hot', inputSize: 1, output: 'nak', outputSize: 1, heat: HX_NAK_HEAT, inT: 800, outT: 400, heatingFlag: false, dir: 0, bonus: 0 },
};
export const HX_MAX_SIZE = 24;
const isHeating = (r: HxRecipe) => (r.inT === r.outT ? r.heatingFlag : r.inT < r.outT);
type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return l < 1e-4 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l]; };
export function flowDirectionMultiplier(r: HxRecipe, f: V3) {
  const p = r.dir === 0 ? Math.sqrt(f[0] * f[0] + f[2] * f[2]) : r.dir > 0 ? f[1] : -f[1];
  return Math.max(0, 1 + r.bonus * (p > 0.5 ? 1 : p > -0.5 ? 0 : -1));
}

// EnumFacing order: DOWN, UP, NORTH, SOUTH, WEST, EAST
const DIRS: V3[] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const OPP = [1, 0, 3, 2, 5, 4];
/** tube face settings */
export const CLOSED = 0, OPEN = 1, CLOSED_BAFFLE = 2, OPEN_BAFFLE = 3;
const isOpenSetting = (s: number) => s === OPEN || s === OPEN_BAFFLE;
const isBaffleSetting = (s: number) => s === CLOSED_BAFFLE || s === OPEN_BAFFLE;

export interface HxPort {
  /** position in interior coordinates; casing positions are at -1 or dim */
  pos: V3; kind: 'inlet' | 'outlet';
  /** recipe id fed into this inlet */
  recipe?: string;
  /** fluid supply into this inlet, mB/t (default: unlimited) */
  supply?: number;
  label?: string;
}
export interface HxLayout {
  dims: V3;
  /** per interior cell: -1 empty (shell space), 0..2 tube type index, 3 baffle block */
  cells: Int8Array | number[];
  /** per interior cell × 6 faces: CLOSED / OPEN / CLOSED_BAFFLE / OPEN_BAFFLE (tubes only) */
  settings: Uint8Array | number[];
  ports: HxPort[];
}
export interface HxNetworkStats {
  inlets: number[]; outlets: number[]; tubes: number; usefulTubes: number; recipe: string | null; label?: string;
  tubeFlow: V3; shellFlow: V3; flowCosine: number; contraflow: boolean; meanTempDiff: number;
  tubeDirMult: number; shellDirMult: number;
  /** Σ coefficient (cooling side) and Σ coefficient × retention (heating side) of useful tubes */
  coolingMult: number; heatingMult: number;
  /** heat units / t the network could transfer with unlimited supply */
  capacity: number;
  /** heat units / t actually removed from (or added to) the tube fluid */
  tubeHeat: number; shellHeat: number;
  /** tube fluid processed (input mB/t) and produced */
  tubeInput: number; tubeOutput: number;
  supply: number; problem?: string;
}
export interface HxStats {
  valid: boolean; error?: string; dims: V3; exterior: V3;
  tubes: number; usefulTubes: number; networks: HxNetworkStats[];
  shellRecipe: string | null; shellInput: number; shellOutput: number; shellHeat: number; tubeHeat: number;
  shellInlets: number; shellOutlets: number;
}

export function simulateHX(layout: HxLayout): HxStats {
  const [X, Y, Z] = layout.dims;
  const SX = X + 2, SY = Y + 2, SZ = Z + 2, E = SX * SY * SZ;
  const ex = (x: number, y: number, z: number) => x + 1 + SX * (y + 1 + SY * (z + 1));
  const cx = new Int16Array(E), cy = new Int16Array(E), cz = new Int16Array(E);
  for (let z = -1; z <= Z; z++) for (let y = -1; y <= Y; y++) for (let x = -1; x <= X; x++) { const e = ex(x, y, z); cx[e] = x; cy[e] = y; cz[e] = z; }
  const nb = new Int32Array(E * 6).fill(-1);
  for (let e = 0; e < E; e++) for (let d = 0; d < 6; d++) {
    const x = cx[e] + DIRS[d][0], y = cy[e] + DIRS[d][1], z = cz[e] + DIRS[d][2];
    if (x >= -1 && x <= X && y >= -1 && y <= Y && z >= -1 && z <= Z) nb[e * 6 + d] = ex(x, y, z);
  }
  const interior = (e: number) => cx[e] >= 0 && cx[e] < X && cy[e] >= 0 && cy[e] < Y && cz[e] >= 0 && cz[e] < Z;
  const tubeType = new Int8Array(E).fill(-1), baffle = new Uint8Array(E), set = new Uint8Array(E * 6);
  let tubeCount = 0;
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
    const i = x + X * (y + Y * z), e = ex(x, y, z), c = layout.cells[i];
    if (c >= 0 && c <= 2) { tubeType[e] = c; tubeCount++; for (let d = 0; d < 6; d++) set[e * 6 + d] = layout.settings[i * 6 + d]; } else if (c === 3) baffle[e] = 1;
  }
  const isTube = (e: number) => e >= 0 && tubeType[e] >= 0;
  const portAt = new Int32Array(E).fill(-1);
  layout.ports.forEach((p, k) => { portAt[ex(p.pos[0], p.pos[1], p.pos[2])] = k; });
  const isInlet = (e: number) => e >= 0 && portAt[e] >= 0 && layout.ports[portAt[e]].kind === 'inlet';
  const isOutlet = (e: number) => e >= 0 && portAt[e] >= 0 && layout.ports[portAt[e]].kind === 'outlet';
  const fail = (error: string): HxStats => ({ valid: false, error, dims: [X, Y, Z], exterior: [X + 2, Y + 2, Z + 2], tubes: tubeCount, usefulTubes: 0, networks: [], shellRecipe: null, shellInput: 0, shellOutput: 0, shellHeat: 0, tubeHeat: 0, shellInlets: 0, shellOutlets: 0 });

  // ---- tube networks
  const netOf = new Int32Array(E).fill(-1);
  const nets: { tubes: number[]; inlets: number[]; outlets: number[] }[] = [];
  const tubeInletSet = new Set<number>(), tubeOutletSet = new Set<number>();
  for (let e0 = 0; e0 < E; e0++) {
    if (!isTube(e0) || netOf[e0] >= 0) continue;
    const id = nets.length, net = { tubes: [] as number[], inlets: [] as number[], outlets: [] as number[] };
    nets.push(net); netOf[e0] = id;
    const stack = [e0];
    while (stack.length) {
      const e = stack.pop()!;
      for (let d = 0; d < 6; d++) {
        if (!isOpenSetting(set[e * 6 + d])) continue;
        const o = nb[e * 6 + d];
        if (isInlet(o)) { tubeInletSet.add(o); if (!net.inlets.includes(o)) net.inlets.push(o); continue; }
        if (isOutlet(o)) { tubeOutletSet.add(o); if (!net.outlets.includes(o)) net.outlets.push(o); continue; }
        if (isTube(o) && isOpenSetting(set[o * 6 + OPP[d]])) { if (netOf[o] < 0) { netOf[o] = id; stack.push(o); } continue; }
        return fail(`Tubes must not have dangling connections (tube at ${cx[e]},${cy[e]},${cz[e]})`);
      }
      net.tubes.push(e);
    }
  }
  for (const n of nets) if (!n.inlets.length || !n.outlets.length) return fail('Tube networks must have at least one inlet and one outlet');
  const shellIn: number[] = [], shellOut: number[] = [];
  layout.ports.forEach((p) => {
    const e = ex(p.pos[0], p.pos[1], p.pos[2]);
    if (p.kind === 'inlet' && !tubeInletSet.has(e)) shellIn.push(e);
    if (p.kind === 'outlet' && !tubeOutletSet.has(e)) shellOut.push(e);
  });
  // BlockPos.toLong order for the master inlet (sorted): y is the low-order field after z; mimic by (x, z, y) packing
  const posKey = (e: number) => (cx[e] + 1024) * 2 ** 26 + (cz[e] + 1024) * 2 ** 12 + (cy[e] + 1024);
  shellIn.sort((a, b) => posKey(a) - posKey(b));
  for (const n of nets) n.inlets.sort((a, b) => posKey(a) - posKey(b));

  // ---- flow helper (exact port)
  type Conn = (e: number) => Uint8Array | null;
  const getFlowMap = (inlets: number[], outlets: number[], conn: (e: number) => number, open: (s: number) => boolean, space: (e: number, d: number) => boolean) => {
    // conn(e) returns the base index into `set` (e*6) or -1 for "no connections array" (always open)
    const isOpenDir = (e: number, d: number) => { const b = conn(e); return b < 0 || open(set[b + d]); };
    const trav = (e: number, d: number) => isOpenDir(e, d) && nb[e * 6 + d] >= 0 && space(nb[e * 6 + d], d);
    const flow = new Map<number, Set<number>>();
    if (!inlets.length || !outlets.length) return flow;
    const fwd = inlets.map((s) => {
      const dist = new Int32Array(E).fill(-1), q: number[] = [];
      for (let d = 0; d < 6; d++) if (trav(s, d)) { const o = nb[s * 6 + d]; if (dist[o] < 0) { dist[o] = 1; q.push(o); } }
      for (let h = 0; h < q.length; h++) { const p = q[h]; for (let d = 0; d < 6; d++) if (trav(p, d)) { const o = nb[p * 6 + d]; if (dist[o] < 0) { dist[o] = dist[p] + 1; q.push(o); } } }
      return { dist, list: q };
    });
    const rev = outlets.map((t) => {
      const dist = new Int32Array(E).fill(-1), q: number[] = [];
      for (let d = 0; d < 6; d++) { const s = nb[t * 6 + d]; if (s >= 0 && space(s, d) && isOpenDir(s, OPP[d])) { if (dist[s] < 0) { dist[s] = 1; q.push(s); } } }
      for (let h = 0; h < q.length; h++) {
        const p = q[h];
        for (let d = 0; d < 6; d++) { const pr = nb[p * 6 + d]; if (pr >= 0 && space(pr, d) && trav(pr, OPP[d]) && dist[pr] < 0) { dist[pr] = dist[p] + 1; q.push(pr); } }
      }
      return dist;
    });
    for (let a = 0; a < inlets.length; a++) {
      const from = fwd[a];
      if (!from.list.length) continue;
      for (let b = 0; b < outlets.length; b++) {
        const to = rev[b];
        let best = Infinity;
        for (const p of from.list) if (to[p] >= 0) best = Math.min(best, from.dist[p] + to[p]);
        if (best === Infinity) continue;
        const inletPos = inlets[a], outletPos = outlets[b];
        for (const p of from.list) {
          const di = from.dist[p], dout = to[p];
          if (dout === -1 || di + dout !== best) continue;
          const inc: number[] = [], out: number[] = [];
          for (let d = 0; d < 6; d++) {
            const ip = nb[p * 6 + d];
            if (ip < 0) continue;
            if (ip === inletPos) { if (di === 1 && trav(ip, OPP[d])) inc.push(ip); continue; }
            if (from.dist[ip] === di - 1 && to[ip] === dout + 1 && trav(ip, OPP[d])) inc.push(ip);
          }
          for (let d = 0; d < 6; d++) {
            const op = nb[p * 6 + d];
            if (op < 0) continue;
            if (op === outletPos) { if (dout === 1 && isOpenDir(p, d)) out.push(op); continue; }
            if (from.dist[op] === di + 1 && to[op] === dout - 1 && trav(p, d)) out.push(op);
          }
          if (!inc.length || !out.length) continue;
          let s = flow.get(p);
          if (!s) flow.set(p, (s = new Set()));
          for (const i of inc) for (const o of out) s.add(((cx[o] - cx[i] + 4) * 9 + (cy[o] - cy[i] + 4)) * 9 + (cz[o] - cz[i] + 4));
        }
      }
    }
    return flow;
  };
  const sumDirs = (s: Set<number>): V3 => {
    const v: V3 = [0, 0, 0];
    for (const k of s) { const dz = (k % 9) - 4, dy = (Math.floor(k / 9) % 9) - 4, dx = Math.floor(k / 81) - 4; const n = norm([dx, dy, dz]); v[0] += n[0]; v[1] += n[1]; v[2] += n[2]; }
    return norm(v);
  };
  void (null as unknown as Conn);

  // tube flows per network
  const tubeFlow = new Map<number, V3>(), shellFlow = new Map<number, V3>();
  nets.forEach((n, id) => {
    const fm = getFlowMap(n.inlets, n.outlets, (e) => (netOf[e] === id && isTube(e) ? e * 6 : -1), isOpenSetting, (e) => netOf[e] === id && isTube(e));
    for (const [e, s] of fm) tubeFlow.set(e, sumDirs(s));
  });
  if (!shellIn.length || !shellOut.length) return fail('Shell must have at least one inlet and one outlet');

  // shell space
  const clamp = (e: number) => ex(Math.min(X - 1, Math.max(0, cx[e])), Math.min(Y - 1, Math.max(0, cy[e])), Math.min(Z - 1, Math.max(0, cz[e])));
  const shell = new Uint8Array(E), stack: number[] = [];
  for (const s of shellIn) { const c = clamp(s); if (baffle[c]) return fail('Shell inlet must not be blocked by a baffle'); if (!shell[c]) { shell[c] = 1; stack.push(c); } }
  for (const t of shellOut) if (baffle[clamp(t)]) return fail('Shell outlet must not be blocked by a baffle');
  let shellCount = stack.length;
  while (stack.length) {
    const p = stack.pop()!;
    for (let d = 0; d < 6; d++) {
      if (isTube(p) && isBaffleSetting(set[p * 6 + d])) continue;
      const o = nb[p * 6 + d];
      if (o < 0 || !interior(o) || shell[o]) continue;
      if (!baffle[o] || (isTube(o) && !isBaffleSetting(set[o * 6 + OPP[d]]))) { shell[o] = 1; shellCount++; stack.push(o); }
    }
  }
  let baffleCount = 0;
  for (let e = 0; e < E; e++) if (baffle[e]) baffleCount++;
  if (shellCount + baffleCount !== X * Y * Z) return fail('Each shell inlet must have an available shell outlet (shell interior not fully connected)');
  const sfm = getFlowMap(shellIn, shellOut, (e) => (isTube(e) ? e * 6 : -1), (s) => !isBaffleSetting(s), (e, d) => shell[e] === 1 && (!isTube(e) || !isBaffleSetting(set[e * 6 + OPP[d]])));
  for (const [e, s] of sfm) if (isTube(e) && tubeFlow.has(e)) shellFlow.set(e, sumDirs(s));

  // ---- recipes & transfer
  const shellPort = layout.ports[portAt[shellIn[0]]];
  const shellRecipe = shellPort.recipe ? HX_RECIPES[shellPort.recipe] ?? null : null;
  const networks: HxNetworkStats[] = [];
  let shellHeat = 0, tubeHeatTot = 0, useful = 0;
  nets.forEach((n) => {
    let u = 0, cool = 0, heat = 0, cos = 0;
    const tf: V3 = [0, 0, 0], sf: V3 = [0, 0, 0];
    for (const e of n.tubes) {
      const t = tubeFlow.get(e), s = shellFlow.get(e);
      if (!t || !s) continue;
      u++; tf[0] += t[0]; tf[1] += t[1]; tf[2] += t[2]; sf[0] += s[0]; sf[1] += s[1]; sf[2] += s[2];
      cos += t[0] * s[0] + t[1] * s[1] + t[2] * s[2];
      const tt = HX_TUBES[tubeType[e]];
      heat += tt.coefficient * tt.retention; cool += tt.coefficient;
    }
    if (u > 0) { for (let k = 0; k < 3; k++) { tf[k] /= u; sf[k] /= u; } cos /= u; }
    useful += u;
    const master = layout.ports[portAt[n.inlets[0]]];
    const recipe = master.recipe ? HX_RECIPES[master.recipe] ?? null : null;
    const supply = n.inlets.reduce((a, e) => a + (layout.ports[portAt[e]].supply ?? Infinity), 0);
    const st: HxNetworkStats = {
      inlets: n.inlets.map((e) => portAt[e]), outlets: n.outlets.map((e) => portAt[e]), tubes: n.tubes.length, usefulTubes: u, recipe: recipe?.id ?? null, label: master.label,
      tubeFlow: tf, shellFlow: sf, flowCosine: cos, contraflow: cos < 1 / HX_MAX_SIZE, meanTempDiff: 0, tubeDirMult: 0, shellDirMult: 0,
      coolingMult: cool, heatingMult: heat, capacity: 0, tubeHeat: 0, shellHeat: 0, tubeInput: 0, tubeOutput: 0, supply,
    };
    networks.push(st);
    if (!recipe || !shellRecipe) { st.problem = 'no recipe'; return; }
    if (isHeating(recipe) === isHeating(shellRecipe)) { st.problem = 'tube and shell fluids are both heating or both cooling'; return; }
    const inEnd = st.contraflow ? shellRecipe.outT : shellRecipe.inT, outEnd = st.contraflow ? shellRecipe.inT : shellRecipe.outT;
    const dIn = recipe.inT - inEnd, dOut = recipe.outT - outEnd, sum = dIn + dOut;
    if (sum === 0) { st.problem = 'no temperature difference'; return; }
    const heating = sum < 0;
    if (isHeating(recipe) !== heating) { st.problem = 'temperatures run the wrong way'; return; }
    if ((dIn > 0 && dOut < 0) || (dIn < 0 && dOut > 0)) { st.problem = st.contraflow ? 'temperature cross' : 'parallel flow: the temperatures cross — make the tube flow run against the shell flow'; return; }
    st.meanTempDiff = Math.abs(0.5 * (dIn + dOut));
    st.tubeDirMult = flowDirectionMultiplier(recipe, tf); st.shellDirMult = flowDirectionMultiplier(shellRecipe, sf);
    const shared = st.meanTempDiff * st.tubeDirMult * st.shellDirMult;
    if (!(shared > 0) || u === 0) { st.problem = u === 0 ? 'no useful tubes (tube not on a shell flow path)' : 'flow direction multiplier is 0'; return; }
    const tubeMult = heating ? heat : cool, shellMult = heating ? cool : heat;
    st.capacity = shared * tubeMult;
    const capped = Math.min(shared, (supply * recipe.heat / recipe.inputSize) / tubeMult);
    st.tubeHeat = capped * tubeMult; st.shellHeat = capped * shellMult;
    st.tubeInput = (st.tubeHeat / recipe.heat) * recipe.inputSize; st.tubeOutput = (st.tubeHeat / recipe.heat) * recipe.outputSize;
    shellHeat += st.shellHeat; tubeHeatTot += st.tubeHeat;
  });
  const shellRecipes = shellRecipe ? shellHeat / shellRecipe.heat : 0;
  return {
    valid: true, dims: [X, Y, Z], exterior: [X + 2, Y + 2, Z + 2], tubes: tubeCount, usefulTubes: useful, networks,
    shellRecipe: shellRecipe?.id ?? null, shellInput: shellRecipes * (shellRecipe?.inputSize ?? 0), shellOutput: shellRecipes * (shellRecipe?.outputSize ?? 0),
    shellHeat, tubeHeat: tubeHeatTot, shellInlets: shellIn.length, shellOutlets: shellOut.length,
  };
}

// ------------------------------------------------------------------ designer
export interface HxDesignRequest {
  /** hot coolant per heater coolant name (MSR stats.hotCoolant), mB/t */
  hotCoolant: Record<string, number>;
  /** tube type, or undefined = compare all three */
  tubeType?: HxTubeId;
  coldFluid?: 'water' | 'preheated_water';
  maxSize?: number;
  /** number of identical heat exchangers sharing the flow */
  exchangers?: number;
}
export interface HxRow { y: number; z: number; coolant: string }
export interface HxDesign {
  tubeType: HxTubeId; coldFluid: string; exchangers: number;
  dims: V3; exterior: V3; rows: HxRow[]; tubes: number;
  /** per exchanger */
  stats: HxStats;
  /** totals over all exchangers */
  steam: number; water: number; heatIn: number; heatOut: number; retention: number;
  coolants: { name: string; supply: number; processed: number; rows: number; tubes: number; capacity: number }[];
  ports: { tubeInlets: number; tubeOutlets: number; shellInlets: number; shellOutlets: number };
  parts: { name: string; count: number }[];
  layout: HxLayout;
}
export interface HxDesignResult { best: HxDesign; alternatives: HxDesign[]; demandHeat: number; idealSteam: number }

/**
 * Canonical cross-flow layout: interior X × Y × Z filled with straight tube rows along X (one row per (y, z) used,
 * open only at both ends; inlet on the east wall, outlet on the west wall, so the coolant flows towards −X).
 * Shell inlets under every (x = 0, z) column on the bottom face, shell outlets above every (x = X−1, z) on the top
 * face: the water rises diagonally against the tube flow (upward bonus ×1.5, flowCosine < 0 → contraflow).
 */
export function buildCrossflowLayout(dims: V3, rows: HxRow[], tube: number, coldFluid: string, supplies: Record<string, number>): HxLayout {
  const [X, Y, Z] = dims, N = X * Y * Z;
  const cells = new Int8Array(N).fill(-1), settings = new Uint8Array(N * 6);
  const ports: HxPort[] = [];
  const perCoolantRows = new Map<string, number>();
  for (const r of rows) perCoolantRows.set(r.coolant, (perCoolantRows.get(r.coolant) ?? 0) + 1);
  for (const r of rows) {
    for (let x = 0; x < X; x++) {
      const i = x + X * (r.y + Y * r.z);
      cells[i] = tube; settings[i * 6 + 4] = OPEN; settings[i * 6 + 5] = OPEN;
    }
    const sup = (supplies[r.coolant] ?? 0) / (perCoolantRows.get(r.coolant) ?? 1);
    ports.push({ pos: [X, r.y, r.z], kind: 'inlet', recipe: 'hot_nak', supply: sup, label: r.coolant });
    ports.push({ pos: [-1, r.y, r.z], kind: 'outlet', label: r.coolant });
  }
  for (let z = 0; z < Z; z++) {
    ports.push({ pos: [0, -1, z], kind: 'inlet', recipe: coldFluid, label: 'shell' });
    ports.push({ pos: [X - 1, Y, z], kind: 'outlet', label: 'shell' });
  }
  return { dims, cells, settings, ports };
}

function designFor(req: HxDesignRequest, tubeIdx: number): HxDesign | null {
  const cold = req.coldFluid ?? 'water', shellR = HX_RECIPES[cold], tube = HX_TUBES[tubeIdx];
  const maxS = Math.min(HX_MAX_SIZE, Math.max(1, req.maxSize ?? HX_MAX_SIZE));
  const coolants = Object.entries(req.hotCoolant).filter(([, v]) => v > 1e-9).sort((a, b) => b[1] - a[1]);
  if (!coolants.length) return null;
  // contraflow against water: ΔT = ((800 - out) + (400 - in)) / 2
  const dT = Math.abs(0.5 * ((HX_RECIPES.hot_nak.inT - shellR.outT) + (HX_RECIPES.hot_nak.outT - shellR.inT)));
  const capPerTube = dT * tube.coefficient * (1 + shellR.bonus);
  const kMin = Math.max(1, req.exchangers ?? 1), kMax = req.exchangers ?? 64;
  let found: { dims: V3; rows: HxRow[]; k: number; layout: HxLayout; stats: HxStats } | null = null;
  for (let k = kMin; k <= kMax && !found; k++) {
    const need = coolants.map(([, q]) => Math.ceil((q / k) * HX_NAK_HEAT / capPerTube - 1e-9));
    let best: { dims: V3; rows: HxRow[]; n: number; vol: number } | null = null;
    for (let X = 1; X <= maxS; X++) {
      const rowsNeed = need.map((n) => Math.max(1, Math.ceil(n / X)));
      const R = rowsNeed.reduce((a, b) => a + b, 0);
      for (let Y = 1; Y <= maxS; Y++) {
        const Z = Math.ceil(R / Y);
        if (Z > maxS) continue;
        const vol = (X + 2) * (Y + 2) * (Z + 2), n = R * X;
        if (!best || vol < best.vol || (vol === best.vol && n < best.n)) {
          const rows: HxRow[] = [];
          let c = 0, left = rowsNeed[0];
          for (let z = 0; z < Z && c < coolants.length; z++) for (let y = 0; y < Y && c < coolants.length; y++) {
            rows.push({ y, z, coolant: coolants[c][0] });
            if (--left === 0) { c++; left = rowsNeed[c]; }
          }
          best = { dims: [X, Y, Z], rows, n, vol };
        }
      }
    }
    if (!best) continue;
    // verify with the exact simulation; add rows where edge effects (lost upward bonus) leave a coolant short
    let { dims, rows } = best;
    const supplies = Object.fromEntries(coolants.map(([n, q]) => [n, q / k]));
    let layout = buildCrossflowLayout(dims, rows, tubeIdx, cold, supplies), stats = simulateHX(layout);
    let ok = false;
    for (let guard = 0; guard < 64 && stats.valid; guard++) {
      const deficits = coolants.map(([name, q]) => {
        const ns = stats.networks.filter((n) => n.label === name);
        const got = ns.reduce((a, n) => a + n.tubeInput, 0), perRow = ns.length ? ns.reduce((a, n) => a + n.capacity, 0) / ns.length / HX_NAK_HEAT : 1;
        return { name, rowsMore: q / k - got > 1e-6 ? Math.max(1, Math.ceil((q / k - got) / Math.max(1e-9, perRow * 0.9))) : 0 };
      }).filter((d) => d.rowsMore > 0);
      if (!deficits.length) { ok = true; break; }
      const [X, Y, Z] = dims;
      const used = new Set(rows.map((r) => r.y + ',' + r.z));
      const free: { y: number; z: number }[] = [];
      for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) if (!used.has(y + ',' + z)) free.push({ y, z });
      const want = deficits.reduce((a, d) => a + d.rowsMore, 0);
      let nz = Z;
      while (free.length < want && nz < maxS) { for (let y = 0; y < Y; y++) free.push({ y, z: nz }); nz++; }
      if (free.length < want) break;
      dims = [X, Y, nz];
      rows = [...rows];
      for (const d of deficits) for (let j = 0; j < d.rowsMore; j++) rows.push({ ...free.shift()!, coolant: d.name });
      layout = buildCrossflowLayout(dims, rows, tubeIdx, cold, supplies); stats = simulateHX(layout);
    }
    if (ok) found = { dims, rows, k, layout, stats };
  }
  if (!found) return null;
  const { dims, rows, k, layout, stats } = found;
  const tubes = stats.tubes;
  const perCoolant = coolants.map(([name, q]) => {
    const ns = stats.networks.filter((n) => n.label === name);
    return { name, supply: q, processed: ns.reduce((a, n) => a + n.tubeInput, 0) * k, rows: ns.length, tubes: ns.reduce((a, n) => a + n.tubes, 0), capacity: ns.reduce((a, n) => a + n.capacity, 0) / HX_NAK_HEAT * k };
  });
  const steam = stats.shellOutput * k, water = stats.shellInput * k;
  const tubeIn = rows.length, shellPorts = dims[2];
  return {
    tubeType: tube.id, coldFluid: cold, exchangers: k, dims, exterior: [dims[0] + 2, dims[1] + 2, dims[2] + 2], rows, tubes,
    stats, steam, water, heatIn: stats.tubeHeat * k, heatOut: stats.shellHeat * k, retention: stats.tubeHeat > 0 ? stats.shellHeat / stats.tubeHeat : 0,
    coolants: perCoolant,
    ports: { tubeInlets: tubeIn, tubeOutlets: tubeIn, shellInlets: shellPorts, shellOutlets: shellPorts },
    parts: [
      { name: tube.name, count: tubes * k },
      { name: 'Heat Exchanger Inlet', count: (tubeIn + shellPorts) * k },
      { name: 'Heat Exchanger Outlet', count: (tubeIn + shellPorts) * k },
      { name: 'Heat Exchanger Controller', count: k },
      { name: 'Heat Exchanger Casing / Glass', count: (((dims[0] + 2) * (dims[1] + 2) * (dims[2] + 2) - dims[0] * dims[1] * dims[2]) - 2 * (tubeIn + shellPorts) - 1) * k },
    ],
    layout,
  };
}

export function designHeatExchanger(req: HxDesignRequest): HxDesignResult {
  const cold = HX_RECIPES[req.coldFluid ?? 'water'];
  const demandHeat = Object.values(req.hotCoolant).reduce((a, b) => a + b, 0) * HX_NAK_HEAT;
  const idealSteam = (demandHeat / cold.heat) * cold.outputSize;
  const idx = req.tubeType ? [HX_TUBES.findIndex((t) => t.id === req.tubeType)] : [0, 1, 2];
  const all = idx.map((i) => designFor(req, i)).filter((d): d is HxDesign => !!d);
  if (!all.length) throw new Error('No hot coolant to exchange (the reactor produces none) or no design fits the size limit');
  // best: most steam, then smallest exchanger, then fewest tubes
  const vol = (d: HxDesign) => d.exterior[0] * d.exterior[1] * d.exterior[2] * d.exchangers;
  all.sort((a, b) => (b.steam - a.steam > 1e-6 ? 1 : a.steam - b.steam > 1e-6 ? -1 : vol(a) - vol(b) || a.tubes - b.tubes));
  return { best: all[0], alternatives: all.slice(1), demandHeat, idealSteam };
}
