import type { BlockInfo, ReactorType } from '@ncopt/engine';
import { fmt, pct } from '../model';
import { blockColor } from '../blocks';

export default function Inspector({ info, onJump, air, reactor }: { info: BlockInfo | null; onJump: (pos: [number, number, number]) => void; air?: [number, number, number]; reactor: ReactorType }) {
  if (!info && air) return <div className="panel inspector"><b>Air</b> <span className="muted">({air.join(', ')})</span><p className="muted">Empty interior space. Air does not count as a functional part, so it contributes to the sparsity penalty when more than 25% of the interior is non-functional.</p></div>;
  if (!info) return <div className="panel inspector muted">Click a block in the 3D or layer view to see exactly how the simulator evaluated it.</div>;
  return (
    <div className="panel inspector">
      <div className="ihead">
        <i style={{ background: blockColor(info.block, reactor) }} />
        <div><b>{info.name}</b><div className="muted">({info.pos.join(', ')}) · {info.active ? <span className="ok">active</span> : <span className="bad">inactive</span>}{info.cluster >= 0 && ` · cluster ${info.cluster + 1}`}</div></div>
      </div>
      {info.fuel && (
        <>
          <dl className="kv">
            <dt>Fuel</dt><dd>{info.fuel.fuelName}</dd>
            <dt>Status</dt><dd>{info.fuel.running ? 'critical (running)' : 'not critical'}</dd>
            <dt>Flux / threshold</dt><dd>{info.fuel.flux} / {info.fuel.criticalityThreshold}</dd>
            <dt>Heat multiplier</dt><dd>×{info.fuel.heatMult}</dd>
            <dt>Raw heat</dt><dd>{fmt(info.fuel.rawHeating)} H/t</dd>
            <dt>Efficiency</dt><dd>{pct(info.fuel.efficiency)}</dd>
            <dt>· moderator lines</dt><dd>×{info.fuel.moderatorEfficiencyFactor.toFixed(4)}</dd>
            <dt>· flux factor</dt><dd>×{info.fuel.fluxEfficiencyFactor.toFixed(4)}</dd>
            <dt>· source</dt><dd>×{info.fuel.sourceEfficiency}</dd>
            <dt>Effective heat</dt><dd>{fmt(info.fuel.effectiveHeating, 1)} H/t</dd>
            {info.fuel.bunch.size > 1 && (<><dt>Bunch</dt><dd>{info.fuel.bunch.size} vessels · flux {info.fuel.bunch.flux} · surface ×{info.fuel.bunch.surfaceFactor} · bunching ×{info.fuel.bunch.bunchingFactor}</dd></>)}
          </dl>
          <h4>Moderator lines ({info.fuel.lines.length})</h4>
          {info.fuel.lines.length === 0 ? <p className="muted">None.</p> : (
            <table className="tbl small">
              <thead><tr><th>Dir</th><th>To</th><th>Len</th><th>Flux</th><th>Eff</th></tr></thead>
              <tbody>{info.fuel.lines.map((l, k) => (
                <tr key={k} className={l.incoming ? '' : 'warnrow'}>
                  <td>{l.dir}</td><td><a onClick={() => onJump(l.partner)}>{l.kind}{l.intrinsic ? ' (intrinsic)' : ''} ({l.partner.join(',')})</a></td>
                  <td>{l.length}</td><td>{l.flux}</td><td>{l.efficiency.toFixed(3)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
      {info.moderator && (
        <dl className="kv">
          <dt>State</dt><dd>{info.moderator.state}</dd><dt>Flux factor</dt><dd>{info.moderator.fluxFactor}</dd><dt>Efficiency</dt><dd>{info.moderator.efficiency}</dd>
        </dl>
      )}
      {info.reflector && (
        <dl className="kv"><dt>Reflectivity</dt><dd>{info.reflector.reflectivity}</dd><dt>Efficiency</dt><dd>{info.reflector.efficiency}</dd></dl>
      )}
      {info.shield && (
        <dl className="kv">
          <dt>Status</dt><dd>{info.shield.functional ? 'in a complete moderator line' : info.shield.failed ? 'failed (blocks its lines)' : 'not in a complete line'}</dd>
          <dt>Flux</dt><dd>{info.shield.flux}{info.shield.axes.length > 1 ? ` (${info.shield.axes.map((a) => `${a.axis} ${a.flux}`).join(' + ')})` : ''}</dd>
          <dt>Heat</dt><dd>{fmt(info.shield.rawHeating)} H/t raw · {fmt(info.shield.effectiveHeating, 1)} effective ({info.shield.heatPerFlux} H/t per flux × {info.shield.efficiency})</dd>
          <dt>Line efficiency</dt><dd>{info.shield.efficiency} (flux factor 0)</dd>
        </dl>
      )}
      {info.irradiator && (
        <dl className="kv">
          <dt>Recipe</dt><dd>{info.irradiator.recipe}</dd>
          <dt>Flux</dt><dd>{info.irradiator.flux} from {info.irradiator.lines} line(s)</dd>
          <dt>Output</dt><dd>{fmt(info.irradiator.itemsPerHour, 2)} items/h</dd>
          <dt>Line efficiency</dt><dd>×{info.irradiator.efficiency}</dd>
        </dl>
      )}
      {info.cooler && (
        <>
          <dl className="kv"><dt>Rule</dt><dd>“{info.cooler.rule}”</dd><dt>Cooling</dt><dd>{info.cooler.valid ? info.cooler.cooling : 0} H/t</dd></dl>
          <ul className="conds">{info.cooler.conditions.map((c, k) => <li key={k} className={c.ok ? 'ok' : 'bad'}>{c.ok ? '✓' : '✗'} {c.text} <span className="muted">({c.matches} adjacent match{c.matches === 1 ? '' : 'es'})</span></li>)}</ul>
          {info.cooler.failedRecheck && <p className="bad">Failed the exact/at-most recheck after neighbours were invalidated.</p>}
        </>
      )}
      {info.notes.length > 0 && <ul className="notes">{info.notes.map((n, k) => <li key={k}>{n}</li>)}</ul>}
    </div>
  );
}
