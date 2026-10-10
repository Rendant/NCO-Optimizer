import { useEffect, useMemo, useState } from 'react';
import {
  reactorSteam, evaluateWall, TURBINE_BLADES, TURBINE_COILS, TURBINE_FLUIDS, W_BEARING, W_CONNECTOR, W_COIL0, W_VALVE,
  type ReactorStats, type TurbineOptimizeResult, type TurbineCandidate, type BladeId,
} from '@ncopt/engine';
import { fmt, pct } from '../model';

export interface TurbineSettings {
  steamOverride: number | ''; allowedBlades: string[]; allowStators: boolean; allowedCoils: string[];
  maxDiameter: number | ''; maxLength: number | ''; turbines: number | '';
}
export const defaultTurbineSettings = (): TurbineSettings => ({
  steamOverride: '', allowedBlades: TURBINE_BLADES.map((b) => b.id), allowStators: true, allowedCoils: TURBINE_COILS.map((c) => c.id),
  maxDiameter: '', maxLength: '', turbines: '',
});

const BLADE_COLOR: Record<BladeId, string> = { steel: '#9ca3af', extreme: '#a78bfa', sic_sic_cmc: '#f59e0b', stator: '#334155' };
const BLADE_ABBR: Record<BladeId, string> = { steel: 'St', extreme: 'Ex', sic_sic_cmc: 'Si', stator: '—' };
const COIL_COLOR = ['#f9a8d4', '#d6d3d1', '#94a3b8', '#eab308', '#c2410c', '#e5e7eb'];
const COIL_ABBR = ['Mg', 'Be', 'Al', 'Au', 'Cu', 'Ag'];

interface Props {
  stats: ReactorStats; layoutKey: string; settings: TurbineSettings; setSettings: (s: TurbineSettings) => void;
  result: TurbineOptimizeResult | null; onResult: (r: TurbineOptimizeResult) => void;
}

