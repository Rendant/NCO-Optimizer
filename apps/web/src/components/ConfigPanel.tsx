import { useMemo } from 'react';
import type { Meta, OptimizeRequest } from '../api';
import { blockColor } from '../blocks';
import { COOLER0, MAX_FUELS, fuelBlock } from '@ncopt/engine';

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
} as const;

const RECOMMENDED_SINKS = ['water', 'iron', 'redstone', 'quartz', 'obsidian', 'glowstone', 'lapis', 'gold', 'prismarine', 'end_stone', 'diamond', 'emerald', 'copper', 'tin', 'lead', 'boron', 'magnesium', 'aluminum', 'silver', 'fluorite', 'lithium', 'manganese'];

export default function ConfigPanel({ meta, cfg, setCfg, running, onStart, onCancel, canSeedFromCurrent }: Props) {
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg({ ...cfg, [k]: v });
  const fuels = useMemo(() => meta.fuels.filter((f) => f.reactor === cfg.reactor), [meta, cfg.reactor]);
  const isotopes = useMemo(() => [...new Set(fuels.map((f) => f.isotope))], [fuels]);
  const coolers = cfg.reactor === 'sfr' ? meta.sinks : meta.heaters;
  const fuel = meta.fuels.find((f) => f.id === cfg.fuelId);
  // multi-fuel: extra candidate fuels after the primary one (cfg.fuelIds = [primary, ...extra] when non-empty)
  const extra = (cfg.fuelIds ?? []).filter((id) => id !== cfg.fuelId);
  const setFuels = (primary: string, ex: string[]) => {
    const list = ex.filter((id, k) => id !== primary && ex.indexOf(id) === k);
    setCfg({ ...cfg, fuelId: primary, fuelIds: list.length ? [primary, ...list] : undefined });
  };
  const usable = fuels.filter((f) => f.intrinsicFlux === 0);
  const fuelOptions = (exclude: string[]) => isotopes.map((iso) => (
    <optgroup key={iso} label={iso}>
      {usable.filter((f) => f.isotope === iso && !exclude.includes(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </optgroup>
  ));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const switchReactor = (reactor: 'sfr' | 'msr') => {
    const f = meta.fuels.find((x) => x.reactor === reactor && x.isotope === (fuel?.isotope ?? 'LEU-235')) ?? meta.fuels.find((x) => x.reactor === reactor)!;
    const ids = (reactor === 'sfr' ? meta.sinks : meta.heaters).map((c) => c.id);
    setCfg({ ...cfg, reactor, fuelId: f.id, fuelIds: undefined, requireAllFuels: false, allowedCoolers: ids });
  };

  return (
    <div className="panel config">
      <h2>Reactor</h2>
      <div className="seg">
        <button className={cfg.reactor === 'sfr' ? 'on' : ''} onClick={() => switchReactor('sfr')} disabled={running}>Solid fuel (SFR)</button>
        <button className={cfg.reactor === 'msr' ? 'on' : ''} onClick={() => switchReactor('msr')} disabled={running}>Molten salt (MSR)</button>
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
                <small>{f.heat} H/t · {Math.round(f.efficiency * 100)}% · crit {f.criticality}{f.selfPriming ? ' · self-priming' : ''}</small>
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
          <span>Crit <b>{fuel.criticality}</b></span><span>Time <b>{fuel.time}</b> t</span>{fuel.selfPriming && <span className="tag">self-priming</span>}
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
      <div className="seg four">
        {(['output', 'efficiency', 'balanced', 'breeding'] as const).map((o) => (
          <button key={o} className={cfg.objective === o ? 'on' : ''} onClick={() => set('objective', o)} disabled={running} title={OBJ_HELP[o]}>
            {o === 'output' ? 'Output' : o === 'efficiency' ? 'Efficiency' : o === 'balanced' ? 'Balanced' : 'Breeding'}
          </button>
        ))}
      </div>
      <div className="grid2">
        <label>Max fuel {cfg.reactor === 'sfr' ? 'cells' : 'vessels'}<input type="number" min={1} placeholder="no limit" value={cfg.maxFuel ?? ''} disabled={running} onChange={(e) => set('maxFuel', e.target.value === '' ? '' : Number(e.target.value))} /></label>
        <label>Min efficiency %<input type="number" min={0} placeholder="none" value={cfg.minEfficiency === '' || cfg.minEfficiency == null ? '' : Math.round(Number(cfg.minEfficiency) * 100)} disabled={running} onChange={(e) => set('minEfficiency', e.target.value === '' ? '' : Number(e.target.value) / 100)} /></label>
      </div>

      <h2>Components</h2>
      <div className="chips">
        {meta.moderators.map((m) => (
          <label key={m.id} className={`chip ${cfg.allowedModerators.includes(m.id) ? 'on' : ''}`} title={`flux ×${m.fluxFactor}, efficiency ${m.efficiency}`}>
            <input type="checkbox" checked={cfg.allowedModerators.includes(m.id)} disabled={running} onChange={() => set('allowedModerators', toggle(cfg.allowedModerators, m.id))} />
            <i style={{ background: blockColor(2 + meta.moderators.indexOf(m)) }} />{m.name.replace(' Block', '').replace(' Moderator', '')} <small>{m.fluxFactor}</small>
          </label>
        ))}
        {meta.reflectors.map((r, k) => (
          <label key={r.id} className={`chip ${cfg.allowedReflectors.includes(r.id) ? 'on' : ''}`} title={`reflectivity ${r.reflectivity}, efficiency ${r.efficiency}`}>
            <input type="checkbox" checked={cfg.allowedReflectors.includes(r.id)} disabled={running} onChange={() => set('allowedReflectors', toggle(cfg.allowedReflectors, r.id))} />
            <i style={{ background: blockColor(5 + k) }} />{r.name.replace(' Reflector', '')}
          </label>
        ))}
        <label className={`chip ${cfg.allowConductors ? 'on' : ''}`} title="Conductors join clusters to the casing">
          <input type="checkbox" checked={cfg.allowConductors} disabled={running} onChange={() => set('allowConductors', !cfg.allowConductors)} />
          <i style={{ background: blockColor(7) }} />Conductor
        </label>
      </div>
      <div className="coolhead">
        <span>{cfg.reactor === 'sfr' ? 'Heat sinks' : 'Coolant heaters'} ({cfg.allowedCoolers.length}/{coolers.length})</span>
        <span className="links">
          <a onClick={() => !running && set('allowedCoolers', coolers.map((c) => c.id))}>all</a>
          <a onClick={() => !running && set('allowedCoolers', coolers.filter((c) => RECOMMENDED_SINKS.includes(c.id === 'standard' ? 'water' : c.id)).map((c) => c.id))}>no rare</a>
          <a onClick={() => !running && set('allowedCoolers', [coolers[0].id])}>none</a>
        </span>
      </div>
      <div className="coolers">
        {coolers.map((c) => (
          <label key={c.id} className={`cooler ${cfg.allowedCoolers.includes(c.id) ? 'on' : ''}`} title={`${c.rule}${c.coolant ? ` · coolant: ${c.coolant}` : ''}`}>
            <input type="checkbox" checked={cfg.allowedCoolers.includes(c.id)} disabled={running} onChange={() => set('allowedCoolers', toggle(cfg.allowedCoolers, c.id))} />
            <i style={{ background: blockColor(COOLER0 + coolers.indexOf(c)) }} />
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
