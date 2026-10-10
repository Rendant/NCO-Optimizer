/**
 * Deliberately literal port of the solid-fuel refresh control flow from the NuclearCraft source
 * (FissionReactorLogic.refreshReactor/refreshFlux/distributeFlux/refreshClusters, IFissionFuelComponent,
 * IFissionComponent.clusterSearch, TileSolidFissionSink.isValidHeatConductor). Used only as a test
 * oracle for the fast fixed-point simulator. All fuel cells are treated as primed (no sources).
 */
import { FISSION_CONFIG, FuelDef, MODERATORS, REFLECTORS, SINK_RULES, COOLING_RATES } from '../src/components.js';
import { FUEL, MOD0, REFL0, CONDUCTOR, COOLER0, isModerator, isReflector } from '../src/blocks.js';
import { parseRule, adjacentSatisfied, PlacementRule } from '../src/rules.js';
import { DIRS } from '../src/simulator.js';

interface Line { mods: number[]; active: boolean[]; flux: number; sink: number; reflector: boolean }
class Cell {
  primed = false; fluxSearched = false; flux = 0; heatMult = 0; isProcessing = false;
  lineFlux = [0, 0, 0, 0, 0, 0]; lineEff: (number | null)[] = [null, null, null, null, null, null];
  adjSink: number[] = [-1, -1, -1, -1, -1, -1];
  lineCache: (Line | null)[] = [null, null, null, null, null, null];
  localPassive: Set<number>[] = [0, 1, 2, 3, 4, 5].map(() => new Set());
  localActive: Set<number>[] = [0, 1, 2, 3, 4, 5].map(() => new Set());
  reflPassive: Set<number>[] = [0, 1, 2, 3, 4, 5].map(() => new Set());
  reflActive: Set<number>[] = [0, 1, 2, 3, 4, 5].map(() => new Set());
  activeReflectorCache = new Set<number>();
  cluster: number | null = null;
  constructor(public pos: number) {}
}

