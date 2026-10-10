import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fromLayoutJSON, toLayoutJSON, isFuel, fuelSlot, type BlockInfo, type LayoutJSON } from '@ncopt/engine';
import { api, type JobSnapshot, type LibraryEntry, type Meta, type SimDetail } from './api';
import ProgressChart from './components/ProgressChart';
import LibraryPanel from './components/LibraryPanel';
import ConfigPanel, { type Config } from './components/ConfigPanel';
import Viewer3D from './components/Viewer3D';
import LayerGrid from './components/LayerGrid';
import StatsPanel from './components/StatsPanel';
import Inspector from './components/Inspector';
import Compare from './components/Compare';
import TurbinePanel, { defaultTurbineSettings, type TurbineSettings } from './components/TurbinePanel';
import HXPanel, { defaultHxSettings, type HxSettings } from './components/HXPanel';
import type { HxDesignResult } from '@ncopt/engine';
import type { TurbineOptimizeResult } from '@ncopt/engine';
import { blockColor, blockList } from './blocks';
import { download, fmt, pct, type ColorMode, type LayoutEntry } from './model';

const MODS_ONLY = new Set(['moderator']);
const NONE = new Set<string>();
const STORAGE = 'ncopt.layouts.v1';
const loadLayouts = (): LayoutEntry[] => { try { return JSON.parse(localStorage.getItem(STORAGE) ?? '[]'); } catch { return []; } };

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [layouts, setLayouts] = useState<LayoutEntry[]>(loadLayouts);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadLayouts()[0]?.id ?? null);
  const [detail, setDetail] = useState<SimDetail | null>(null);
  const [selBlock, setSelBlock] = useState<number | null>(null);
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [mode, setMode] = useState<ColorMode>('block');
  const [cut, setCut] = useState<{ axis: 'x' | 'y' | 'z'; max: number }>({ axis: 'y', max: 99 });
  const [hideInactive, setHideInactive] = useState(false);
  const [hideMods, setHideMods] = useState(false);
  const [rightTab, setRightTab] = useState<'stats' | 'inspect' | 'turbine' | 'hx'>('stats');
  const [hxSettings, setHxSettings] = useState<HxSettings>(defaultHxSettings);
  const [hxResults, setHxResults] = useState<Record<string, HxDesignResult | null>>({});
  const [turbineSettings, setTurbineSettings] = useState<TurbineSettings>(defaultTurbineSettings);
  const [turbineResults, setTurbineResults] = useState<Record<string, TurbineOptimizeResult>>({});
  const [editing, setEditing] = useState(false);
  const [brush, setBrush] = useState(1);
  const [library, setLibrary] = useState<LibraryEntry[] | null>(null);
  const [libTick, setLibTick] = useState(0);
  const runCounter = useRef(layouts.length);
  const unwatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
      setCfg({
        reactor: 'sfr', dims: [5, 5, 5], fuelId: 'leu-235-oxide', sfrCoolant: 'water', objective: 'output',
        allowedModerators: m.moderators.map((x) => x.id), allowedReflectors: m.reflectors.map((x) => x.id),
        allowedCoolers: m.sinks.map((x) => x.id), allowConductors: false, maxFuel: '', minEfficiency: '',
        symmetry: { x: true, y: true, z: true }, timeLimitSec: 20, workers: m.maxWorkers, seed: '', sourceType: 'californium', cooperate: true, useLibrary: true,
      });
    }).catch((e) => setError(`Cannot reach the API: ${e.message}`));
  }, []);
  useEffect(() => { localStorage.setItem(STORAGE, JSON.stringify(layouts.filter((l) => l.origin !== 'live').slice(0, 60))); }, [layouts]);

  const running = job?.status === 'running';
  const selected = layouts.find((l) => l.id === selectedId) ?? null;
  const live: LayoutEntry | null = running && job?.best ? {
    id: 'live', name: 'Live best', origin: 'live', reactor: job.cfg.reactor, dims: job.cfg.dims, fuelId: job.cfg.fuelId, fuelIds: job.cfg.fuelIds, sfrCoolant: job.cfg.sfrCoolant,
    grid: job.best.grid, stats: job.best.stats, createdAt: Date.now(),
  } : null;
  const shown = live ?? selected;
  const fuelName = useCallback((id: string) => meta?.fuels.find((f) => f.id === id)?.name ?? id, [meta]);
  const fuelsLabel = (l: { fuelId: string; fuelIds?: string[] }) => (l.fuelIds?.length ? l.fuelIds : [l.fuelId]).map(fuelName).join(' + ');

  // full simulation (stats + per-block explanation + source plan) of the shown layout
  const gridKey = shown && shown.origin !== 'live' ? `${shown.id}|${shown.grid.join('')}|${cfg?.sourceType}` : '';
  useEffect(() => {
    if (!shown || shown.origin === 'live' || !cfg) { if (!shown) setDetail(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.simulate({ reactor: shown.reactor, dims: shown.dims, fuelId: shown.fuelId, fuelIds: shown.fuelIds, sfrCoolant: shown.sfrCoolant, grid: shown.grid, sourceType: cfg.sourceType })
        .then((d) => {
          if (cancelled) return;
          setDetail(d);
          setLayouts((ls) => ls.map((l) => (l.id === shown.id ? { ...l, stats: d.stats } : l)));
        })
        .catch((e) => !cancelled && setError(e.message));
    }, 60);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);

  const turbineKey = shown && shown.origin !== 'live' ? `${shown.id}|${shown.grid.join('')}` : '';
  // MSR: the turbine is designed for the heat exchanger's steam once one has been designed
  const hxSteam = shown?.reactor === 'msr' && hxResults[turbineKey] ? hxResults[turbineKey]!.best.steam : null;
  const tKey = hxSteam != null ? `${turbineKey}|hx${hxSteam.toFixed(3)}` : turbineKey;
  const detailValid = detail && shown && shown.origin !== 'live' && detail.layout.dims.join() === shown.dims.join();
  const infos = useMemo(() => {
    const m = new Map<number, BlockInfo>();
    if (detailValid) for (const b of detail!.blocks) m.set(b.index, b);
    return m;
  }, [detail, detailValid]);
  const maxEff = useMemo(() => Math.max(0, ...[...infos.values()].map((b) => b.fuel?.efficiency ?? 0)), [infos]);
  const maxFlux = useMemo(() => Math.max(1, ...[...infos.values()].map((b) => b.fuel?.bunch.flux ?? 0)), [infos]);

  // server-side library for the current size / fuel / coolant / objective (refreshed on change and after each job)
  const libKey = cfg ? JSON.stringify([cfg.reactor, cfg.dims, cfg.fuelId, cfg.fuelIds, cfg.sfrCoolant, cfg.objective, cfg.allowedModerators, cfg.allowedReflectors, cfg.allowedCoolers, cfg.allowConductors]) : '';
  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    const t = setTimeout(() => api.libraryQuery(cfg).then((r) => !cancelled && setLibrary(r.entries)).catch(() => !cancelled && setLibrary([])), 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libKey, libTick]);

  const libraryLayout = async (e: LibraryEntry): Promise<LayoutEntry | null> => {
    if (!cfg) return null;
    try {
      const d = await api.simulate({ reactor: cfg.reactor, dims: cfg.dims, fuelId: cfg.fuelId, fuelIds: cfg.fuelIds, sfrCoolant: cfg.sfrCoolant, grid: e.grid });
      const l: LayoutEntry = { id: `lib-${e.id}-${Date.now()}`, name: `Library ${Math.round(e.effectiveHeating)} H/t`, origin: 'library', reactor: cfg.reactor, dims: [...cfg.dims] as [number, number, number],
        fuelId: cfg.fuelId, fuelIds: cfg.fuelIds, sfrCoolant: cfg.sfrCoolant, grid: e.grid, stats: d.stats, createdAt: Date.now(), note: cfg.objective };
      setLayouts((ls) => [l, ...ls]); setSelectedId(l.id); setSelBlock(null);
      return l;
    } catch (err: any) { setError(err.message); return null; }
  };

  /** Starts a job; with `from`, every search starts from that layout (improvement mode). */
  const start = async (from: LayoutEntry | null) => {
    if (!cfg) return;
    setError(null);
    try {
      const body = { ...cfg, initial: from ? from.grid : undefined };
      if (from) { body.dims = from.dims; body.reactor = from.reactor; body.fuelId = from.fuelId; body.fuelIds = from.fuelIds; if (from.sfrCoolant) body.sfrCoolant = from.sfrCoolant; }
      const { jobId } = await api.optimize(body);
      const n = ++runCounter.current;
      unwatch.current?.();
      unwatch.current = api.watch(jobId, setJob, (snap) => {
        setJob(snap);
        const res = (snap.results ?? []).map((r, k): LayoutEntry => ({
          id: `${r.id}-${k}`, name: `Run ${n}${(snap.results?.length ?? 0) > 1 ? String.fromCharCode(97 + k) : ''}`, origin: 'optimizer',
          reactor: snap.cfg.reactor, dims: snap.cfg.dims, fuelId: snap.cfg.fuelId, fuelIds: snap.cfg.fuelIds, sfrCoolant: snap.cfg.sfrCoolant, grid: r.grid, stats: r.stats,
          createdAt: Date.now(), note: `${snap.cfg.objective}, seed ${r.seed}${r.valid ? '' : ', constraints not met'}`,
        }));
        if (res.length) { setLayouts((ls) => [...res, ...ls]); setSelectedId(res[0].id); setSelBlock(null); }
        setLibTick((t) => t + 1);
      }, setError);
    } catch (e: any) { setError(e.message); }
  };

  const onCell = (i: number, erase: boolean) => {
    if (!shown || shown.origin === 'live') { setSelBlock(i); return; }
    if (!editing) { setSelBlock(i); setRightTab('inspect'); return; }
    const grid = shown.grid.slice();
    grid[i] = erase ? 0 : brush;
    if (shown.origin === 'edited') setLayouts((ls) => ls.map((l) => (l.id === shown.id ? { ...l, grid } : l)));
    else {
      const e: LayoutEntry = { ...shown, id: `edit-${Date.now()}`, name: `${shown.name} (edited)`, origin: 'edited', grid, createdAt: Date.now() };
      setLayouts((ls) => [e, ...ls]); setSelectedId(e.id);
    }
  };

  const importFile = async (f: File) => {
    try {
      const j = JSON.parse(await f.text()) as LayoutJSON;
      if (j.format !== 'ncopt-layout') throw new Error('Not an ncopt layout file');
      const grid = Array.from(fromLayoutJSON(j));
      const d = await api.simulate({ reactor: j.reactor, dims: j.dims, fuelId: j.fuelId, fuelIds: j.fuelIds, sfrCoolant: j.sfrCoolant, grid });
      const e: LayoutEntry = { id: `imp-${Date.now()}`, name: f.name.replace(/\.json$/, ''), origin: 'import', reactor: j.reactor, dims: j.dims, fuelId: j.fuelId, fuelIds: j.fuelIds, sfrCoolant: j.sfrCoolant, grid, stats: d.stats, createdAt: Date.now() };
      setLayouts((ls) => [e, ...ls]); setSelectedId(e.id);
    } catch (e: any) { setError(`Import failed: ${e.message}`); }
  };
  const exportLayout = (l: LayoutEntry) => download(`${l.name.replace(/\W+/g, '_')}.json`, JSON.stringify({ ...toLayoutJSON(l.grid, l.dims, l.reactor, l.fuelId, l.sfrCoolant, l.fuelIds), stats: l.stats }, null, 1));

  if (error && !meta) return <div className="fatal">{error}<p>Start the server with <code>npm start</code>.</p></div>;
  if (!meta || !cfg) return <div className="fatal">Loading…</div>;

  const elapsed = job ? Math.max(0, ...job.workers.map((w) => w.elapsedMs)) : 0;
  const limit = (job?.cfg.timeLimitMs ?? 1) as number;
  const evalRate = elapsed > 0 && job ? job.totalEvaluations / (elapsed / 1000) : 0;
  const dimMax = shown ? shown.dims[cut.axis === 'x' ? 0 : cut.axis === 'y' ? 1 : 2] - 1 : 0;
  const plan = detailValid ? detail!.sourcePlan : null;
  const stats = detailValid ? detail!.stats : shown?.stats;
  const shownFuel = shown ? meta.fuels.find((f) => f.id === shown.fuelId) : undefined;
  const shownFuelIds = shown ? (shown.fuelIds?.length ? shown.fuelIds : [shown.fuelId]) : [cfg.fuelId];
  const palette = blockList(shown?.reactor ?? cfg.reactor).filter((b) => b.id > 0 && (!isFuel(b.id) || fuelSlot(b.id) < shownFuelIds.length))
    .map((b) => (isFuel(b.id) && shownFuelIds.length > 1 ? { ...b, name: `${b.name.replace(/ #\d+$/, '')} — ${fuelName(shownFuelIds[fuelSlot(b.id)])}` } : b));

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo" />NuclearCraft: Overhauled · Fission Optimizer</div>
        {job && (
          <div className={`jobbar ${job.status}`}>
            <div className="bar"><div style={{ width: `${Math.min(100, (100 * elapsed) / limit)}%` }} /></div>
            <span>{job.status === 'running' ? 'Optimizing' : job.status}</span>
            <span>{fmt(job.totalEvaluations)} evals · {fmt(evalRate / 1000, 1)}k/s · {job.workers.length} workers</span>
            {job.best && <span>best <b>{fmt(job.best.stats.effectiveHeating)} H/t</b> @ {pct(job.best.stats.meanEfficiency)}{job.cfg.objective === 'breeding' ? ` · ${fmt(job.best.stats.fuelPerHour, 1)} ${job.best.stats.fuelUnit}` : ''}{job.best.valid ? '' : ' (infeasible)'}</span>}
          </div>
        )}
        <label className="btn">Import JSON<input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label>
      </header>
      {error && <div className="error" onClick={() => setError(null)}>{error} <small>(click to dismiss)</small></div>}
      <main>
        <aside className="left">
          <ConfigPanel meta={meta} cfg={cfg} setCfg={setCfg} running={running} onStart={(fromCurrent) => start(fromCurrent ? selected : null)} onCancel={() => job && api.cancel(job.id)}
            canSeedFromCurrent={!!selected && selected.reactor === cfg.reactor} />
          {job && <ProgressChart job={job} />}
          <LibraryPanel entries={library} running={running} breeding={cfg.objective === 'breeding'} label={`${cfg.dims.join('×')} · ${fuelsLabel(cfg)} · ${cfg.objective}`}
            onLoad={(e) => libraryLayout(e)} onImprove={async (e) => { const l = await libraryLayout(e); if (l) start(l); }}
            onDelete={(e) => api.libraryDelete(e.id).then(() => setLibTick((t) => t + 1)).catch((err) => setError(err.message))} />
        </aside>
        <section className="center">
          <div className="toolbar">
            <div className="seg small">
              <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button>
              <button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>Layers</button>
            </div>
            <label>Color <select value={mode} onChange={(e) => setMode(e.target.value as ColorMode)}>
              <option value="block">Block type</option><option value="state">Active / inactive</option><option value="cluster">Cluster</option>
              <option value="efficiency">Fuel efficiency</option><option value="flux">Neutron flux</option>
            </select></label>
            {view === '3d' && shown && (<>
              <label>Cut <select value={cut.axis} onChange={(e) => setCut({ axis: e.target.value as 'x' | 'y' | 'z', max: 99 })}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
                <input type="range" min={0} max={dimMax} value={Math.min(cut.max, dimMax)} onChange={(e) => setCut({ ...cut, max: Number(e.target.value) })} />
                <span className="muted">≤{Math.min(cut.max, dimMax) + 1}</span></label>
              <label><input type="checkbox" checked={hideInactive} onChange={() => setHideInactive(!hideInactive)} />hide inactive</label>
              <label><input type="checkbox" checked={hideMods} onChange={() => setHideMods(!hideMods)} />hide moderators</label>
            </>)}
            {view === '2d' && shown && shown.origin !== 'live' && (
              <label className={editing ? 'editon' : ''}><input type="checkbox" checked={editing} onChange={() => setEditing(!editing)} />edit (left = paint, right = erase)</label>
            )}
          </div>
          {view === '2d' && editing && (
            <div className="palette">
              {palette.map((b) => (
                <button key={b.id} className={brush === b.id ? 'on' : ''} title={b.name} onClick={() => setBrush(b.id)}>
                  <i style={{ background: blockColor(b.id) }} />{b.name.replace(' Heat Sink', '').replace(' Coolant Heater', '').replace(' Block', '')}
                </button>
              ))}
            </div>
          )}
          <div className="view">
            {!shown ? (
              <div className="empty">
                <h3>No layout yet</h3>
                <p>Pick reactor size, fuel and allowed components on the left, then press <b>Optimize</b>. Each worker thread runs an independent simulated-annealing search using the exact NC:O fission rules; results appear below for comparison.</p>
              </div>
            ) : view === '3d' ? (
              <Viewer3D layout={shown} infos={infos} mode={mode} maxEff={maxEff} maxFlux={maxFlux} selected={selBlock}
                onSelect={(i) => { setSelBlock(i); if (i != null) setRightTab('inspect'); }} sources={plan?.sources ?? []} cut={cut} hideInactive={hideInactive}
                hideAirlike={hideMods ? MODS_ONLY : NONE} />
            ) : (
              <LayerGrid layout={shown} infos={infos} mode={mode} maxEff={maxEff} maxFlux={maxFlux} selected={selBlock} onCell={onCell} sources={plan?.sources ?? []} editing={editing} />
            )}
            {shown && <div className="viewlabel">{shown.name} · {shown.dims.join('×')} · {fuelsLabel(shown)}{shown.origin === 'live' ? ' · updating live' : ''}</div>}
            <Legend mode={mode} grid={shown?.grid} reactor={shown?.reactor ?? 'sfr'} fuelNames={shownFuelIds.length > 1 ? shownFuelIds.map(fuelName) : undefined} />
          </div>
        </section>
        <aside className="right">
          <div className="seg small tabs">
            <button className={rightTab === 'stats' ? 'on' : ''} onClick={() => setRightTab('stats')}>Stats & insights</button>
            <button className={rightTab === 'inspect' ? 'on' : ''} onClick={() => setRightTab('inspect')}>Block inspector</button>
            {shown?.reactor === 'msr' && <button className={rightTab === 'hx' ? 'on' : ''} onClick={() => setRightTab('hx')}>Heat exch.</button>}
            <button className={rightTab === 'turbine' ? 'on' : ''} onClick={() => setRightTab('turbine')}>Turbine</button>
          </div>
          {rightTab === 'hx' && shown?.reactor === 'msr' ? (stats && shown && shown.origin !== 'live' && detailValid ? (
            <HXPanel key={turbineKey} stats={stats} layoutKey={turbineKey} settings={hxSettings} setSettings={setHxSettings}
              result={hxResults[turbineKey] ?? null} onResult={(r) => setHxResults((m) => ({ ...m, [turbineKey]: r }))} />
          ) : <div className="panel muted">{running ? 'Wait for the optimization to finish, then select a layout.' : 'Select a layout first.'}</div>) : rightTab === 'turbine' || rightTab === 'hx' ? (stats && shown && shown.origin !== 'live' && detailValid ? (
            <TurbinePanel key={tKey} stats={stats} layoutKey={tKey} settings={turbineSettings} setSettings={setTurbineSettings}
              result={turbineResults[tKey] ?? null} hxSteam={hxSteam}
              onResult={(r) => {
                setTurbineResults((m) => ({ ...m, [tKey]: r }));
                const d = r.best.design;
                setLayouts((ls) => ls.map((l) => (l.id === shown.id ? { ...l, turbine: { totalPower: r.totalPower, turbines: r.turbines, size: `${d.diameter + 2}×${d.diameter + 2}×${d.blades.length + 2}`, rfPerMB: r.best.stats.powerPerMB } } : l)));
              }} />
          ) : <div className="panel muted">{running ? 'Wait for the optimization to finish, then select a layout.' : 'Select a layout first.'}</div>) : rightTab === 'stats' ? (stats && shownFuel ? (
            <StatsPanel stats={stats} blocks={detailValid ? detail!.blocks : null} plan={plan} sourceName={meta.sources.find((s) => s.id === cfg.sourceType)?.name ?? ''}
              fuelName={fuelsLabel(shown!)} fuelBaseHeat={shownFuel.heat} fuelBaseEff={shownFuel.efficiency} />
          ) : <div className="panel muted">No layout selected.</div>) : (
            <Inspector info={selBlock != null ? infos.get(selBlock) ?? null : null} air={selBlock != null && shown && !infos.has(selBlock) && shown.grid[selBlock] === 0 ? [selBlock % shown.dims[0], Math.floor(selBlock / shown.dims[0]) % shown.dims[1], Math.floor(selBlock / (shown.dims[0] * shown.dims[1]))] : undefined} onJump={(p) => shown && setSelBlock(p[0] + shown.dims[0] * (p[1] + shown.dims[1] * p[2]))} />
          )}
        </aside>
      </main>
      <section className="bottom">
        <h2>Compare layouts <span className="muted">({layouts.length})</span></h2>
        <Compare layouts={layouts} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setSelBlock(null); }}
          onRemove={(id) => setLayouts((ls) => ls.filter((l) => l.id !== id))} onExport={exportLayout} fuelName={fuelName}
          onImprove={running ? undefined : (l) => { setSelectedId(l.id); start(l); }} />
      </section>
    </div>
  );
}

function Legend({ mode, grid, reactor, fuelNames }: { mode: ColorMode; grid?: number[]; reactor: 'sfr' | 'msr'; fuelNames?: string[] }) {
  if (!grid) return null;
  if (mode === 'efficiency' || mode === 'flux') return <div className="legend"><span>low</span><div className="rampbar" /><span>high {mode}</span></div>;
  if (mode === 'state') return <div className="legend"><span><i style={{ background: '#22c55e' }} />active</span><span><i style={{ background: '#ef4444' }} />inactive</span></div>;
  if (mode === 'cluster') return <div className="legend"><span>colors = heat clusters</span></div>;
  const counts = new Map<number, number>();
  for (const b of grid) if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  const names = blockList(reactor);
  return (
    <div className="legend">
      {[...counts.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => (
        <span key={b}><i style={{ background: blockColor(b) }} />{fuelNames && isFuel(b) ? fuelNames[fuelSlot(b)] : names[b].name.replace(' Heat Sink', '').replace(' Coolant Heater', '')} ×{n}</span>
      ))}
    </div>
  );
}
