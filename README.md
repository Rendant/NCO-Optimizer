# NC:O Fission Optimizer

A web app that designs and analyses **NuclearCraft: Overhauled** (1.12.2, `1.12.2o` branch) fission reactors:
solid-fuel reactors (SFR, heat sinks → high-pressure steam) and molten-salt reactors (MSR, coolant heaters → hot NaK).

* **Engine** (`packages/engine`) — a pure TypeScript, dependency-free simulator + optimizer, ported from the mod's Java source and unit-tested on its own.
* **Server** (`apps/server`) — Fastify API; every optimization job fans out to N `worker_threads` (independent seeds) and streams progress over SSE.
* **Web** (`apps/web`) — React + Vite + three.js (react-three-fiber) UI: configuration, live progress, 3D view, 2D layer view, stats, “why” insights, per-block inspector, layout editor and comparison table.

```
npm install
npm test          # engine tests (incl. fuzz test against a literal port of the Java control flow)
npm start         # builds web + server, serves everything on http://localhost:8787
# development: npm run dev:server  (API on :8787)  +  npm run dev:web  (Vite on :5173, proxies /api)
```
Requires Node 20+.

## Using it

1. Pick **reactor type**, **interior size** (1–24 per axis, casing excluded), **fuel** (all 81 SFR oxide/nitride/zirconium-alloy and 27 MSR fluoride fuels), SFR heating fluid, neutron source type.
2. Pick the **objective**: *output* (effective heat), *efficiency*, *balanced* (output × efficiency) or *breeding* (maximum fuel consumption rate, fuel/h — the most running, fully cooled fuel components in producing clusters; in NC:O every running component consumes fuel at the same base rate regardless of heat multiplier, so this is a fuel-count objective with effective heat as tie-breaker; useful for breeding isotopes or processing fuel fast), optional constraints *max fuel components* and *min efficiency*.
3. Choose allowed **moderators / reflectors / conductors / heat sinks or heaters** (“no rare” drops the hard-to-get ones), symmetry (X/Y/Z mirror – much faster and usually as good), time limit and worker count.
4. **Optimize**. The live best layout updates while the search runs; when it finishes each worker's best layout is added to the **Compare** table (best stable value per column highlighted, deltas relative to the selected layout).
5. Inspect: 3D view (orbit, axis cut-away, hide inactive / moderators) or **Layers** view (every block, Y = vertical, north at top). Colour by *block type, active/inactive, cluster, fuel efficiency, neutron flux*. Click any block for the **inspector**: flux vs. criticality, heat multiplier, every moderator line (length, flux, efficiency, partner), efficiency factors, or the cooler's placement rule with each condition ✓/✗.
6. **Stats & insights** lists effective heat, RF/t (ideal turbine) and steam, MSR hot-coolant per type, raw heat vs cooling and margin, efficiency, heat multiplier, sparsity penalty, fuel use, per-cluster and per-cooler breakdowns, a minimal **neutron-source plan** (magenta) and plain-language explanations of what drives or limits the design.
7. Edit (Layers → *edit*; left click paints, right click erases) to try changes — results re-simulate instantly. **Improve** (*Improve selected* in the config panel, or the *Improve* button in any Compare / Library row) runs the optimizer with every search starting from that layout at a lower temperature, so you can keep polishing a good design (current objective, components and time limit apply). Layouts persist in localStorage and export/import as JSON.
8. **Search progress** chart (left panel) shows each worker's best stable H/t over time, live and after the run.
9. **Library** (left panel): the server keeps the 10 best stable layouts per *reactor · size · fuel · heating fluid · objective* (`apps/server/data/library.json`, override with `NCOPT_LIBRARY`). Finished runs are saved automatically; new runs use up to 4 compatible entries (only allowed blocks) as extra seeds. *Open* loads an entry into the viewer, *Improve* continues optimizing it, × deletes it. Toggle with *Use result library*.
10. *Share best layouts between workers*: worker threads publish their best layout to a shared buffer; at stage boundaries a worker that is behind adopts the leader's layout as a racing candidate (off = fully independent searches, more diversity).

## Mechanics implemented (from source, default config)

The FTB wiki describes the pre-Overhauled mechanics, so the simulation follows the Overhauled Java source
(`FissionReactorLogic`, `SolidFuelFissionLogic`, `MoltenSaltFissionLogic`, `IFissionFuelComponent.defaultDistributeFlux`, `TileSolidFissionCell`, `TileSaltFissionVessel`, `FissionFuelBunch`, `FissionPlacement`, `PlacementRule`, `TileSolidFissionSink`, `TileFissionSource`, `NCConfig` defaults):

