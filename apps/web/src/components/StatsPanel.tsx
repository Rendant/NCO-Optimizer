import type { BlockInfo, ReactorStats, SourcePlan, ShutdownCheck, DecayReport } from '@ncopt/engine';
import { fmt, pct } from '../model';
import { clusterColor, blockColor } from '../blocks';
import { fuelBlock } from '@ncopt/engine';

interface Props {
  stats: ReactorStats; blocks: BlockInfo[] | null; plan: SourcePlan | null; sourceName: string; fuelName: string; fuelBaseHeat: number; fuelBaseEff: number;
  shutdown?: ShutdownCheck | null; decay?: DecayReport | null;
}

/** Ticks as a short human-readable duration (20 ticks = 1 s). */
const ticks = (t: number) => (t < 1200 ? `${fmt(t / 20)} s` : t < 72000 ? `${fmt(t / 1200, 1)} min` : `${fmt(t / 72000, 1)} h`);

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' }) {
  return <div className={`stat ${tone ?? ''}`}><div className="sl">{label}</div><div className="sv">{value}</div>{sub && <div className="ss">{sub}</div>}</div>;
}

/** Plain-language findings explaining what drives (or limits) this layout's performance. */
export function insights(s: ReactorStats, blocks: BlockInfo[] | null, plan: SourcePlan | null, shutdown?: ShutdownCheck | null): { tone: 'good' | 'bad' | 'warn' | 'info'; text: string }[] {
  const out: { tone: 'good' | 'bad' | 'warn' | 'info'; text: string }[] = [];
  if (s.fuelComponents === 0) return [{ tone: 'bad', text: 'No fuel components placed.' }];
  if (!s.stable) out.push({ tone: 'bad', text: `Overheating: ${fmt(s.excessHeat)} H/t more heat than cooling in at least one cluster — the reactor would melt down.` });
  else out.push({ tone: 'good', text: `Stable: every cluster's cooling covers its heat (margin ${fmt(s.cooling - s.rawHeating)} H/t overall).` });
  if (s.runningFuelComponents < s.fuelComponents) out.push({ tone: 'warn', text: `${s.fuelComponents - s.runningFuelComponents} of ${s.fuelComponents} fuel components are not critical (wasted).` });
  if (s.coolers > s.validCoolers) out.push({ tone: 'warn', text: `${s.coolers - s.validCoolers} cooling components fail their placement rule and provide no cooling.` });
  if (s.sparsityEfficiencyMult < 1) out.push({ tone: 'warn', text: `Sparsity penalty ×${s.sparsityEfficiencyMult.toFixed(3)}: only ${pct(s.usefulPartRatio)} of the interior is functional (threshold 75%).` });
  else out.push({ tone: 'good', text: `No sparsity penalty (${pct(s.usefulPartRatio)} of the interior is functional).` });
  if (s.disconnectedFuelClusters > 0) out.push({ tone: 'bad', text: `${s.disconnectedFuelClusters} cluster(s) with fuel do not touch the casing; their heat is lost.` });
  out.push({ tone: 'info', text: `Mean heat multiplier ×${s.meanHeatMult.toFixed(2)} (more flux-carrying moderator lines per fuel component → more heat) and mean efficiency ${pct(s.meanEfficiency)}.` });
  if (blocks) {
    const fuels = blocks.filter((b) => b.fuel?.running);
    if (fuels.length) {
      const avg = (f: (b: BlockInfo) => number) => fuels.reduce((a, b) => a + f(b), 0) / fuels.length;
      const lines = avg((b) => b.fuel!.lines.length);
      out.push({ tone: 'info', text: `Each running component has on average ${lines.toFixed(2)} moderator lines, moderator-line efficiency ×${avg((b) => b.fuel!.moderatorEfficiencyFactor).toFixed(3)}, flux efficiency ×${avg((b) => b.fuel!.fluxEfficiencyFactor).toFixed(3)}.` });
      const hiFlux = fuels.filter((b) => b.fuel!.fluxEfficiencyFactor < 0.9).length;
      if (hiFlux) out.push({ tone: 'warn', text: `${hiFlux} component(s) receive flux near/above 2× criticality, which lowers their efficiency.` });
    }
    const refl = blocks.filter((b) => b.reflector?.active).length;
    if (refl) out.push({ tone: 'info', text: `${refl} active reflector(s) bounce flux back into their fuel component (counts as a moderator line).` });
    const intrinsic = fuels.reduce((a, b) => a + b.fuel!.lines.filter((l) => l.intrinsic && l.kind === 'fuel').length, 0);
    if (intrinsic) out.push({ tone: 'info', text: `${intrinsic} direct intrinsic-flux link(s) between adjacent fuel components (each adds a heat multiplier).` });
  }
  if (s.irradiators > 0) {
    if (s.activeIrradiators < s.irradiators) out.push({ tone: 'warn', text: `${s.irradiators - s.activeIrradiators} of ${s.irradiators} irradiator(s) receive no flux.` });
    if (s.irradiatorFlux > 0) out.push({ tone: 'info', text: `Irradiators receive ${fmt(s.irradiatorFlux)} flux: ${fmt(s.irradiatorItemsPerHour, 2)} items/h. Each irradiator line adds a heat multiplier to its fuel component but counts with the recipe efficiency in its line efficiency.` });
  }
  if (s.shields > 0) {
    if (s.activeShields < s.shields) out.push({ tone: 'warn', text: `${s.shields - s.activeShields} of ${s.shields} shield(s) are not in a complete moderator line.` });
    if (s.shieldRawHeating > 0) out.push({ tone: 'info', text: `Shields turn their line flux into ${fmt(s.shieldRawHeating)} H/t of heat (counted in their clusters).` });
  }
  if (shutdown) {
    out.push(shutdown.controllable
      ? { tone: 'good', text: `Controllable: switching the ${shutdown.shields} shield(s) on stops every fuel component.` }
      : { tone: 'warn', text: `Not controllable by shields: ${shutdown.stillRunning} fuel component(s) keep running with every shield on.` });
  }
  for (const c of s.clusters) {
    if (c.fuelCount > 0 && c.overcoolingEfficiencyFactor < 0.999) out.push({ tone: 'warn', text: `Cluster ${c.id + 1} is overcooled (${fmt(c.cooling)} cooling for ${fmt(c.rawHeating)} heat): efficiency ×${c.overcoolingEfficiencyFactor.toFixed(3)}.` });
  }
  if (plan?.needed) {
    if (plan.fullyPrimed) out.push({ tone: 'info', text: `Needs ${plan.sources.length} neutron source(s) to start; with them effective heat is ${fmt(plan.stats.effectiveHeating)} H/t.` });
    else out.push({ tone: 'bad', text: `Could not prime ${plan.unprimedRunning} component(s) from the casing walls — they need an internal path to a source.` });
  }
  return out;
}

