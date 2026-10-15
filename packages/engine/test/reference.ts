/**
 * Deliberately literal port of the solid-fuel refresh control flow from the NuclearCraft source
 * (FissionReactorLogic.refreshReactor/refreshFlux/distributeFlux/refreshClusters, IFissionFuelComponent,
 * IFissionComponent.clusterSearch, TileSolidFissionSink.isValidHeatConductor, TileFissionShield,
 * TileFissionIrradiator). Used only as a test oracle for the fast fixed-point simulator. All fuel cells are
 * treated as primed (no sources); shields are not shielding; irradiators always have inputs.
 */
import { FISSION_CONFIG, FuelDef, MODERATORS, REFLECTORS, SHIELDS, SINK_RULES, COOLING_RATES, IRRADIATOR_RECIPES, IrradiatorRecipeId } from '../src/components.js';
import { FUEL, MOD0, REFL0, CONDUCTOR, COOLER0, SHIELD0, IRRADIATOR, isModerator, isReflector, isCooler, isShield } from '../src/blocks.js';
import { parseRule, adjacentSatisfied, PlacementRule } from '../src/rules.js';
import { DIRS } from '../src/simulator.js';

/** IFissionFuelComponent.ModeratorBlockInfo */
interface Info { pos: number; shield: boolean; validActive: boolean; flux: number; eff: number }
/** IFissionFuelComponent.ModeratorLine */
interface Line { info: Info[]; flux: number; sink: number; reflector: number }
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
class Shield { inComplete = false; flux = 0; axisLine: (Line | null)[] = [null, null, null]; cluster: number | null = null; }
class Irradiator { flux = 0; isProcessing = false; cluster: number | null = null; }

