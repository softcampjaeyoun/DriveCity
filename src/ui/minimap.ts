import { EDGE } from '../config.ts';
import type { Npc } from '../ai/traffic.ts';
import type { District, RoadGraph } from '../world/graph.ts';
import type { PlayerState } from '../vehicle/player.ts';

export interface MapPoint {
  x: number;
  z: number;
  color: string;
  r?: number;
}

export interface Minimap {
  draw(t: number, S: PlayerState, npcs: Npc[], target: MapPoint | null, extra: MapPoint[]): void;
}

const DISTRICT_COLOR: Record<District, string> = {
  cbd: '#1a2238',
  old: '#2a1f26',
  mixed: '#141824',
  park: '#1c3a28',
  water: '#0e2a52',
};

export function createMinimap(canvas: HTMLCanvasElement, g: RoadGraph): Minimap {
  const ctx = canvas.getContext('2d')!;
  const MM = canvas.width;
  const span = Math.max(g.maxX - g.minX, g.maxZ - g.minZ) + 2 * EDGE;
  const MS = MM / span;
  const cx = (g.minX + g.maxX) / 2;
  const cz = (g.minZ + g.maxZ) / 2;
  const toMap = (x: number, z: number): [number, number] => [MM / 2 - (x - cx) * MS, MM / 2 - (z - cz) * MS];

  // 도로·블록·강은 바뀌지 않으니 한 번만 그려 둔다
  const bg = document.createElement('canvas');
  bg.width = bg.height = MM;
  const b = bg.getContext('2d')!;
  b.fillStyle = '#0b0e16';
  b.fillRect(0, 0, MM, MM);
  const [x0, z0] = toMap(g.maxX, g.maxZ);
  b.fillStyle = '#3a3f4e';
  b.fillRect(x0, z0, (g.maxX - g.minX) * MS, (g.maxZ - g.minZ) * MS);
  for (const blk of g.blocks) {
    const [a, c] = toMap(blk.x0 + blk.w, blk.z0 + blk.d);
    b.fillStyle = DISTRICT_COLOR[blk.district];
    b.fillRect(a, c, blk.w * MS, blk.d * MS);
  }
  // 다리가 없는 열의 강 구간은 도로가 아니라 물
  for (let i = 0; i < g.nx; i++) {
    if (g.bridges.includes(i)) continue;
    const [a, c] = toMap(g.xs[i] + EDGE, g.river.z1);
    b.fillStyle = DISTRICT_COLOR.water;
    b.fillRect(a, c, 2 * EDGE * MS, (g.river.z1 - g.river.z0) * MS);
  }

  return {
    draw(t, S, npcs, target, extra) {
      ctx.drawImage(bg, 0, 0);
      for (const p of extra) {
        const [px, pz] = toMap(p.x, p.z);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, pz, p.r ?? 4, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const n of npcs) {
        const [nx, nz] = toMap(n.x, n.z);
        const bus = n.kind.length > 6;
        const chasing = n.police?.chasing;
        ctx.fillStyle = chasing
          ? Math.floor(t * 6) % 2 ? '#ff3a3a' : '#3a6bff'
          : n.rival
            ? n.rival.hex
            : bus
              ? `#${n.kind.colors[0].toString(16).padStart(6, '0')}`
              : 'rgba(200,206,220,0.55)';
        ctx.beginPath();
        ctx.arc(nx, nz, n.rival || chasing ? 5 : bus ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (target) {
        const [tx, tz] = toMap(target.x, target.z);
        ctx.fillStyle = target.color;
        ctx.beginPath();
        ctx.arc(tx, tz, 7 + Math.sin(t * 6) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      const [px, pz] = toMap(S.x, S.z);
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(-S.h);
      ctx.fillStyle = '#ffae4a';
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(8, 9);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },
  };
}