export default function StatsPanel({ stats: s, blocks, plan, sourceName, fuelName, fuelBaseHeat, fuelBaseEff, shutdown, decay }: Props) {
  const sfr = s.reactor === 'sfr', pbr = s.reactor === 'pbr';
  const margin = s.cooling - s.rawHeating;
  const coolerGroups = new Map<string, { n: number; valid: number; cooling: number }>();
  for (const b of blocks ?? []) if (b.cooler) {
    const g = coolerGroups.get(b.name) ?? { n: 0, valid: 0, cooling: 0 };
    g.n++; if (b.cooler.valid) { g.valid++; g.cooling += b.cooler.cooling; }
    coolerGroups.set(b.name, g);
  }
  const ins = insights(s, blocks, plan, shutdown);
  return (
    <div className="panel stats">
      <div className="statgrid">
        <Stat label={sfr ? 'Effective heat' : pbr ? 'Gas cooler output' : 'Heater output'} value={`${fmt(s.effectiveHeating)} H/t`} tone={s.stable ? 'good' : 'bad'} sub={sfr ? fuelName : `Σ ${pbr ? 'cooler' : 'heater'} cooling × heating speed`} />
        {sfr ? <Stat label="Steam → ideal RF/t" value={`${fmt(s.rfPerTick)} RF/t`} sub={`${fmt(s.outputFluid, 1)} mB/t steam · real turbine: Turbine tab`} />
          : pbr ? <Stat label="Hot gas → ideal RF/t" value={`${fmt(s.rfPerTick)} RF/t`} sub={`${fmt(s.outputFluid, 1)} mB/t hot gas · speed ×${s.meanHeatingSpeedMultiplier.toFixed(3)}`} />
          : <Stat label="Hot coolant" value={`${fmt(Object.values(s.hotCoolant).reduce((a, b) => a + b, 0), 2)} mB/t`} sub={`speed ×${s.meanHeatingSpeedMultiplier.toFixed(3)}`} />}
        <Stat label="Mean efficiency" value={pct(s.meanEfficiency)} sub={`heat mult ×${s.meanHeatMult.toFixed(2)}`} />
        <Stat label="Raw heat / cooling" value={`${fmt(s.rawHeating)} / ${fmt(s.cooling)}`} sub={`margin ${margin >= 0 ? '+' : ''}${fmt(margin)} H/t`} tone={s.stable ? undefined : 'bad'} />
        <Stat label="Fuel components" value={`${s.runningFuelComponents} / ${s.fuelComponents}`} sub={s.fuelBreakdown && s.fuelBreakdown.length > 1 ? `${s.fuelBreakdown.filter((u) => u.producing > 0).length} of ${s.fuelBreakdown.length} fuels used` : `base ${fuelBaseHeat} H/t · ${Math.round(fuelBaseEff * 100)}%`} tone={s.runningFuelComponents < s.fuelComponents ? 'warn' : undefined} />
        <Stat label="Fuel use" value={`${fmt(s.fuelPerHour, 2)} ${s.fuelUnit}`} sub={sfr || pbr ? `${fmt(s.coolantInput, 1)} mB/t ${sfr ? 'fluid' : 'gas'} in` : undefined} />
        <Stat label="Sparsity" value={`×${s.sparsityEfficiencyMult.toFixed(3)}`} sub={`${pct(s.usefulPartRatio)} useful parts`} tone={s.sparsityEfficiencyMult < 1 ? 'warn' : undefined} />
        <Stat label="Components" value={`${s.validCoolers}/${s.coolers} coolers`} sub={`${s.activeModerators} active + ${s.passiveModerators} passive mods · ${s.activeReflectors} refl`} tone={s.validCoolers < s.coolers ? 'warn' : undefined} />
        {s.irradiators > 0 && <Stat label="Irradiators" value={`${fmt(s.irradiatorFlux)} flux`} sub={`${s.activeIrradiators}/${s.irradiators} active · ${fmt(s.irradiatorItemsPerHour, 2)} items/h`} tone={s.activeIrradiators < s.irradiators ? 'warn' : undefined} />}
        {s.shields > 0 && <Stat label="Neutron shields" value={`${s.activeShields}/${s.shields} in lines`} sub={`${fmt(s.shieldRawHeating)} H/t heat${shutdown ? (shutdown.controllable ? ' · controllable' : ` · ${shutdown.stillRunning} keep running`) : ''}`} tone={shutdown && !shutdown.controllable ? 'warn' : undefined} />}
      </div>
      {!sfr && Object.keys(s.hotCoolant).length > 0 && (
        <div className="hotc">{Object.entries(s.hotCoolant).map(([k, v]) => <span key={k}>{k}: <b>{fmt(v, 2)}</b> mB/t</span>)}</div>
      )}

      {s.fuelBreakdown && s.fuelBreakdown.length > 1 && (<>
        <h3>Fuels</h3>
        <table className="tbl">
          <thead><tr><th>Fuel</th><th>Running</th><th>Heat H/t</th><th>Use</th></tr></thead>
          <tbody>
            {s.fuelBreakdown.map((u, k) => (
              <tr key={u.fuelId} className={u.producing === 0 ? 'warnrow' : ''}>
                <td><i className="dot" style={{ background: blockColor(fuelBlock(k)) }} />{u.name}</td><td>{u.producing} / {u.placed}</td>
                <td title={`raw ${fmt(u.rawHeating)} H/t`}>{fmt(u.effectiveHeating)}</td><td>{fmt(u.perHour, 1)} {s.fuelUnit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>)}

      <h3>Why it performs this way</h3>
      <ul className="insights">{ins.map((x, k) => <li key={k} className={x.tone}>{x.text}</li>)}</ul>

      <h3>Clusters</h3>
      <table className="tbl">
        <thead><tr><th>#</th><th>Fuel</th><th>Heat</th><th>Cooling</th><th>Net</th><th>Eff</th><th>Overcool</th><th>Wall</th></tr></thead>
        <tbody>
          {s.clusters.map((c) => (
            <tr key={c.id} className={c.netHeating > 0 ? 'badrow' : ''}>
              <td><i className="dot" style={{ background: clusterColor(c.id) }} />{c.id + 1}</td><td>{c.fuelCount}</td><td>{fmt(c.rawHeating)}</td><td>{fmt(c.cooling)}</td>
              <td>{c.netHeating > 0 ? '+' : ''}{fmt(c.netHeating)}</td><td>{c.fuelCount ? pct(c.meanEfficiency) : '—'}</td><td>{c.fuelCount ? `×${c.overcoolingEfficiencyFactor.toFixed(3)}` : '—'}</td><td>{c.connectedToWall ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {coolerGroups.size > 0 && (<>
        <h3>Cooling breakdown</h3>
        <table className="tbl">
          <thead><tr><th>Component</th><th>Count</th><th>Valid</th><th>Cooling H/t</th></tr></thead>
          <tbody>
            {[...coolerGroups.entries()].sort((a, b) => b[1].cooling - a[1].cooling).map(([name, g]) => (
              <tr key={name} className={g.valid < g.n ? 'warnrow' : ''}><td>{name}</td><td>{g.n}</td><td>{g.valid}</td><td>{fmt(g.cooling)}</td></tr>
            ))}
          </tbody>
        </table>
      </>)}

      {decay && (<>
        <h3>Decay heat &amp; poisoning</h3>
        <p className="muted">While running, decay heat is zero and neutron poison sits at its equilibrium, so the stats above already use the equilibrium criticality. After a shutdown:</p>
        <ul className="insights">
          <li className="info">Decay heat right after shutdown: <b>{fmt(decay.shutdownHeat)} H/t</b>, below 1% after ~{ticks(decay.decayHeatTicks)}{decay.clusters.some((c) => c.decayHeat > c.cooling) ? ' — more than the cooling of some cluster' : ''}.</li>
          {decay.restartBlocked
            ? <li className="warn">Restart blocked by poison from {ticks(decay.restartBlocked.fromTicks)} to {ticks(decay.restartBlocked.toTicks)} after a shutdown: some components would not reach the raised criticality with this layout's flux.</li>
            : <li className="good">Restart possible at any time after a shutdown: the flux stays above the poisoned criticality.</li>}
        </ul>
        <table className="tbl">
          <thead><tr><th>Fuel</th><th>Start-up</th><th>Running</th><th>Peak after shutdown</th></tr></thead>
          <tbody>{decay.fuels.map((f) => (
            <tr key={f.fuelId}><td>{f.name}</td><td>{f.startupCriticality}</td><td>{f.equilibriumCriticality}</td><td>{f.peakCriticality} <span className="muted">at {ticks(f.peakAfterTicks)}</span></td></tr>
          ))}</tbody>
        </table>
      </>)}

      {plan && (<>
        <h3>Neutron sources ({sourceName})</h3>
        {!plan.needed ? <p className="muted">{plan.selfPriming ? 'Fuel is self-priming: no sources needed.' : 'No running fuel to prime.'}</p> : (
          <>
            <p className="muted">{plan.sources.length} source(s) on the casing (magenta) prime every component; stats with source efficiency: <b>{fmt(plan.stats.effectiveHeating)} H/t</b>, {pct(plan.stats.meanEfficiency)}.</p>
            <div className="srclist">{plan.sources.map((p, k) => <span key={k}>wall ({p.wall.join(', ')}) facing {p.facing} → ({p.target.join(', ')})</span>)}</div>
          </>
        )}
      </>)}
    </div>
  );
}
