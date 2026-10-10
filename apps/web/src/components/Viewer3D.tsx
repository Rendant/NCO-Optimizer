import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import type { BlockInfo, SourcePlacement } from '@ncopt/engine';
import { blockName } from '../blocks';
import { cellLook, type ColorMode, type LayoutEntry } from '../model';

interface Props {
  layout: LayoutEntry; infos: Map<number, BlockInfo>; mode: ColorMode; maxEff: number; maxFlux: number;
  selected: number | null; onSelect: (i: number | null) => void; sources: SourcePlacement[];
  cut: { axis: 'x' | 'y' | 'z'; max: number }; hideInactive: boolean; hideAirlike: Set<string>;
}

const box = new THREE.BoxGeometry(0.92, 0.92, 0.92);

function Blocks({ items, transparent, onPick, onHover }: { items: { i: number; pos: [number, number, number]; color: string }[]; transparent: boolean; onPick: (i: number) => void; onHover: (i: number | null) => void }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current; if (!m) return;
    const o = new THREE.Object3D(), c = new THREE.Color();
    items.forEach((it, k) => { o.position.set(...it.pos); o.updateMatrix(); m.setMatrixAt(k, o.matrix); m.setColorAt(k, c.set(it.color)); });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh key={items.length} ref={ref} args={[box, undefined, items.length]}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.instanceId != null) onPick(items[e.instanceId].i); }}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); if (e.instanceId != null) onHover(items[e.instanceId].i); }}
      onPointerOut={() => onHover(null)}>
      <meshStandardMaterial transparent={transparent} opacity={transparent ? 0.18 : 1} depthWrite={!transparent} roughness={0.6} metalness={0.05} />
    </instancedMesh>
  );
}

export default function Viewer3D({ layout, infos, mode, maxEff, maxFlux, selected, onSelect, sources, cut, hideInactive, hideAirlike }: Props) {
  const [X, Y, Z] = layout.dims;
  const [hover, setHover] = useState<number | null>(null);
  const center = (x: number, y: number, z: number): [number, number, number] => [x - (X - 1) / 2, y - (Y - 1) / 2, z - (Z - 1) / 2];
  const { solid, ghost } = useMemo(() => {
    const solid: { i: number; pos: [number, number, number]; color: string }[] = [];
    const ghost: typeof solid = [];
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      const v = cut.axis === 'x' ? x : cut.axis === 'y' ? y : z;
      if (v > cut.max) continue;
      const i = x + X * (y + Y * z), b = layout.grid[i];
      if (b === 0) continue;
      const info = infos.get(i);
      if (info && hideAirlike.has(info.category)) continue;
      const look = cellLook(b, info, mode, maxEff, maxFlux);
      if (look.dim && hideInactive) continue;
      (look.dim ? ghost : solid).push({ i, pos: center(x, y, z), color: look.color });
    }
    return { solid, ghost };
  }, [layout, infos, mode, maxEff, maxFlux, cut, hideInactive, hideAirlike]);

  const sel = selected != null ? (() => { const x = selected % X, y = Math.floor(selected / X) % Y, z = Math.floor(selected / (X * Y)); return center(x, y, z); })() : null;
  const dist = Math.max(X, Y, Z) * 1.9 + 4;
  const hoverInfo = hover != null ? infos.get(hover) : undefined;

  return (
    <div className="viewer3d">
      <Canvas camera={{ position: [dist * 0.8, dist * 0.65, dist], fov: 45 }} onPointerMissed={() => onSelect(null)} dpr={[1, 2]}>
        <color attach="background" args={['#0b0f17']} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[10, 20, 14]} intensity={1.1} />
        <directionalLight position={[-12, -6, -10]} intensity={0.35} />
        <Blocks items={solid} transparent={false} onPick={onSelect} onHover={setHover} />
        <Blocks items={ghost} transparent onPick={onSelect} onHover={setHover} />
        {/* casing outline */}
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(X + 0.2, Y + 0.2, Z + 0.2)]} />
          <lineBasicMaterial color="#64748b" />
        </lineSegments>
        {sources.map((s, k) => (
          <mesh key={k} position={center(...s.wall)}>
            <sphereGeometry args={[0.22, 12, 12]} />
            <meshStandardMaterial color="#e879f9" emissive="#a21caf" emissiveIntensity={0.6} />
          </mesh>
        ))}
        {sel && (
          <lineSegments position={sel}>
            <edgesGeometry args={[new THREE.BoxGeometry(1.04, 1.04, 1.04)]} />
            <lineBasicMaterial color="#ffffff" linewidth={2} />
          </lineSegments>
        )}
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#fff" />
        </GizmoHelper>
      </Canvas>
      {hover != null && (
        <div className="hovertip">
          {blockName(layout.grid[hover], layout.reactor)} @ ({hover % X}, {Math.floor(hover / X) % Y}, {Math.floor(hover / (X * Y))})
          {hoverInfo && !hoverInfo.active && <span className="bad"> · inactive</span>}
          {hoverInfo?.fuel?.running && <span> · eff {(hoverInfo.fuel.efficiency * 100).toFixed(1)}%</span>}
        </div>
      )}
    </div>
  );
}