* **Neutron flux**: from each fuel component, straight lines of 1–`fission_neutron_reach` (4) moderators; a line ending at another fuel component gives it Σ moderator flux factors and +1 heat multiplier; a line of ≤ 2 moderators ending at a reflector reflects `floor(2·flux·reflectivity)` back. Line efficiency = mean moderator efficiency (× reflector efficiency).
* **Criticality**: iterated to a fixed point exactly like the mod (components that fail to reach criticality are reset and the search restarts). Efficiency = heat-mult × fuel eff × source eff × mean line efficiency × flux factor `(1+e^(-2c))/(1+e^(2(flux−2c)))`.
* **Moderators**: active (adjacent to a fuel component at the end of a complete line) vs passive; only active ones satisfy “moderator” rules.
* **Heat sinks / heaters**: all 32 default placement rules parsed (at least / exactly / at most, axial, casing, vertex/edge), with the mod's exact/at-most re-check pass; the cooling rates are the defaults.
* **Clusters**: connected running fuel / valid coolers / conductors; casing connection; overcooling efficiency factor `min(1, (heat+10)/cooling)`; heat must be ≤ cooling in **every** cluster for the design to count as stable. SFR only uses wall-connected clusters.
* **Sparsity penalty**: 0.5 multiplier curve below 75 % functional interior.
* **MSR**: vessel bunches (surface factor, bunching factor, bunch criticality), heater heating speed = cluster efficiency × sparsity × (heat/cooling if overcooled); hot coolant = speed × rate / 128 mB/t.
* **SFR output**: water 64 H/mB (preheated 32) → 4 mB high-pressure steam, 16 RF/mB in an ideal turbine. Fuel use from fuel time and the undercooling lifetime factor.
* **Neutron sources**: casing ray to the first fuel component, blocked by reflectors with reflectivity ≥ 1; MSR bunches need ≥ surface-factor sources. A greedy planner places a minimal set and re-simulates with source efficiency.

