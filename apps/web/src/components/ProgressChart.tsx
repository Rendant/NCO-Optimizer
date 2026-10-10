import type { JobSnapshot } from '../api';
import { fmt } from '../model';

const s0 = (s: [number, number, number][]) => (s.length ? s[s.length - 1][1] : 0);
const COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#34d399', '#fb7185', '#60a5fa', '#facc15', '#2dd4bf', '#f97316', '#e879f9'];

/** Best valid effective heating over time, one line per worker thread. */
export default function ProgressChart({ job }: { job: JobSnapshot }) {
  const breeding = job.cfg.objective === 'breeding';
  const W = 300, H = 130, L = 40, B = 18, T = 6, R = 6;
  const series = job.workers.map((w) => (w.history ?? []).filter((p) => p[2]));
  const limit = Number(job.cfg.timeLimitMs ?? 1);
  const tMax = Math.max(limit, ...job.workers.map((w) => w.elapsedMs), 1);
  const vals = series.flat().map((p) => p[1]);
  if (!vals.length) return <div className="panel chart muted small">Progress chart appears once a worker finds a stable layout…</div>;
  const vMax = Math.max(...vals), vMin = Math.min(...vals);
  const pad = vMax > vMin ? (vMax - vMin) * 0.05 : Math.max(1, Math.abs(vMax) * 0.02);
  const lo = Math.max(0, vMin - pad), hi = vMax + pad;
  const x = (t: number) => L + ((W - L - R) * t) / tMax;
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  return (
    <div className="panel chart">
      <h3>Search progress <span className="muted small">best stable {breeding ? 'fuel/h' : 'H/t'} per worker</span></h3>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="#334155" />
        <line x1={L} y1={T} x2={L} y2={H - B} stroke="#334155" />
        <text x={L - 3} y={T + 8} textAnchor="end" className="ax">{fmt(hi, breeding ? 1 : 0)}</text>
        <text x={L - 3} y={H - B} textAnchor="end" className="ax">{fmt(lo, breeding ? 1 : 0)}</text>
        <text x={W - R} y={H - 4} textAnchor="end" className="ax">{(tMax / 1000).toFixed(0)} s</text>
        <text x={L} y={H - 4} className="ax">0</text>
        {series.map((s, k) => {
          if (!s.length) return null;
          const pts: string[] = [];
          let prev = s[0][1];
          pts.push(`${x(s[0][0])},${y(prev)}`);
          for (const [t, v] of s.slice(1)) { pts.push(`${x(t)},${y(prev)}`, `${x(t)},${y(v)}`); prev = v; }
          const end = job.status === 'running' ? job.workers[k].elapsedMs : s[s.length - 1][0];
          pts.push(`${x(Math.max(end, s[s.length - 1][0]))},${y(prev)}`);
          return <polyline key={k} points={pts.join(' ')} fill="none" stroke={COLORS[k % COLORS.length]} strokeWidth={1.4} />;
        })}
      </svg>
      <div className="chartlegend">
        {job.workers.map((w, k) => (
          <span key={k} title={`seed ${w.seed} · ${w.phase}`}><i style={{ background: COLORS[k % COLORS.length] }} />#{k + 1} {w.bestValid ? (breeding ? fmt(s0(series[k]), 1) : fmt(w.effectiveHeating)) : '—'}</span>
        ))}
      </div>
      {(job.librarySeeds || job.libraryAdded) ? <p className="muted small">Library: {job.librarySeeds ?? 0} seed layout(s){job.status !== 'running' ? `, ${job.libraryAdded ?? 0} new entr${job.libraryAdded === 1 ? 'y' : 'ies'} saved` : ''}</p> : null}
    </div>
  );
}
