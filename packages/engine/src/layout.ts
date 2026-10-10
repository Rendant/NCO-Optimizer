/** Serializable layout format shared by the API and UI. */
import { ReactorType } from './components.js';
import { blockKey, blockFromKey } from './blocks.js';

export interface LayoutJSON {
  format: 'ncopt-layout';
  version: 1;
  reactor: ReactorType;
  fuelId: string;
  /** Multi-fuel layouts: fuel per slot (fuelIds[0] = fuelId); block "cell_2" / "vessel_2" holds fuelIds[1], etc. */
  fuelIds?: string[];
  sfrCoolant?: string;
  dims: [number, number, number];
  /** blocks[z][y][x] as block keys */
  blocks: string[][][];
}

export function toLayoutJSON(grid: ArrayLike<number>, dims: [number, number, number], reactor: ReactorType, fuelId: string, sfrCoolant?: string, fuelIds?: string[]): LayoutJSON {
  const [X, Y, Z] = dims;
  const blocks: string[][][] = [];
  for (let z = 0; z < Z; z++) {
    const layer: string[][] = [];
    for (let y = 0; y < Y; y++) {
      const row: string[] = [];
      for (let x = 0; x < X; x++) row.push(blockKey(grid[x + X * (y + Y * z)], reactor));
      layer.push(row);
    }
    blocks.push(layer);
  }
  const multi = fuelIds && fuelIds.length > 1 ? { fuelIds } : {};
  return { format: 'ncopt-layout', version: 1, reactor, fuelId, ...multi, sfrCoolant, dims, blocks };
}

export function fromLayoutJSON(l: LayoutJSON): Uint8Array {
  const [X, Y, Z] = l.dims;
  const g = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) g[x + X * (y + Y * z)] = blockFromKey(l.blocks[z][y][x], l.reactor);
  return g;
}