**Assumptions / limitations**: default mod config; the optimizer treats every fuel component as primed (the source plan then shows what's needed and the source-efficiency-adjusted result); neutron shields, irradiators and TRISO / decay-heat mechanics are not modelled; the “ideal RF/t” stat is 16 RF/mB; the Turbine tab gives the real figure for an optimised turbine.

## Turbine designer

The **Turbine** tab designs the best NC:O steam turbine(s) for the selected reactor (`packages/engine/src/turbine.ts`, ported from `TurbineLogic`, `Turbine`, `TurbinePlacement`, `TurbineRotorBladeUtil`, `TurbineDynamoCoilType`, `TileTurbineDynamoPart`):

* Input: the reactor's high-pressure steam (SFR directly; MSR hot coolant through an ideal heat exchanger: 128 H/mB × 2 → water 64 H/mB → 4 mB HP steam). The value can be overridden.
* Steady-state power = steam × 16 RF/mB × dynamo conductivity × rotor efficiency × total-expansion ideality × throughput efficiency × power bonus — every factor exactly as in `TurbineLogic.onUpdateServer` (expansion levels `∏k·√k`, ideal `4^((d+½)/L)`, effective min/max length, leniency, bearing-tension limit 105 % of 100 mB/t per blade).
* Rotor: an exact dynamic programme over all blade/stator sequences (state = blade counts per type), for every length 1–24; then every diameter / shaft width is scored.
* Dynamo walls: coil validity is the fixed point of the coil rules (Mg next to a bearing or connector, Be next to Mg, Al next to two Mg, Au next to Al, Cu next to Be, Ag next to Au and Cu, connectors next to any coil); conductivity = Σ / max(shaft², coils), optimised by simulated annealing per candidate geometry.
* Output: power, RF/mB, exterior size, every efficiency factor explained, rotor layer strip with ideal vs. actual expansion, the coil wall, a parts list and size/power alternatives. Very large steam flows are split across several identical turbines.
* Assumptions: a single turbine type per design (both end walls identical), inlet/outlet placed in a wall corner, ideal heat exchanger for MSR, steady state (spin-up only affects how fast full power is reached).

## Optimizer

Simulated annealing over symmetry orbits with the exact simulator as the fitness function:
constructive lattice seeds (every allowed moderator × spacing 2–5) + random seeds; (optionally library layouts); racing annealing chains (below); moves = random block, rule-aware “smart” cooler choice, straight fuel–moderator–fuel/reflector line insertion, swaps and neighbour swaps; infeasibility (overheating / constraint violation) is penalised with a growing weight and a criticality-progress shaping term guides early search; then a greedy single-orbit polish and a cleanup that turns useless blocks into air.

* **Compound structural moves**: every proposal that touches fuel, moderators or reflectors is followed by a greedy cooler repair (air / invalid coolers → the best cooler whose rule is satisfied, until the excess heat is covered; whole layout for ≤ 40 orbits, otherwise the 2-block neighbourhood of the change) and accepted or rejected together.
* **Incremental evaluation**: flux, criticality and moderator/reflector activity depend only on fuel, moderator and reflector positions, so the simulator caches that phase in two slots (current layout + last proposal) and re-runs only the cooler/cluster/stat phase for cooler-only changes. Placement rules are compiled into 64-entry truth tables over the 6-face neighbour mask, static rules are decided once, clusters use flat arrays. A randomized test checks incremental results against a fresh simulator (SFR and MSR).
* **Racing (successive halving)**: 16 annealing chains start from the best-ranked seeds; after each stage the worse half is dropped and the survivors continue (16 → 8 → 4 → 2 → 1, equal time per stage, re-heated to max(0.3, 0.6^stage) of the start temperature). This replaced the fixed 8-chain portfolio and was the largest single gain this round.
* **Bilevel cooler optimization**: after each structural move the coolers are repaired (see above); in the final polish phase each candidate also gets 8 greedy inner cooler moves before it is judged (`INNER_POLISH`), i.e. the outer search judges a structure by (approximately) its best cooler assignment. Running the inner loop on every annealing step (`INNER`) and the heat-balancing move (`BAL_STEPS`: downgrade coolers in overcooled clusters to the cheapest valid type that still covers the heat) are implemented but off by default — they slowed the search more than they helped on the benchmark.
* **Exhaustive neighbourhood polish**: the last 20 % of the time alternates a greedy single-orbit pass with a *compound* pass that tries every orbit × every structural block (fuel / moderators / reflectors / air) followed by cooler re-optimization, taking first improvements, up to 4 rounds. (Full enumeration is infeasible even for symmetric 5³ — 27 orbits × 30+ block types ≈ 10⁴⁰ layouts — so exhaustiveness is limited to this 1-structural-change neighbourhood.)
* **Incremental cooler solve**: placement-rule dependencies between cooler types are precomputed; after a change only the cells whose neighbourhood changed (or whose neutronic state changed) and the coolers that transitively depend on them are re-solved, falling back to a full solve for large changes. **Incremental neutronics**: when ≤ 5 neutronic cells change, only fuel components whose moderator lines cross them are re-traced. Both are checked against a fresh simulator by randomized tests.
* Elite pools, iterated local search with kicks and slab crossover between elites were tried and gave no measurable gain on the benchmark, so they are not used; the old “restart from the best after 20k stagnant steps” was removed because it collapsed the portfolio on long runs.

Benchmark (`packages/engine/test/bench.ts`, 2-core sandbox, single worker, same seeds; original version → previous round → current):

| case | time × seeds | mean H/t | evals/s |
|---|---|---|---|
| SFR 5³ LEU-235 Oxide, xyz-sym | 4 s × 24 | 6370 → 6693 → **6912** (+9 %) | 38k → 57k |
| SFR 7³ LEU-235 Oxide, no sym | 8 s × 8 | 11581 → 13706 → **14322** (+24 %) | 16k → 34k |
| SFR 7³ LEU-235 Oxide, xyz-sym | 8 s × 8 | 17072 → 19360 → **19142** (+12 %) | 13k → 22k |
| SFR 5³ TBU Oxide, xyz-sym | 8 s × 16 | 1888 → 2116 → **2332** (+24 %) | 49k → 65k |
| MSR 5³ HEU-235 Fluoride, xyz-sym | 8 s × 8 | 20114 → 24523 → **24998** (+24 %) | 32k → 41k |

Worker exchange (API, SFR 7³ no sym, 2 workers × 6 s, 4 runs each): 13218 independent → 14121 with *share best layouts* (+7 %).

Results are stochastic; run a few times / with more workers and compare.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/meta` | fuels, components, rules, sources, worker count |
| POST | `/api/simulate` | `{reactor, dims, fuelId, sfrCoolant?, grid, sourceType?}` → stats, per-block explanation, source plan, layout JSON |
| POST | `/api/turbine` | `{steamRate, allowedBlades?, allowStators?, allowedCoils?, maxDiameter?, maxLength?, turbines?}` → best turbine + alternatives |
| POST | `/api/optimize` | config (see `apps/server/src/validate.ts`) → `{jobId}` |
| GET | `/api/jobs/:id` | snapshot incl. results |
| GET | `/api/jobs/:id/events` | SSE `progress` / `done` |
| POST | `/api/jobs/:id/cancel` | stop early (keeps best results) |
| POST | `/api/library/query` | optimize-shaped config → `{key, entries}` (best first, `compatible` flag) |
| GET | `/api/library` | all library entries |
| DELETE | `/api/library/:id` | remove an entry |

`/api/optimize` also accepts `initial` (grid to improve), `cooperate` (default true) and `useLibrary` (default true); job snapshots include per-worker `history` (`[ms, best stable H/t, valid]`), `librarySeeds` and `libraryAdded`.

Grid encoding: `index = x + X·(y + Y·z)`, Y vertical; block ids in `packages/engine/src/blocks.ts`.

## Layout

```
packages/engine/src   components.ts (config data) · blocks.ts · rules.ts · simulator.ts · analysis.ts · optimizer.ts · turbine.ts · layout.ts
packages/engine/test  simulator.test.ts · reference.ts (literal Java port oracle) · bench.ts (CASE=sfr5s|sfr7|sfr7s|tbu5s|msr5s) · simbench.ts · harness.ts
apps/server/src       index.ts (routes) · jobs.ts (worker pool) · worker.ts · validate.ts · library.ts (result library) · exchange.ts (shared best-layout buffer)
apps/web/src          App.tsx · components/{ConfigPanel,Viewer3D,LayerGrid,StatsPanel,Inspector,Compare,TurbinePanel,ProgressChart,LibraryPanel}.tsx
```
