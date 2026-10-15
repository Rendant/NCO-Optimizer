import type { BlockInfo, SourcePlacement } from '@ncopt/engine';
import { blockAbbr, blockName, textColor } from '../blocks';
import { cellLook, type ColorMode, type LayoutEntry } from '../model';

interface Props {
  layout: LayoutEntry; infos: Map<number, BlockInfo>; mode: ColorMode; maxEff: number; maxFlux: number;
  selected: number | null; onCell: (i: number, erase: boolean) => void; sources: SourcePlacement[]; editing: boolean;
}

/** Horizontal slices (Minecraft Y is vertical). Rows = Z (north at top), columns = X (west at left). */
export default function LayerGrid({ layout, infos, mode, maxEff, maxFlux, selected, onCell, sources, editing }: Props) {
  const [X, Y, Z] = layout.dims;
  const size = Math.max(16, Math.min(34, Math.floor(420 / Math.max(X, Z))));
  const srcSet = new Map<string, number>();
  for (const s of sources) {
    const [x, y, z] = s.wall;
    if (y >= 0 && y < Y) srcSet.set(`${y}:${x}:${z}`, 1);
  }
  const layers = Array.from({ length: Y }, (_, k) => Y - 1 - k);
  return (
    <div className="layers">
      {layers.map((y) => (
        <div className="layer" key={y}>
          <div className="layerhead">Layer y={y}{y === 0 ? ' (bottom)' : y === Y - 1 ? ' (top)' : ''}</div>
          <div className="lgrid" style={{ gridTemplateColumns: `repeat(${X + 2}, ${size}px)`, gridAutoRows: `${size}px`, fontSize: size < 22 ? 9 : 11 }}>
            {Array.from({ length: (Z + 2) * (X + 2) }, (_, k) => {
              const gx = (k % (X + 2)) - 1, gz = Math.floor(k / (X + 2)) - 1;
              if (gx < 0 || gz < 0 || gx >= X || gz >= Z) {
                const isSrc = srcSet.has(`${y}:${gx}:${gz}`);
                const corner = (gx < 0 || gx >= X) && (gz < 0 || gz >= Z);
                return <div key={k} className={`casing ${corner ? 'corner' : ''} ${isSrc ? 'src' : ''}`} title={isSrc ? 'Neutron source' : 'Casing'}>{isSrc ? 'S' : ''}</div>;
              }
              const i = gx + X * (y + Y * gz), b = layout.grid[i];
              const info = infos.get(i);
              if (b === 0) return <div key={k} className={`cell air ${selected === i ? 'sel' : ''} ${editing ? 'edit' : ''}`} onClick={() => onCell(i, false)} onContextMenu={(e) => { e.preventDefault(); onCell(i, true); }} title={`Air (${gx}, ${y}, ${gz})`} />;
              const look = cellLook(b, info, mode, maxEff, maxFlux, layout.reactor);
              return (
                <div key={k} className={`cell ${look.dim ? 'dim' : ''} ${selected === i ? 'sel' : ''} ${editing ? 'edit' : ''}`}
                  style={{ background: look.color, color: textColor(look.color) }}
                  onClick={() => onCell(i, false)} onContextMenu={(e) => { e.preventDefault(); onCell(i, true); }}
                  title={`${blockName(b, layout.reactor)} (${gx}, ${y}, ${gz})${info && !info.active ? ' — inactive' : ''}`}>
                  {blockAbbr(b, layout.reactor)}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
