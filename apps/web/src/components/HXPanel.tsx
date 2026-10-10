import { useEffect, useState } from 'react';
import { HX_TUBES, type HxDesign, type HxDesignResult, type ReactorStats } from '@ncopt/engine';
import { fmt, pct } from '../model';

export interface HxSettings { tubeType: string; coldFluid: 'water' | 'preheated_water'; maxSize: number | ''; exchangers: number | '' }
export const defaultHxSettings = (): HxSettings => ({ tubeType: 'auto', coldFluid: 'water', maxSize: '', exchangers: '' });

const COOLANT_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#34d399', '#fb7185', '#60a5fa', '#facc15', '#2dd4bf', '#f97316', '#e879f9'];
const TUBE_NAME: Record<string, string> = { copper: 'Copper', hard_carbon: 'Hard carbon', thermoconducting: 'Thermoconducting' };

interface Props {
  stats: ReactorStats; layoutKey: string; settings: HxSettings; setSettings: (s: HxSettings) => void;
  result: HxDesignResult | null; onResult: (r: HxDesignResult | null) => void;
}

/** Heat exchanger designer for molten-salt reactors: hot NaK coolant → high-pressure steam for the turbine. */
export default function HXPanel({ stats, layoutKey, settings, setSettings, result, onResult }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState(-1);
  const set = <K extends keyof HxSettings>(k: K, v: HxSettings[K]) => setSettings({ ...settings, [k]: v });
  const hot = Object.entries(stats.hotCoolant).filter(([, v]) => v > 0);
  const run = async () => {
    if (!hot.length) { setErr('This reactor produces no hot coolant.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/hx', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hotCoolant: stats.hotCoolant, tubeType: settings.tubeType, coldFluid: settings.coldFluid, maxSize: settings.maxSize, exchangers: settings.exchangers }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onResult(body); setView(-1);
    } catch (e: any) { setErr(e.message); onResult(null); } finally { setBusy(false); }
  };
  useEffect(() => { if (!result && hot.length && stats.stable) run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [layoutKey]);
  const d = result ? (view >= 0 ? result.alternatives[view] ?? result.best : result.best) : null;

  return (
    <div className="panel turbine hx">
      <div className="tsteam">
        <div><div className="muted small">Hot coolant from reactor</div><b>{fmt(hot.reduce((a, [, v]) => a + v, 0), 1)} mB/t</b> <span className="muted small">{hot.length} type{hot.length === 1 ? '' : 's'} · {fmt(result?.demandHeat ?? 0)} HX heat/t</span></div>
      </div>
      <details className="tset">
        <summary>Heat exchanger options</summary>
        <div className="grid3">
          <label>Tubes<select value={settings.tubeType} onChange={(e) => set('tubeType', e.target.value)}>
            <option value="auto">compare all</option>{HX_TUBES.map((t) => <option key={t.id} value={t.id}>{TUBE_NAME[t.id]}</option>)}
          </select></label>
          <label>Shell fluid<select value={settings.coldFluid} onChange={(e) => set('coldFluid', e.target.value as HxSettings['coldFluid'])}>
            <option value="water">Water</option><option value="preheated_water">Preheated water</option>
          </select></label>
          <label>Max interior<input type="number" min={1} max={24} placeholder="24" value={settings.maxSize} onChange={(e) => set('maxSize', e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label>Exchangers<input type="number" min={1} max={64} placeholder="auto" value={settings.exchangers} onChange={(e) => set('exchangers', e.target.value === '' ? '' : Number(e.target.value))} /></label>
        </div>
      </details>
      <button className="primary" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={run}>{busy ? 'Designing…' : result ? 'Redesign heat exchanger' : 'Design heat exchanger'}</button>
      {err && <p className="bad">{err}</p>}
      {!stats.stable && <p className="muted small">The reactor overheats; its hot-coolant figure is not meaningful until it is stable.</p>}
      {result && d && <HxResult result={result} d={d} view={view} onView={setView} />}
    </div>
  );
}

function HxResult({ result, d, view, onView }: { result: HxDesignResult; d: HxDesign; view: number; onView: (i: number) => void }) {
  const k = d.exchangers;
  const tube = HX_TUBES.find((t) => t.id === d.tubeType)!;
  const colors = new Map(d.coolants.map((c, i) => [c.name, COOLANT_COLORS[i % COOLANT_COLORS.length]]));
  const [X, Y, Z] = d.dims;
  const rowAt = new Map(d.rows.map((r) => [`${r.y},${r.z}`, r.coolant]));
  const net0 = d.stats.networks.find((n) => !n.problem) ?? d.stats.networks[0];
  const problems = d.stats.networks.filter((n) => n.problem);
  const all = [result.best, ...result.alternatives];
  return (
    <>
      <div className="statgrid" style={{ marginTop: 10 }}>
        <div className="stat good"><div className="sl">HP steam → turbine</div><div className="sv">{fmt(d.steam, 1)} mB/t</div><div className="ss">{pct(d.steam / Math.max(1e-9, result.idealSteam), 1)} of lossless · {fmt(d.water, 1)} mB/t {d.coldFluid === 'water' ? 'water' : 'preheated water'} in</div></div>
        <div className="stat"><div className="sl">Size (exterior){k > 1 ? ` × ${k}` : ''}</div><div className="sv">{d.exterior.join(' × ')}</div><div className="ss">interior {d.dims.join('×')} · {d.tubes} {TUBE_NAME[d.tubeType].toLowerCase()} tubes{k > 1 ? ' each' : ''}</div></div>
        <div className="stat"><div className="sl">Heat transfer</div><div className="sv">{fmt(d.heatOut)} /t</div><div className="ss">of {fmt(d.heatIn)} taken from the NaK · retention ×{d.retention.toFixed(2)}</div></div>
        <div className="stat"><div className="sl">Per tube</div><div className="sv">{fmt(net0?.meanTempDiff ?? 0)} K · ×{((net0?.tubeDirMult ?? 0) * (net0?.shellDirMult ?? 0)).toFixed(2)}</div><div className="ss">mean ΔT × flow-direction bonus × coefficient {tube.coefficient} = {fmt((net0?.meanTempDiff ?? 0) * (net0?.tubeDirMult ?? 0) * (net0?.shellDirMult ?? 0) * tube.coefficient)} heat/t</div></div>
      </div>
      {view >= 0 && <p className="muted small">Showing an alternative — <a onClick={() => onView(-1)}>back to the best design</a>.</p>}
      {problems.length > 0 && <p className="bad small">{problems.length} tube network(s) do not transfer heat: {problems[0].problem}</p>}

      <h3>Coolant circuits</h3>
      <table className="tbl small">
        <thead><tr><th>Hot coolant</th><th>mB/t</th><th>Rows</th><th>Tubes</th><th>Capacity</th><th>Used</th></tr></thead>
        <tbody>
          {d.coolants.map((c) => (
            <tr key={c.name}><td><i className="sw" style={{ background: colors.get(c.name) }} />{c.name}</td><td>{fmt(c.supply, 1)}</td><td>{c.rows * k}</td><td>{c.tubes * k}</td><td>{fmt(c.capacity, 1)}</td><td className={c.processed + 1e-6 < c.supply ? 'bad' : ''}>{pct(c.processed / c.supply, 0)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Each coolant type needs its own tube rows (fluids cannot mix in a tube network); the shell is shared and boils {d.coldFluid === 'water' ? 'water' : 'preheated water'} into high-pressure steam. Cold NaK returns to the reactor 1 : 1.</p>

      <h3>Layout {k > 1 && <span className="muted small">(build {k} identical exchangers)</span>}</h3>
      <div className="hxwrap">
        <div>
          <div className="muted small">East wall (Y up, Z across) — tube inlets</div>
          <div className="hxgrid" style={{ gridTemplateColumns: `repeat(${Z}, 14px)` }}>
            {Array.from({ length: Y }, (_, yy) => Y - 1 - yy).flatMap((y) => Array.from({ length: Z }, (_, z) => {
              const c = rowAt.get(`${y},${z}`);
              return <i key={`${y},${z}`} title={c ? `row y=${y} z=${z}: ${c}` : 'empty (shell only)'} style={{ background: c ? colors.get(c) : 'transparent' }} />;
            }))}
          </div>
        </div>
        <ul className="small hxsteps">
          <li>Interior {X} (X, east–west) × {Y} (Y, up) × {Z} (Z, north–south).</li>
          <li>Each coloured cell is a straight row of {X} {TUBE_NAME[d.tubeType].toLowerCase()} tube{X > 1 ? 's' : ''} along X; open only the east and west faces of each tube (multitool).</li>
          <li><b>Tube inlet</b> on the east wall and <b>outlet</b> on the west wall at the end of every row; feed each row with its colour's hot coolant.</li>
          <li><b>Shell inlets</b> on the bottom face under the west-most column (x = 0, every z: {Z}); <b>shell outlets</b> on the top face above the east-most column (x = {X - 1}, every z: {Z}). Water rises against the coolant (upward bonus ×1.5; cross-/counter-flow).</li>
          <li>Leave empty cells as air. Controller anywhere on the casing; it needs a redstone signal (or computer) to run.</li>
        </ul>
      </div>

      <h3>Parts {k > 1 ? `(all ${k})` : ''}</h3>
      <table className="tbl small"><tbody>{d.parts.map((p) => <tr key={p.name}><td>{p.name}</td><td>{fmt(p.count)}</td></tr>)}</tbody></table>

      {all.length > 1 && (<>
        <h3>Tube types</h3>
        <table className="tbl small">
          <thead><tr><th>Tubes</th><th>Steam mB/t</th><th>Size</th><th>Tubes</th><th /></tr></thead>
          <tbody>
            {all.map((a, i) => (
              <tr key={a.tubeType} className={a === d ? 'selrow' : ''}>
                <td>{TUBE_NAME[a.tubeType]}</td><td>{fmt(a.steam, 1)}</td><td>{a.exterior.join('×')}{a.exchangers > 1 ? ` ×${a.exchangers}` : ''}</td><td>{fmt(a.tubes * a.exchangers)}</td>
                <td>{a !== d && <button className="mini" onClick={() => onView(i - 1)}>show</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>)}
    </>
  );
}
