import { useMemo } from 'react';
import type { Meta, OptimizeRequest } from '../api';
import { blockColor } from '../blocks';
import { COOLER0, MAX_FUELS, CONDUCTOR, MOD0, REFL0, fuelBlock, type ReactorType } from '@ncopt/engine';

export interface Config extends OptimizeRequest { sourceType: string }

interface Props {
  meta: Meta; cfg: Config; setCfg: (c: Config) => void; running: boolean;
  onStart: (fromCurrent: boolean) => void; onCancel: () => void; canSeedFromCurrent: boolean;
}

const OBJ_HELP = {
  output: 'Maximize effective heat (H/t)',
  efficiency: 'Maximize mean fuel efficiency',
  balanced: 'Maximize effective heat × efficiency',
  breeding: 'Maximize fuel consumption rate (fuel/h): as many running, fully cooled fuel components as possible — for breeding / processing fuel fast. Effective heat breaks ties.',
  irradiation: 'Maximize the neutron flux into irradiators (items processed per hour). Effective heat breaks ties.',
} as const;
const OBJ_LABEL = { output: 'Output', efficiency: 'Efficiency', balanced: 'Balanced', breeding: 'Breeding', irradiation: 'Irradiation' } as const;
const REACTORS: { id: ReactorType; label: string }[] = [{ id: 'sfr', label: 'Solid fuel' }, { id: 'msr', label: 'Molten salt' }, { id: 'pbr', label: 'Pebble bed' }];
const COOLER_TITLE: Record<ReactorType, string> = { sfr: 'Heat sinks', msr: 'Coolant heaters', pbr: 'Gas coolers' };
const FUEL_PLURAL: Record<ReactorType, string> = { sfr: 'cells', msr: 'vessels', pbr: 'chambers' };

const RECOMMENDED_SINKS = ['water', 'iron', 'redstone', 'quartz', 'obsidian', 'glowstone', 'lapis', 'gold', 'prismarine', 'end_stone', 'diamond', 'emerald', 'copper', 'tin', 'lead', 'boron', 'magnesium', 'aluminum', 'silver', 'fluorite', 'lithium', 'manganese'];