export default function TurbinePanel({ stats, layoutKey, settings, setSettings, result, onResult }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState(0); // index into alternatives (-1 = best)
  const autoSteam = reactorSteam(stats);
  const steam = settings.steamOverride === '' ? autoSteam : Number(settings.steamOverride);
  const set = <K extends keyof TurbineSettings>(k: K, v: TurbineSettings[K]) => setSettings({ ...settings, [k]: v });
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const run = async () => {
    if (!(steam > 0)) { setErr('This layout produces no steam.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/turbine', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steamRate: steam, fluidId: 'high_pressure_steam', allowedBlades: settings.allowedBlades, allowStators: settings.allowStators, allowedCoils: settings.allowedCoils, maxDiameter: settings.maxDiameter, maxLength: settings.maxLength, turbines: settings.turbines }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onResult(body); setView(-1);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  // design automatically the first time a layout is shown here
  useEffect(() => { if (!result && steam > 0 && stats.stable) run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [layoutKey]);

  const cand: TurbineCandidate | null = result ? (view >= 0 ? result.alternatives[view] ?? result.best : result.best) : null;

  return (
    <div className="panel turbine">
      <div className="tsteam">
        <div><div className="muted small">Steam from reactor</div><b>{fmt(autoSteam, 1)} mB/t</b> <span className="muted small">high-pressure steam{stats.reactor === 'msr' ? ' (hot coolant → ideal heat exchanger)' : ''}</span></div>
        <label className="small">Override mB/t <input type="number" min={1} placeholder="auto" value={settings.steamOverride} onChange={(e) => set('steamOverride', e.target.value === '' ? '' : Number(e.target.value))} /></label>
      </div>
      <details className="tset">
        <summary>Turbine options</summary>
        <div className="chips">
          {TURBINE_BLADES.map((b) => (
            <label key={b.id} className={`chip ${settings.allowedBlades.includes(b.id) ? 'on' : ''}`} title={`efficiency ${b.efficiency}, expansion ${b.expansion}`}>
              <input type="checkbox" checked={settings.allowedBlades.includes(b.id)} onChange={() => set('allowedBlades', toggle(settings.allowedBlades, b.id))} />
              <i style={{ background: BLADE_COLOR[b.id] }} />{b.name.replace(' Rotor Blade', '')}
            </label>
          ))}
          <label className={`chip ${settings.allowStators ? 'on' : ''}`}><input type="checkbox" checked={settings.allowStators} onChange={() => set('allowStators', !settings.allowStators)} /><i style={{ background: BLADE_COLOR.stator }} />Stators</label>
        </div>
        <div className="chips" style={{ marginTop: 6 }}>
          {TURBINE_COILS.map((c, k) => (
            <label key={c.id} className={`chip ${settings.allowedCoils.includes(c.id) ? 'on' : ''}`} title={`conductivity ${c.conductivity} · ${c.rule}`}>
              <input type="checkbox" checked={settings.allowedCoils.includes(c.id)} disabled={c.id === 'magnesium'} onChange={() => set('allowedCoils', toggle(settings.allowedCoils, c.id))} />
              <i style={{ background: COIL_COLOR[k] }} />{COIL_ABBR[k]} <small>{c.conductivity}</small>
            </label>
          ))}
        </div>
        <div className="grid3">
          <label>Max diameter<input type="number" min={3} max={24} placeholder="24" value={settings.maxDiameter} onChange={(e) => set('maxDiameter', e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label>Max length<input type="number" min={1} max={24} placeholder="24" value={settings.maxLength} onChange={(e) => set('maxLength', e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label>Turbines<input type="number" min={1} placeholder="auto" value={settings.turbines} onChange={(e) => set('turbines', e.target.value === '' ? '' : Number(e.target.value))} /></label>
        </div>
      </details>
      <button className="primary" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={run}>{busy ? 'Designing…' : result ? 'Redesign turbine' : 'Design turbine'}</button>
      {err && <p className="bad">{err}</p>}
      {!stats.stable && <p className="muted small">The reactor overheats; its steam figure is not meaningful until it is stable.</p>}
      {result && cand && <TurbineResult result={result} cand={cand} onView={setView} view={view} />}
    </div>
  );
}

function TurbineResult({ result, cand, onView, view }: { result: TurbineOptimizeResult; cand: TurbineCandidate; onView: (i: number) => void; view: number }) {
  const s = cand.stats, d = cand.design;
  const n = result.turbines;
  const isBest = cand === result.best;
  const fluid = TURBINE_FLUIDS.find((f) => f.id === d.fluidId)!;
  const util = s.inputRate / s.maxInputRate;
  return (
    <>
      <div className="statgrid" style={{ marginTop: 10 }}>
        <div className="stat good"><div className="sl">Power{n > 1 ? ` (${n} turbines)` : ''}</div><div className="sv">{fmt(s.power * n)} RF/t</div><div className="ss">{fmt(s.powerPerMB, 2)} RF/mB (base {fluid.powerPerMB})</div></div>
        <div className="stat"><div className="sl">Size (exterior)</div><div className="sv">{s.exterior.join(' × ')}</div><div className="ss">shaft {d.shaftWidth}×{d.shaftWidth} · blades {s.bladeLength} long</div></div>
        <div className="stat"><div className="sl">Overall multiplier</div><div className="sv">×{s.overallEfficiency.toFixed(3)}</div><div className="ss">vs. ideal {fluid.powerPerMB} RF/mB</div></div>
        <div className={`stat ${s.overloaded ? 'bad' : ''}`}><div className="sl">Steam in / capacity</div><div className="sv">{pct(util, 0)}</div><div className="ss">{fmt(s.inputRate, 1)} / {fmt(s.maxInputRate)} mB/t (safe ≤ {fmt(s.safeInputRate)})</div></div>
      </div>
      {!isBest && <p className="muted small">Showing an alternative — <a onClick={() => onView(-1)}>back to the best design</a>.</p>}

      <h3>Why this design</h3>
      <table className="tbl">
        <tbody>
          <tr><td>Dynamo conductivity</td><td>×{s.conductivity.toFixed(4)}</td><td className="muted">mean of valid coils, ≥ shaft² coils per wall ({s.coilCounts.join(' / ')})</td></tr>
          <tr><td>Rotor efficiency</td><td>×{s.rotorEfficiency.toFixed(4)}</td><td className="muted">blade efficiency × how well each layer matches the ideal expansion</td></tr>
          <tr><td>Expansion ideality</td><td>×{s.expansionIdeality.toFixed(4)}</td><td className="muted">total {s.totalExpansion.toFixed(3)} vs ideal {s.idealTotalExpansion}</td></tr>
          <tr><td>Throughput efficiency</td><td>×{s.throughputEfficiency.toFixed(3)}</td><td className="muted">penalty only when steam &lt; 75% of capacity (with leniency)</td></tr>
          <tr><td>Power bonus</td><td>×{s.powerBonus.toFixed(4)}</td><td className="muted">bigger flow per blade area & short effective length (stators: {s.effectiveMaxLength})</td></tr>
        </tbody>
      </table>

      <h3>Rotor (inlet → outlet), {d.blades.length} layers</h3>
      <RotorChart cand={cand} />

      <h3>Dynamo wall (same on both ends)</h3>
      <WallGrid D={d.diameter} sw={d.shaftWidth} wall={d.walls[0]} />

      <h3>Parts per turbine</h3>
      <table className="tbl small"><tbody>
        {Object.entries(s.parts).filter(([, v]) => v > 0).map(([k, v]) => <tr key={k}><td>{k}</td><td>{fmt(v)}{n > 1 ? <span className="muted"> (×{n} = {fmt(v * n)})</span> : null}</td></tr>)}
      </tbody></table>
      <p className="muted small">Exhaust: {fmt(s.outputRate, 0)} mB/t {s.outputFluid}. Energy buffer {fmt(s.energyCapacity)} RF. Spin-up speed factor ×{s.spinUpInertiaFactor.toFixed(2)} (more coils than bearings ⇒ faster).</p>

      <h3>Size / power alternatives</h3>
      <table className="tbl cmp">
        <thead><tr><th>Interior</th><th>Blades</th><th>RF/t</th><th>RF/mB</th><th>Cond.</th></tr></thead>
        <tbody>
          {result.alternatives.map((a, k) => (
            <tr key={k} className={a === cand ? 'selrow' : ''} onClick={() => onView(a === result.best ? -1 : k)}>
              <td>{a.design.diameter}×{a.design.diameter}×{a.design.blades.length}{a === result.best ? ' ★' : ''}</td>
              <td>{a.stats.bladeSets}+{a.stats.statorSets}st</td><td>{fmt(a.stats.power * n)}</td><td>{fmt(a.stats.powerPerMB, 2)}</td><td>{a.stats.conductivity.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RotorChart({ cand }: { cand: TurbineCandidate }) {
  const L = cand.design.blades.length;
  const layers = cand.stats.layers;
  const maxE = Math.max(cand.stats.idealTotalExpansion, ...layers.map((l) => l.actualExpansion)) * 1.05;
  const W = 330, H = 120, bw = W / L;
  const y = (v: number) => H - (Math.log(v) / Math.log(maxE)) * (H - 10) - 2;
  return (
    <div>
      <div className="rotor" style={{ gridTemplateColumns: `repeat(${L}, 1fr)` }}>
        {cand.design.blades.map((b, k) => (
          <div key={k} style={{ background: BLADE_COLOR[b], color: b === 'stator' ? '#94a3b8' : '#111' }} title={`layer ${k + 1}: ${b} · ideal ${layers[k].idealExpansion.toFixed(3)} · actual ${layers[k].actualExpansion.toFixed(3)} · ${b === 'stator' ? 'stator' : `eff ${layers[k].efficiency.toFixed(3)}`}`}>{BLADE_ABBR[b]}</div>
        ))}
      </div>
      <svg width={W} height={H} className="rchart">
        {layers.map((l, k) => <rect key={k} x={k * bw + 1} width={bw - 2} y={y(l.actualExpansion)} height={H - y(l.actualExpansion)} fill={BLADE_COLOR[l.type]} opacity={0.55} />)}
        <polyline fill="none" stroke="#22c55e" strokeWidth={2} points={layers.map((l, k) => `${k * bw + bw / 2},${y(l.idealExpansion)}`).join(' ')} />
        <text x={4} y={12} fill="#8b98ae" fontSize={10}>bars = actual expansion, green = ideal (log scale)</text>
      </svg>
    </div>
  );
}

function WallGrid({ D, sw, wall }: { D: number; sw: number; wall: number[] }) {
  const v = useMemo(() => evaluateWall(D, sw, wall), [D, sw, wall]);
  const size = Math.max(10, Math.min(24, Math.floor(320 / D)));
  return (
    <div className="lgrid wall" style={{ gridTemplateColumns: `repeat(${D}, ${size}px)`, gridAutoRows: `${size}px`, fontSize: size < 16 ? 8 : 10 }}>
      {wall.map((c, i) => {
        let bg = '#1f2533', label = '', title = 'casing';
        if (c === W_BEARING) { bg = '#475569'; label = '◎'; title = 'rotor bearing'; }
        else if (c === W_VALVE) { bg = '#0e7490'; label = 'IO'; title = 'inlet (outlet on the other end)'; }
        else if (c === W_CONNECTOR) { bg = '#b45309'; label = 'Cn'; title = 'coil connector'; }
        else if (c >= W_COIL0 && c < W_CONNECTOR) { bg = COIL_COLOR[c - W_COIL0]; label = COIL_ABBR[c - W_COIL0]; title = TURBINE_COILS[c - W_COIL0].name; }
        const bad = c >= W_COIL0 && c <= W_CONNECTOR && !v.valid[i];
        return <div key={i} className={bad ? 'dim' : ''} style={{ background: bg, color: '#111' }} title={title + (bad ? ' (invalid)' : '')}>{label}</div>;
      })}
    </div>
  );
}