export function referenceSimulate(dims: [number, number, number], grid: Uint8Array, fuel: FuelDef, irradiatorRecipe: IrradiatorRecipeId = 'thorium') {
  const [X, Y, Z] = dims; const N = X * Y * Z;
  const nbr = (i: number, d: number) => {
    const x = i % X, y = Math.floor(i / X) % Y, z = Math.floor(i / (X * Y));
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
    return nx < 0 || ny < 0 || nz < 0 || nx >= X || ny >= Y || nz >= Z ? -1 : nx + X * (ny + Y * nz);
  };
  const irr = IRRADIATOR_RECIPES.find((r) => r.id === irradiatorRecipe)!;
  const rules: PlacementRule[] = SINK_RULES.map((r) => parseRule(r, 'sfr'));
  const cells = new Map<number, Cell>(), shields = new Map<number, Shield>(), irrs = new Map<number, Irradiator>();
  for (let i = 0; i < N; i++) {
    if (grid[i] === FUEL) cells.set(i, new Cell(i));
    else if (isShield(grid[i])) shields.set(i, new Shield());
    else if (grid[i] === IRRADIATOR) irrs.set(i, new Irradiator());
  }
  const sinkValid = new Map<number, boolean>();
  const sinkCluster = new Map<number, number | null>();
  const condCluster = new Map<number, number | null>();
  for (let i = 0; i < N; i++) { if (isCooler(grid[i])) { sinkValid.set(i, false); sinkCluster.set(i, null); } if (grid[i] === CONDUCTOR) condCluster.set(i, null); }
  const isComponent = (i: number) => i >= 0 && (cells.has(i) || isCooler(grid[i]) || grid[i] === CONDUCTOR || shields.has(i) || irrs.has(i));
  let passive = new Set<number>(), active = new Set<number>(), activeRefl = new Set<number>();
  let refreshFlag = false;
  const componentFail = new Set<number>();
  let assumedValid = new Set<number>();
  const crit = fuel.criticality;
  const isRunning = (c: Cell) => c.isProcessing;
  const refreshIsProcessing = (c: Cell) => { c.isProcessing = c.flux >= crit; };
  /** IFissionComponent.isFunctional of a flux sink / line endpoint */
  const sinkFunctional = (i: number) => (cells.has(i) ? isRunning(cells.get(i)!) : irrs.get(i)!.isProcessing);
  const onEndModeratorLine = (i: number) => { if (cells.has(i)) refreshIsProcessing(cells.get(i)!); else { const r = irrs.get(i)!; r.isProcessing = r.flux > 0; } };

  /** IFissionFuelComponent.getModeratorBlockInfo (null if not a moderator / shield) */
  function getInfo(pos: number, validActive: boolean): Info | null {
    const b = grid[pos];
    // FissionReactorLogic.getShieldModeratorBlockInfo: shields never count as active moderators (isShieldActiveModerator = false)
    if (isShield(b)) return { pos, shield: true, validActive: false, flux: 0, eff: SHIELDS[b - SHIELD0].efficiency };
    if (isModerator(b)) return { pos, shield: false, validActive, flux: MODERATORS[b - MOD0].fluxFactor, eff: MODERATORS[b - MOD0].efficiency };
    return null;
  }
  /** IFissionFuelComponent.addToModeratorCache (reactor cache) */
  const addToReactorCache = (line: Line) => line.info.forEach((info) => {
    if (info.shield && !componentFail.has(info.pos)) assumedValid.add(info.pos);
    else (info.validActive ? active : passive).add(info.pos);
  });
  /** IFissionFuelComponent.addToModeratorCache (local cache) */
  const addToLocalCache = (line: Line, d: number, act: Set<number>[], pas: Set<number>[]) => line.info.forEach((info) => {
    if (info.shield && !componentFail.has(info.pos)) assumedValid.add(info.pos);
    else (info.validActive ? act[d] : pas[d]).add(info.pos);
  });
  /** TileFissionShield.getLineFluxContribution */
  function lineFluxContribution(line: Line, self: Info) {
    let inner = 0, outer = 0, isInner = true;
    for (const info of line.info) { if (info === self) isInner = false; if (isInner) inner += info.flux; else outer += info.flux; }
    if (line.sink >= 0) return cells.has(line.sink) ? inner + outer : inner;
    if (line.reflector >= 0) return Math.floor((inner + outer) * (1 + REFLECTORS[grid[line.reflector] - REFL0].reflectivity));
    return inner;
  }
  /** IFissionFuelComponent.onModeratorLineComplete -> TileFissionShield.onModeratorLineComplete */
  function onModeratorLineComplete(line: Line, d: number) {
    for (const info of line.info) {
      if (!info.shield) continue;
      const s = shields.get(info.pos)!;
      s.inComplete = true;
      const axis = d >> 1;
      if (s.axisLine[axis] === null) { s.flux += lineFluxContribution(line, info); s.axisLine[axis] = line; }
    }
  }
  function updateModeratorLine(src: Cell, sink: number, d: number, line: Line) {
    onEndModeratorLine(sink);
    // fuel components support an active moderator at the line end, flux sinks such as irradiators do not
    if (line.info.length && cells.has(sink)) line.info[line.info.length - 1].validActive = true;
    if (isRunning(src) && sinkFunctional(sink)) { onModeratorLineComplete(line, d); addToReactorCache(line); }
    else { src.lineCache[d] = line; addToLocalCache(line, d, src.localActive, src.localPassive); }
    src.adjSink[d] = sink;
  }

  /** IFissionFuelComponent.defaultDistributeFlux */
  function distributeFrom(c: Cell, cache: Set<Cell>) {
    const intrinsic = fuel.intrinsicFlux;
    dirLoop: for (let d = 0; d < 6; d++) {
      let p = nbr(c.pos, d);
      if (intrinsic > 0 && p >= 0) {
        const t = cells.get(p);
        if (t) {
          const line: Line = { info: [], flux: intrinsic, sink: p, reflector: -1 };
          t.flux += line.flux; t.lineFlux[d ^ 1] = line.flux; t.lineEff[d ^ 1] = FISSION_CONFIG.intrinsicFluxEfficiency; t.heatMult++;
          updateModeratorLine(c, p, d, line); cache.add(t);
          continue;
        }
        const r = irrs.get(p);
        if (r) {
          const line: Line = { info: [], flux: intrinsic, sink: p, reflector: -1 };
          r.flux += line.flux; c.lineFlux[d] = line.flux; c.lineEff[d] = irr.efficiency * FISSION_CONFIG.intrinsicFluxEfficiency; c.heatMult++;
          updateModeratorLine(c, p, d, line);
          continue;
        }
      }
      const first = p < 0 || componentFail.has(p) ? null : getInfo(p, true);
      if (!first) continue;
      const line: Line = { info: [first], flux: intrinsic + first.flux, sink: -1, reflector: -1 };
      let eff = first.eff;
      for (let i = 2; i <= FISSION_CONFIG.neutronReach + 1; i++) {
        p = nbr(p, d);
        if (p < 0) continue dirLoop;
        const info = componentFail.has(p) ? null : getInfo(p, false);
        if (info) { line.info.push(info); line.flux += info.flux; eff += info.eff; continue; }
        const t = cells.get(p), r = irrs.get(p);
        if (t) {
          line.sink = p; t.flux += line.flux; t.lineFlux[d ^ 1] = line.flux; t.lineEff[d ^ 1] = eff / (i - 1); t.heatMult++;
          updateModeratorLine(c, p, d, line); cache.add(t);
        } else if (r) {
          line.sink = p; r.flux += line.flux; c.lineFlux[d] = line.flux; c.lineEff[d] = (irr.efficiency * eff) / (i - 1); c.heatMult++;
          updateModeratorLine(c, p, d, line);
        } else if (i - 1 <= Math.floor(FISSION_CONFIG.neutronReach / 2) && isReflector(grid[p])) {
          const rf = REFLECTORS[grid[p] - REFL0];
          line.reflector = p; line.flux = Math.floor(2 * line.flux * rf.reflectivity);
          c.flux += line.flux; c.lineFlux[d] = line.flux; c.lineEff[d] = (rf.efficiency * eff) / (i - 1); c.heatMult++;
          if (isRunning(c)) { onModeratorLineComplete(line, d); addToReactorCache(line); activeRefl.add(p); }
          else { c.lineCache[d] = line; addToLocalCache(line, d, c.reflActive, c.reflPassive); c.activeReflectorCache.add(p); }
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
      for (const s of shields.values()) Object.assign(s, { inComplete: false, flux: 0, axisLine: [null, null, null], cluster: null });
      for (const r of irrs.values()) Object.assign(r, { flux: 0, isProcessing: false, cluster: null });
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
            if (line && (line.reflector >= 0 || (line.sink >= 0 && sinkFunctional(line.sink)))) {
              onModeratorLineComplete(line, d);
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
  const getCluster = (i: number) => (cells.has(i) ? cells.get(i)!.cluster : shields.has(i) ? shields.get(i)!.cluster : irrs.has(i) ? irrs.get(i)!.cluster : isCooler(grid[i]) ? sinkCluster.get(i)! : condCluster.get(i)!);
  const setCluster = (i: number, id: number) => {
    if (cells.has(i)) cells.get(i)!.cluster = id; else if (shields.has(i)) shields.get(i)!.cluster = id; else if (irrs.has(i)) irrs.get(i)!.cluster = id;
    else if (isCooler(grid[i])) sinkCluster.set(i, id); else condCluster.set(i, id);
  };
  const mergeClusters = (a: number, b: number) => {
    if (a === b) return;
    for (const c of [...cells.values(), ...shields.values(), ...irrs.values()]) if (c.cluster === b) c.cluster = a;
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
          else if (s.target === 'shield') ok = shields.has(j) && shields.get(j)!.inComplete;
          else if (s.target === 'irradiator') ok = irrs.has(j) && irrs.get(j)!.isProcessing;
          else if (s.target === 'cooler') ok = isCooler(grid[j]) && sinkValid.get(j)! && (s.coolerType < 0 || grid[j] - COOLER0 === s.coolerType);
        }
        if (ok) mask |= 1 << d;
      }
      return adjacentSatisfied(s, mask);
    };
    return rule.op === 'and' ? rule.subs.every(one) : rule.subs.some(one);
  };
  const isValidHeatConductor = (i: number) => {
    if (cells.has(i)) return isRunning(cells.get(i)!);
    if (shields.has(i)) return shields.get(i)!.inComplete;
    if (irrs.has(i)) return irrs.get(i)!.isProcessing;
    if (grid[i] === CONDUCTOR) return true;
    const t = grid[i] - COOLER0;
    if (componentFail.has(i)) { sinkValid.set(i, false); return false; }
    if (rules[t].requiresRecheck) { const v = satisfied(i, t); sinkValid.set(i, v); if (v) assumedValid.add(i); return v; }
    if (sinkValid.get(i)) return true;
    const v = satisfied(i, t); sinkValid.set(i, v); return v;
  };
  function clusterSearch(i: number, id: number | null, cache: Map<number, number>) {
    if (cells.has(i)) refreshIsProcessing(cells.get(i)!);
    if (irrs.has(i)) { const r = irrs.get(i)!; r.isProcessing = r.flux > 0; }
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
    while (cache.size) { const sub = new Map<number, number>(); for (const [c, id] of cache) clusterSearch(c, id, sub); cache = sub; }
  }
  const isFunctionalComponent = (i: number) => (cells.has(i) ? isRunning(cells.get(i)!) : shields.has(i) ? shields.get(i)!.inComplete : irrs.has(i) ? irrs.get(i)!.isProcessing : isCooler(grid[i]) && !!sinkValid.get(i));
  function refreshClusters() {
    // refreshAllFuelComponentModerators -> defaultRefreshAdjacentActiveModerators
    for (const c of cells.values()) if (isRunning(c)) for (let d = 0; d < 6; d++) {
      const s = c.adjSink[d]; const adj = nbr(c.pos, d);
      if (s >= 0 && sinkFunctional(s) && adj >= 0 && passive.has(adj)) active.add(adj);
    }
    for (const a of active) passive.delete(a);
    // cluster roots: fuel cells, shields, irradiators (isClusterRoot)
    for (let i = 0; i < N; i++) if (cells.has(i) || shields.has(i) || irrs.has(i)) iterateClusterSearch(i);
    for (const m of [...active, ...activeRefl]) for (let d = 0; d < 6; d++) { const j = nbr(m, d); if (isComponent(j)) iterateClusterSearch(j); }
    for (const i of assumedValid) if (!isFunctionalComponent(i)) { componentFail.add(i); refreshFlag = true; }
  }

  do {
    assumedValid = new Set(); clusterCount = 0; clusterWall.clear();
    refreshFlux();
    refreshClusters();
  } while (refreshFlag);

  // ---- stats (wall-connected clusters only)
  const clusterIds = new Set<number>();
  for (const c of [...cells.values(), ...shields.values(), ...irrs.values()]) if (c.cluster !== null) clusterIds.add(c.cluster);
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
    for (const [k, s] of shields) if (s.cluster === id && s.inComplete) {
      const sh = SHIELDS[grid[k] - SHIELD0];
      count++; r += Math.floor(s.flux * sh.heatPerFlux); e += s.flux * sh.heatPerFlux * sh.efficiency;
    }
    for (const s of irrs.values()) if (s.cluster === id && s.isProcessing) { count++; r += Math.floor(s.flux * irr.heatPerFlux); e += s.flux * irr.heatPerFlux * irr.efficiency; }
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
  const shieldFlux = [...shields].filter(([, s]) => s.inComplete).map(([k, s]) => [k, s.flux]).sort((a, b) => a[0] - b[0]);
  const irradiatorFlux = [...irrs].filter(([, s]) => s.isProcessing).map(([k, s]) => [k, s.flux]).sort((a, b) => a[0] - b[0]);
  return {
    raw, cooling, effectiveHeating: eff * sp, useful, running, valid,
    active: [...active].sort((a, b) => a - b), passive: [...passive].sort((a, b) => a - b), perCluster, shieldFlux, irradiatorFlux,
  };
}
