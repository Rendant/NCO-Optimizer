import type { LibraryEntry } from '../api';
import { fmt, pct } from '../model';

interface Props {
  entries: LibraryEntry[] | null; label: string; breeding?: boolean;
  onLoad: (e: LibraryEntry) => void; onImprove: (e: LibraryEntry) => void; onDelete: (e: LibraryEntry) => void; running: boolean;
}

/** Best saved layouts (server-side library) for the current size / fuel / coolant / objective. */
export default function LibraryPanel({ entries, label, breeding, onLoad, onImprove, onDelete, running }: Props) {
  return (
    <div className="panel library">
      <h3>Library <span className="muted small">{label}</span></h3>
      {!entries ? <p className="muted small">Loading…</p> : !entries.length ? (
        <p className="muted small">No saved layouts for this configuration yet. Finished runs are saved automatically and seed future runs.</p>
      ) : (
        <table className="tbl libtbl">
          <tbody>
            {entries.map((e, k) => (
              <tr key={e.id} className={e.compatible === false ? 'dim' : ''} title={e.compatible === false ? 'Uses blocks that are not allowed in the current configuration (not used as a seed)' : `${e.fuelComponents} fuel components · saved ${new Date(e.createdAt).toLocaleString()}`}>
                <td>#{k + 1}</td>
                {breeding && <td><b>{fmt(e.fuelPerHour ?? 0, 1)}</b>/h</td>}
                <td>{breeding ? fmt(e.effectiveHeating) : <b>{fmt(e.effectiveHeating)}</b>} H/t</td>
                {!breeding && <td>{pct(e.meanEfficiency)}</td>}
                <td className="rowact">
                  <button className="mini" onClick={() => onLoad(e)} title="Open in the viewer / compare list">Open</button>
                  <button className="mini" disabled={running} onClick={() => onImprove(e)} title="Run the optimizer starting from this layout">Improve</button>
                  <button className="mini" onClick={() => onDelete(e)} title="Delete from library">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