export default function ConfigPanel({ meta, cfg, setCfg, running, onStart, onCancel, canSeedFromCurrent }: Props) {
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg({ ...cfg, [k]: v });
  const fuels = useMemo(() => meta.fuels.filter((f) => f.reactor === cfg.reactor), [meta, cfg.reactor]);
  const isotopes = useMemo(() => [...new Set(fuels.map((f) => f.isotope))], [fuels]);
  const coolersOf = (r: ReactorType) => (r === 'sfr' ? meta.sinks : r === 'msr' ? meta.heaters : meta.gasCoolers);
  const coolers = coolersOf(cfg.reactor);
  const fuel = meta.fuels.find((f) => f.id === cfg.fuelId);
  // multi-fuel: extra candidate fuels after the primary one (cfg.fuelIds = [primary, ...extra] when non-empty)
  const extra = (cfg.fuelIds ?? []).filter((id) => id !== cfg.fuelId);
  const setFuels = (primary: string, ex: string[]) => {
    const list = ex.filter((id, k) => id !== primary && ex.indexOf(id) === k);
    setCfg({ ...cfg, fuelId: primary, fuelIds: list.length ? [primary, ...list] : undefined });
  };
  const fuelOptions = (exclude: string[]) => isotopes.map((iso) => (
    <optgroup key={iso} label={iso}>
      {fuels.filter((f) => f.isotope === iso && !exclude.includes(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </optgroup>
  ));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const switchReactor = (reactor: ReactorType) => {
    const f = meta.fuels.find((x) => x.reactor === reactor && x.isotope === (fuel?.isotope ?? 'LEU-235')) ?? meta.fuels.find((x) => x.reactor === reactor)!;
    setCfg({ ...cfg, reactor, fuelId: f.id, fuelIds: undefined, requireAllFuels: false, allowedCoolers: coolersOf(reactor).map((c) => c.id) });
  };
  const recipe = meta.irradiator.recipes.find((r) => r.id === cfg.irradiatorRecipe) ?? meta.irradiator.recipes[0];

  return (
    <div className="panel config">
      <h2>Reactor</h2>
      <div className="seg">
        {REACTORS.map((r) => (
          <button key={r.id} className={cfg.reactor === r.id ? 'on' : ''} onClick={() => switchReactor(r.id)} disabled={running} title={`${r.label} (${r.id.toUpperCase()})`}>{r.label}</button>
        ))}
      </div>
      <label className="row">Interior size (X × Y × Z)</label>
      <div className="dims">
        {[0, 1, 2].map((k) => (
          <input key={k} type="number" min={1} max={24} value={cfg.dims[k]} disabled={running}
            onChange={(e) => { const d = [...cfg.dims] as [number, number, number]; d[k] = Math.max(1, Math.min(24, Number(e.target.value) || 1)); set('dims', d); }} />
        ))}
      </div>
      <label className="row">Fuel
        <select value={cfg.fuelId} onChange={(e) => setFuels(e.target.value, extra)} disabled={running}>
          {fuelOptions([])}
        </select>
      </label>
      {extra.length > 0 && (
        <div className="fuellist">
          {[cfg.fuelId, ...extra].map((id, k) => {
            const f = meta.fuels.find((x) => x.id === id)!;
            return (
              <div key={id} className="fuelrow">
                <i style={{ background: blockColor(fuelBlock(k)) }} />
                <span className="fn">{f.name}</span>
                <small>{f.heat} H/t · {Math.round(f.efficiency * 100)}% · crit {f.criticality}{f.intrinsicFlux ? ` · intrinsic ${f.intrinsicFlux}` : ''}{f.selfPriming ? ' · self-priming' : ''}</small>
                {k > 0 && <button className="x" disabled={running} title="Remove this fuel" onClick={() => setFuels(cfg.fuelId, extra.filter((x) => x !== id))}>×</button>}
              </div>
            );
          })}
        </div>
      )}
      {extra.length + 1 < MAX_FUELS && (
        <label className="row">{extra.length ? 'Add another fuel' : 'Additional fuels (optimizer picks which goes where)'}
          <select value="" onChange={(e) => e.target.value && setFuels(cfg.fuelId, [...extra, e.target.value])} disabled={running}>
            <option value="">+ add fuel…</option>
            {fuelOptions([cfg.fuelId, ...extra])}
          </select>
        </label>
      )}
      {extra.length > 0 && (
        <div className="opts">
          <label title="Otherwise the optimizer may leave out fuels that do not help the objective"><input type="checkbox" checked={!!cfg.requireAllFuels} disabled={running} onChange={() => set('requireAllFuels', !cfg.requireAllFuels)} />Use every listed fuel</label>
        </div>
      )}
      {fuel && extra.length === 0 && (
        <div className="fuelinfo">
          <span>Heat <b>{fuel.heat}</b> H/t</span><span>Eff <b>{Math.round(fuel.efficiency * 100)}%</b></span>
          <span>Crit <b>{fuel.criticality}</b></span><span>Time <b>{fuel.time}</b> t</span>
          {fuel.intrinsicFlux > 0 && <span title="Flux given to every face-adjacent fuel component / irradiator, and added to its moderator lines">Intrinsic <b>{fuel.intrinsicFlux}</b></span>}
          {fuel.selfPriming && <span className="tag">self-priming</span>}
        </div>
      )}
      {cfg.reactor === 'sfr' && (
        <label className="row">Heating fluid
          <select value={cfg.sfrCoolant} onChange={(e) => set('sfrCoolant', e.target.value)} disabled={running}>
            {meta.sfrCoolants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <label className="row">Neutron source (for priming plan)
        <select value={cfg.sourceType} onChange={(e) => set('sourceType', e.target.value)}>
          {meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name} ({Math.round(s.efficiency * 100)}%)</option>)}
        </select>
      </label>

      <h2>Objective</h2>
      <div className="seg five">
        {(['output', 'efficiency', 'balanced', 'breeding', 'irradiation'] as const).map((o) => (
          <button key={o} className={cfg.objective === o ? 'on' : ''} onClick={() => setCfg({ ...cfg, objective: o, ...(o === 'irradiation' ? { allowIrradiators: true } : {}) })} disabled={running} title={OBJ_HELP[o]}>
            {OBJ_LABEL[o]}
          </button>
        ))}
      </div>
      <div className="grid2">
        <label>Max fuel {FUEL_PLURAL[cfg.reactor]}<input type="number" min={1} placeholder="no limit" value={cfg.maxFuel ?? ''} disabled={running} onChange={(e) => set('maxFuel', e.target.value === '' ? '' : Number(e.target.value))} /></label>
        <label>Min efficiency %<input type="number" min={0} placeholder="none" value={cfg.minEfficiency === '' || cfg.minEfficiency == null ? '' : Math.round(Number(cfg.minEfficiency) * 100)} disabled={running} onChange={(e) => set('minEfficiency', e.target.value === '' ? '' : Number(e.target.value) / 100)} /></label>
        {cfg.allowIrradiators && cfg.objective !== 'irradiation' && (
          <label title="Total neutron flux the irradiators must receive">Min irradiator flux<input type="number" min={1} placeholder="none" value={cfg.minIrradiatorFlux ?? ''} disabled={running} onChange={(e) => set('minIrradiatorFlux', e.target.value === '' ? '' : Number(e.target.value))} /></label>
        )}
      </div>
      <div className="opts">
        <label title={cfg.allowedShields.length ? 'Switching the shield manager on must stop every fuel component (checked by re-simulating with all shields shielding)' : 'Allow at least one neutron shield below'}>
          <input type="checkbox" checked={cfg.controllable} disabled={running || !cfg.allowedShields.length} onChange={() => set('controllable', !cfg.controllable)} />Controllable: shields can shut it down
        </label>
        <label title="fission_decay_mechanics config (off by default in NuclearCraft): criticality includes neutron poison; the stats show decay heat and the restart window after a shutdown">
          <input type="checkbox" checked={cfg.decayMechanics} disabled={running} onChange={() => set('decayMechanics', !cfg.decayMechanics)} />Decay heat &amp; poisoning (fission_decay_mechanics)
        </label>
      </div>

      <h2>Components</h2>
      <div className="chips">
        {meta.moderators.map((m) => (
          <label key={m.id} className={`chip ${cfg.allowedModerators.includes(m.id) ? 'on' : ''}`} title={`flux ×${m.fluxFactor}, efficiency ${m.efficiency}`}>
            <input type="checkbox" checked={cfg.allowedModerators.includes(m.id)} disabled={running} onChange={() => set('allowedModerators', toggle(cfg.allowedModerators, m.id))} />
            <i style={{ background: blockColor(MOD0 + meta.moderators.indexOf(m)) }} />{m.name.replace(' Block', '').replace(' Moderator', '')} <small>{m.fluxFactor}</small>
          </label>
        ))}
        {meta.reflectors.map((r, k) => (
          <label key={r.id} className={`chip ${cfg.allowedReflectors.includes(r.id) ? 'on' : ''}`} title={`reflectivity ${r.reflectivity}, efficiency ${r.efficiency}`}>
            <input type="checkbox" checked={cfg.allowedReflectors.includes(r.id)} disabled={running} onChange={() => set('allowedReflectors', toggle(cfg.allowedReflectors, r.id))} />
            <i style={{ background: blockColor(REFL0 + k) }} />{r.name.replace(' Reflector', '')}
          </label>
        ))}
        <label className={`chip ${cfg.allowConductors ? 'on' : ''}`} title="Conductors join clusters to the casing">
          <input type="checkbox" checked={cfg.allowConductors} disabled={running} onChange={() => set('allowConductors', !cfg.allowConductors)} />
          <i style={{ background: blockColor(CONDUCTOR) }} />Conductor
        </label>
        {meta.shields.map((sh) => (
          <label key={sh.id} className={`chip ${cfg.allowedShields.includes(sh.id) ? 'on' : ''}`} title={`Neutron shield: passes flux like a moderator with flux factor 0 (efficiency ${sh.efficiency}), turns ${sh.heatPerFlux} H/t per flux into heat; switched on, it blocks its lines`}>
            <input type="checkbox" checked={cfg.allowedShields.includes(sh.id)} disabled={running}
              onChange={() => { const next = toggle(cfg.allowedShields, sh.id); setCfg({ ...cfg, allowedShields: next, controllable: cfg.controllable && next.length > 0 }); }} />
            <i style={{ background: blockColor(sh.block) }} />{sh.name.replace(' Neutron Shield', '')} shield
          </label>
        ))}
        <label className={`chip ${cfg.allowIrradiators ? 'on' : ''}`} title="Neutron irradiator: takes the flux of moderator lines ending at it; each line adds a heat multiplier to its fuel component">
          <input type="checkbox" checked={cfg.allowIrradiators} disabled={running || cfg.objective === 'irradiation'} onChange={() => set('allowIrradiators', !cfg.allowIrradiators)} />
          <i style={{ background: blockColor(meta.irradiator.block) }} />Irradiator
        </label>
      </div>
      {cfg.allowIrradiators && (
        <label className="row">Irradiator recipe
          <select value={cfg.irradiatorRecipe} disabled={running} onChange={(e) => set('irradiatorRecipe', e.target.value as Config['irradiatorRecipe'])}>
            {meta.irradiator.recipes.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.fluxPerItem.toLocaleString('en-US')} flux/item · eff {r.efficiency}</option>)}
          </select>
        </label>
      )}
      {cfg.allowIrradiators && recipe.efficiency === 0 && <p className="muted small">With this recipe every irradiator line counts with efficiency 0 in its fuel component's mean line efficiency.</p>}
      <div className="coolhead">
        <span>{COOLER_TITLE[cfg.reactor]} ({cfg.allowedCoolers.length}/{coolers.length})</span>
        <span className="links">
          <a onClick={() => !running && set('allowedCoolers', coolers.map((c) => c.id))}>all</a>
          {cfg.reactor !== 'pbr' && <a onClick={() => !running && set('allowedCoolers', coolers.filter((c) => RECOMMENDED_SINKS.includes(c.id === 'standard' ? 'water' : c.id)).map((c) => c.id))}>no rare</a>}
          <a onClick={() => !running && set('allowedCoolers', [coolers[0].id])}>none</a>
        </span>
      </div>
      <div className="coolers">
        {coolers.map((c) => (
          <label key={c.id} className={`cooler ${cfg.allowedCoolers.includes(c.id) ? 'on' : ''}`} title={`${c.rule}${c.coolant ? ` · coolant: ${c.coolant}` : ''}`}>
            <input type="checkbox" checked={cfg.allowedCoolers.includes(c.id)} disabled={running} onChange={() => set('allowedCoolers', toggle(cfg.allowedCoolers, c.id))} />
            <i style={{ background: blockColor(COOLER0 + coolers.indexOf(c), cfg.reactor) }} />
            <span className="cn">{c.id.replace(/_/g, ' ')}</span><span className="cr">{c.cooling}</span>
          </label>
        ))}
      </div>

      <h2>Search</h2>
      <div className="grid2">
        <label>Time limit (s)<input type="number" min={1} max={600} value={cfg.timeLimitSec} disabled={running} onChange={(e) => set('timeLimitSec', Number(e.target.value) || 1)} /></label>
        <label>Workers (≤{meta.maxWorkers})<input type="number" min={1} max={meta.maxWorkers} value={cfg.workers} disabled={running} onChange={(e) => set('workers', Math.max(1, Math.min(meta.maxWorkers, Number(e.target.value) || 1)))} /></label>
        <label>Seed<input type="number" placeholder="random" value={cfg.seed ?? ''} disabled={running} onChange={(e) => set('seed', e.target.value === '' ? '' : Number(e.target.value))} /></label>
        <label>Symmetry
          <div className="sym">
            {(['x', 'y', 'z'] as const).map((a) => (
              <label key={a}><input type="checkbox" checked={cfg.symmetry[a]} disabled={running} onChange={() => set('symmetry', { ...cfg.symmetry, [a]: !cfg.symmetry[a] })} />{a.toUpperCase()}</label>
            ))}
          </div>
        </label>
      </div>
      <div className="opts">
        <label title="Worker threads periodically exchange their best layouts; lagging searches restart from the leader"><input type="checkbox" checked={cfg.cooperate !== false} disabled={running} onChange={() => set('cooperate', cfg.cooperate === false)} />Share best layouts between workers</label>
        <label title="Start some searches from the best saved layouts for this size / fuel / objective, and save new results to the library"><input type="checkbox" checked={cfg.useLibrary !== false} disabled={running} onChange={() => set('useLibrary', cfg.useLibrary === false)} />Use result library (seed &amp; save)</label>
      </div>
      {running ? (
        <button className="primary danger" onClick={onCancel}>Stop</button>
      ) : (
        <div className="actions">
          <button className="primary" onClick={() => onStart(false)}>Optimize</button>
          <button onClick={() => onStart(true)} disabled={!canSeedFromCurrent} title="Continue optimizing the selected layout: all searches start from it at a low temperature">Improve selected</button>
        </div>
      )}
    </div>
  );
}