export function referenceSimulate(dims: [number, number, number], grid: Uint8Array, fuel: FuelDef) {
  const [X, Y, Z] = dims; const N = X * Y * Z;
  const nbr = (i: number, d: number) => {
    const x = i % X, y = Math.floor(i / X) % Y, z = Math.floor(i / (X * Y));
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
    return nx < 0 || ny < 0 || nz < 0 || nx >= X || ny >= Y || nz >= Z ? -1 : nx + X * (ny + Y * nz);
  };
  const rules: PlacementRule[] = SINK_RULES.map((r) => parseRule(r, 'sfr'));
  const cells = new Map<number, Cell>();
  for (let i = 0; i < N; i++) if (grid[i] === FUEL) cells.set(i, new Cell(i));
  const sinkValid = new Map<number, boolean>();
  const sinkCluster = new Map<number, number | null>();
  const condCluster = new Map<number, number | null>();
  for (let i = 0; i < N; i++) { if (grid[i] >= COOLER0) { sinkValid.set(i, false); sinkCluster.set(i, null); } if (grid[i] === CONDUCTOR) condCluster.set(i, null); }
  const isComponent = (i: number) => i >= 0 && (grid[i] === FUEL || grid[i] >= COOLER0 || grid[i] === CONDUCTOR);
  let passive = new Set<number>(), active = new Set<number>(), activeRefl = new Set<number>();
  let refreshFlag = false;
  const componentFail = new Set<number>();
  let assumedValid = new Set<number>();
  const crit = fuel.criticality;
  const isRunning = (c: Cell) => c.isProcessing;
  const refreshIsProcessing = (c: Cell) => { c.isProcessing = c.flux >= crit; };

  const addToReactorCache = (line: Line) => line.mods.forEach((m, k) => (line.active[k] ? active : passive).add(m));

  function updateModeratorLine(src: Cell, target: Cell, d: number, line: Line) {
    refreshIsProcessing(target); // onEndModeratorLine
    if (line.mods.length) line.active[line.mods.length - 1] = true; // target.canSupportActiveModerator(true)
    if (isRunning(src) && isRunning(target)) addToReactorCache(line);
    else {
      src.lineCache[d] = line;
      line.mods.forEach((m, k) => (line.active[k] ? src.localActive[d] : src.localPassive[d]).add(m));
    }
    src.adjSink[d] = target.pos;
  }

  function distributeFrom(c: Cell, cache: Set<Cell>) {
    dirLoop: for (let d = 0; d < 6; d++) {
      let p = nbr(c.pos, d);
      if (p < 0 || componentFail.has(p) || !isModerator(grid[p])) continue;
      const line: Line = { mods: [p], active: [true], flux: MODERATORS[grid[p] - MOD0].fluxFactor, sink: -1, reflector: false };
      let eff = MODERATORS[grid[p] - MOD0].efficiency;
      for (let i = 2; i <= FISSION_CONFIG.neutronReach + 1; i++) {
        p = nbr(p, d);
        if (p < 0) continue dirLoop;
        if (isModerator(grid[p])) { line.mods.push(p); line.active.push(false); line.flux += MODERATORS[grid[p] - MOD0].fluxFactor; eff += MODERATORS[grid[p] - MOD0].efficiency; continue; }
        const t = cells.get(p);
        if (t) {
          line.sink = p; t.flux += line.flux; t.lineFlux[d ^ 1] = line.flux; t.lineEff[d ^ 1] = eff / (i - 1); t.heatMult++;
          updateModeratorLine(c, t, d, line); cache.add(t);
        } else if (i - 1 <= FISSION_CONFIG.neutronReach / 2 && isReflector(grid[p])) {
          const r = REFLECTORS[grid[p] - REFL0];
          line.reflector = true; line.flux = Math.floor(2 * line.flux * r.reflectivity);
          c.flux += line.flux; c.lineFlux[d] = line.flux; c.lineEff[d] = (r.efficiency * eff) / (i - 1); c.heatMult++;
          if (isRunning(c)) { addToReactorCache(line); activeRefl.add(p); }
          else { c.lineCache[d] = line; line.mods.forEach((m, k) => (line.active[k] ? c.reflActive[d] : c.reflPassive[d]).add(m)); c.activeReflectorCache.add(p); }
        }
        continue dirLoop;
      }
    }
  }
  function fluxSearch(c: Cell, cache: Set<Cell>) {
    if (!c.fluxSearched && (c.primed || isRunning(c))) c.fluxSearched = true; else return;
    distributeFrom(c, cache);
  }

  function refreshFlux() {
    const primedFail = new Set<number>();
    do {
      refreshFlag = false;
      const primedCache: Cell[] = [];
      for (const c of cells.values()) {
        refreshIsProcessing(c);
        if (!primedFail.has(c.pos)) { c.primed = true; primedCache.push(c); }
        Object.assign(c, { fluxSearched: false, flux: 0, heatMult: 0, cluster: null });
        c.lineFlux = [0, 0, 0, 0, 0, 0]; c.lineEff = [null, null, null, null, null, null]; c.adjSink = [-1, -1, -1, -1, -1, -1];
        c.lineCache = [null, null, null, null, null, null];
        for (const s of [...c.localActive, ...c.localPassive, ...c.reflActive, ...c.reflPassive]) s.clear();
        c.activeReflectorCache.clear();
      }
      for (const k of sinkValid.keys()) { sinkValid.set(k, false); sinkCluster.set(k, null); }
      for (const k of condCluster.keys()) condCluster.set(k, null);
      passive = new Set(); active = new Set(); activeRefl = new Set();
      for (const root of primedCache) {
        let cache = new Set<Cell>(); fluxSearch(root, cache);
        while (cache.size) { const sub = new Set<Cell>(); for (const c of cache) fluxSearch(c, sub); cache = sub; }
      }
      for (const c of primedCache) {
        refreshIsProcessing(c);
        if (isRunning(c)) { // defaultRefreshLocal
          for (let d = 0; d < 6; d++) {
            const line = c.lineCache[d];
            if (line && (line.reflector || (line.sink >= 0 && isRunning(cells.get(line.sink)!)))) {
              c.localPassive[d].forEach((m) => passive.add(m)); c.localActive[d].forEach((m) => active.add(m));
            }
            c.reflPassive[d].forEach((m) => passive.add(m)); c.reflActive[d].forEach((m) => active.add(m));
            c.activeReflectorCache.forEach((m) => activeRefl.add(m));
          }
        }
        c.primed = false;
        if (!isRunning(c)) { primedFail.add(c.pos); refreshFlag = true; }
      }
    } while (refreshFlag);
  }

  // ---- clusters
  let clusterCount = 0;
  const clusterWall = new Map<number, boolean>();
  const getCluster = (i: number) => (grid[i] === FUEL ? cells.get(i)!.cluster : grid[i] >= COOLER0 ? sinkCluster.get(i)! : condCluster.get(i)!);
  const setCluster = (i: number, id: number) => { if (grid[i] === FUEL) cells.get(i)!.cluster = id; else if (grid[i] >= COOLER0) sinkCluster.set(i, id); else condCluster.set(i, id); };
  const mergeClusters = (a: number, b: number) => {
    if (a === b) return;
    for (const c of cells.values()) if (c.cluster === b) c.cluster = a;
    for (const [k, v] of sinkCluster) if (v === b) sinkCluster.set(k, a);
    for (const [k, v] of condCluster) if (v === b) condCluster.set(k, a);
    clusterWall.set(a, !!clusterWall.get(a) || !!clusterWall.get(b));
  };
  const satisfied = (i: number, t: number) => {
    const rule = rules[t];
    const one = (s: PlacementRule['subs'][number]) => {
      let mask = 0;
      for (let d = 0; d < 6; d++) {
        const j = nbr(i, d); let ok = false;
        if (s.target === 'casing') ok = j < 0;
        else if (j >= 0) {
          if (s.target === 'conductor') ok = grid[j] === CONDUCTOR;
          else if (s.target === 'moderator') ok = active.has(j) && isModerator(grid[j]);
          else if (s.target === 'reflector') ok = activeRefl.has(j) && isReflector(grid[j]);
          else if (s.target === 'fuel') ok = grid[j] === FUEL && isRunning(cells.get(j)!);
          else if (s.target === 'cooler') ok = grid[j] >= COOLER0 && sinkValid.get(j)! && (s.coolerType < 0 || grid[j] - COOLER0 === s.coolerType);
        }
        if (ok) mask |= 1 << d;
      }
      return adjacentSatisfied(s, mask);
    };
    return rule.op === 'and' ? rule.subs.every(one) : rule.subs.some(one);
  };
  const isValidHeatConductor = (i: number) => {
    if (grid[i] === FUEL) return isRunning(cells.get(i)!);
    if (grid[i] === CONDUCTOR) return true;
    const t = grid[i] - COOLER0;
    if (componentFail.has(i)) { sinkValid.set(i, false); return false; }
    if (rules[t].requiresRecheck) { const v = satisfied(i, t); sinkValid.set(i, v); if (v) assumedValid.add(i); return v; }
    if (sinkValid.get(i)) return true;
    const v = satisfied(i, t); sinkValid.set(i, v); return v;
  };
  function clusterSearch(i: number, id: number | null, cache: Map<number, number>) {
    if (grid[i] === FUEL) refreshIsProcessing(cells.get(i)!);
    if (!isValidHeatConductor(i)) return;
    const cur = getCluster(i);
    if (cur !== null) { if (id !== null) mergeClusters(id, cur); return; }
    if (id === null) { id = clusterCount++; clusterWall.set(id, false); }
    setCluster(i, id);
    for (let d = 0; d < 6; d++) {
      const j = nbr(i, d);
      if (!clusterWall.get(getCluster(i)!) && j < 0) { clusterWall.set(getCluster(i)!, true); continue; }
      if (isComponent(j)) cache.set(j, id);
    }
  }
  function iterateClusterSearch(root: number) {
    let cache = new Map<number, number>();
    clusterSearch(root, null, cache);
    while (cache.size) { const sub = new Map<number, number>(); for (const [c, id] of cache) clusterSearch(c, getCluster(id === undefined ? c : c) === null ? id : id, sub); cache = sub; }
  }
  function refreshClusters() {
    // refreshAllFuelComponentModerators
    for (const c of cells.values()) if (isRunning(c)) for (let d = 0; d < 6; d++) {
      const s = c.adjSink[d]; const adj = nbr(c.pos, d);
      if (s >= 0 && isRunning(cells.get(s)!) && adj >= 0 && passive.has(adj)) active.add(adj);
    }
    for (const a of active) passive.delete(a);
    for (const c of cells.values()) iterateClusterSearch(c.pos);
    for (const m of [...active, ...activeRefl]) for (let d = 0; d < 6; d++) { const j = nbr(m, d); if (isComponent(j)) iterateClusterSearch(j); }
    for (const i of assumedValid) if (!sinkValid.get(i)) { componentFail.add(i); refreshFlag = true; }
  }

  do {
    assumedValid = new Set(); clusterCount = 0; clusterWall.clear();
    refreshFlux();
    refreshClusters();
  } while (refreshFlag);

  // ---- stats (wall-connected clusters only)
  const clusterIds = new Set<number>();
  for (const c of cells.values()) if (c.cluster !== null) clusterIds.add(c.cluster);
  for (const v of sinkCluster.values()) if (v !== null) clusterIds.add(v);
  let raw = 0, cooling = 0, eff = 0, base = 0, useful = 0;
  const perCluster: { raw: number; cooling: number; wall: boolean }[] = [];
  for (const id of clusterIds) {
    let r = 0, cool = 0, e = 0, b = 0, count = 0;
    for (const c of cells.values()) if (c.cluster === id && isRunning(c)) {
      count++;
      let n = 0, me = 0; for (let d = 0; d < 6; d++) if (c.lineEff[d] !== null) { n++; me += c.lineFlux[d] === 0 ? 0 : c.lineEff[d]!; }
      const modEff = n ? me / n : 0;
      const fe = (1 + Math.exp(-2 * crit)) / (1 + Math.exp(2 * (c.flux - 2 * crit)));
      r += fuel.heat * c.heatMult; e += fuel.heat * c.heatMult * fuel.efficiency * modEff * fe; b += fuel.heat;
    }
    for (const [k, v] of sinkCluster) if (v === id && sinkValid.get(k)) { count++; cool += COOLING_RATES[grid[k] - COOLER0]; }
    const ocf = cool === 0 ? 1 : Math.min(1, (r + 10) / cool);
    e *= ocf;
    perCluster.push({ raw: r, cooling: cool, wall: !!clusterWall.get(id) });
    if (!clusterWall.get(id)) continue;
    raw += r; cooling += cool; eff += e; base += b; useful += count;
  }
  useful += passive.size + active.size + activeRefl.size;
  const ratio = useful / N;
  const sp = ratio >= 0.75 ? 1 : 0.5 * Math.sin((ratio * Math.PI) / 1.5) + 0.5;
  const running = [...cells.values()].filter(isRunning).map((c) => c.pos).sort((a, b) => a - b);
  const valid = [...sinkValid].filter(([, v]) => v).map(([k]) => k).sort((a, b) => a - b);
  return { raw, cooling, effectiveHeating: eff * sp, useful, running, valid, active: [...active].sort((a, b) => a - b), passive: [...passive].sort((a, b) => a - b), perCluster };
}
