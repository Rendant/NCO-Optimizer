import type { ReactorStats } from '@ncopt/engine';
import { fmt, pct, type LayoutEntry } from '../model';

interface Props {
  layouts: LayoutEntry[]; selectedId: string | null; onSelect: (id: string) => void; onRemove: (id: string) => void;
  onExport: (l: LayoutEntry) => void; fuelName: (id: string) => string;
  /** run the optimizer starting from this layout (undefined while a job is running) */
  onImprove?: (l: LayoutEntry) => void;
}

type Col = { key: string; label: string; get: (s: ReactorStats, l: LayoutEntry) => number; show: (v: number) => string; higher: boolean | null };
const COLS: Col[] = [
  { key: 'eff', label: 'Eff. heat H/t', get: (s) => s.effectiveHeating, show: (v) => fmt(v), higher: true },
  { key: 'rf', label: 'Ideal RF/t', get: (s) => s.rfPerTick, show: (v) => (v ? fmt(v) : '—'), higher: true },
  { key: 'trf', label: 'Turbine RF/t', get: (_s, l) => l.turbine?.totalPower ?? NaN, show: (v) => (Number.isFinite(v) ? fmt(v) : '—'), higher: true },
  { key: 'me', label: 'Efficiency', get: (s) => s.meanEfficiency, show: (v) => pct(v), higher: true },
  { key: 'hm', label: 'Heat mult', get: (s) => s.meanHeatMult, show: (v) => `×${v.toFixed(2)}`, higher: true },
  { key: 'fuel', label: 'Fuel', get: (s) => s.runningFuelComponents, show: (v) => fmt(v), higher: null },
  { key: 'perfuel', label: 'H/t per fuel', get: (s) => (s.runningFuelComponents ? s.effectiveHeating / s.runningFuelComponents : 0), show: (v) => fmt(v, 1), higher: true },
  { key: 'raw', label: 'Raw heat', get: (s) => s.rawHeating, show: (v) => fmt(v), higher: true },
  { key: 'cool', label: 'Cooling', get: (s) => s.cooling, show: (v) => fmt(v), higher: true },
  { key: 'margin', label: 'Margin', get: (s) => s.cooling - s.rawHeating, show: (v) => (v >= 0 ? '+' : '') + fmt(v), higher: null },
  { key: 'sp', label: 'Sparsity', get: (s) => s.sparsityEfficiencyMult, show: (v) => `×${v.toFixed(3)}`, higher: true },
  { key: 'fph', label: 'Fuel/h', get: (s) => s.fuelPerHour, show: (v) => fmt(v, 2), higher: null },
];

export default function Compare({ layouts, selectedId, onSelect, onRemove, onExport, fuelName, onImprove }: Props) {
  if (!layouts.length) return <div className="panel compare muted">Optimized, imported and edited layouts appear here for side-by-side comparison.</div>;
  const base = layouts.find((l) => l.id === selectedId);
  const best = new Map<string, number>();
  for (const c of COLS) {
    const vals = layouts.filter((l) => l.stats.stable).map((l) => c.get(l.stats, l)).filter(Number.isFinite);
    if (vals.length && c.higher != null) best.set(c.key, c.higher ? Math.max(...vals) : Math.min(...vals));
  }
  return (
    <div className="panel compare">
      <table className="tbl cmp">
        <thead>
          <tr><th>Layout</th><th>Size · fuel</th><th>OK</th>{COLS.map((c) => <th key={c.key}>{c.label}</th>)}<th /></tr>
        </thead>
        <tbody>
          {layouts.map((l) => (
            <tr key={l.id} className={l.id === selectedId ? 'selrow' : ''} onClick={() => onSelect(l.id)}>
              <td><b>{l.name}</b><div className="muted">{l.origin}{l.note ? ` · ${l.note}` : ''}</div></td>
              <td>{l.dims.join('×')}<div className="muted">{(l.fuelIds?.length ? l.fuelIds : [l.fuelId]).map(fuelName).join(' + ')}</div></td>
              <td>{l.stats.stable ? <span className="ok">✓</span> : <span className="bad">✗</span>}</td>
              {COLS.map((c) => {
                const v = c.get(l.stats, l);
                const isBest = l.stats.stable && best.get(c.key) === v && layouts.length > 1;
                const d = base && base.id !== l.id ? c.get(base.stats, base) : null;
                const delta = d != null && d !== 0 ? (v - d) / Math.abs(d) : null;
                return (
                  <td key={c.key} className={isBest ? 'best' : ''}>
                    {c.show(v)}
                    {delta != null && Math.abs(delta) > 0.0005 && <div className={`delta ${c.higher == null ? '' : (delta > 0) === c.higher ? 'up' : 'down'}`}>{delta > 0 ? '+' : ''}{(delta * 100).toFixed(1)}%</div>}
                  </td>
                );
              })}
              <td className="rowact" onClick={(e) => e.stopPropagation()}>
                <button className="mini" disabled={!onImprove} onClick={() => onImprove?.(l)} title="Improve: run the optimizer starting from this layout (uses the current objective, components and time limit)">Improve</button>
                <button className="mini" onClick={() => onExport(l)} title="Export JSON">JSON</button>
                <button className="mini" onClick={() => onRemove(l.id)} title="Remove">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Bold green = best among stable layouts; percentages are relative to the selected layout.</p>
    </div>
  );
}
