import type { Npc } from '../ai/traffic.ts';
import type { RoadGraph } from '../world/graph.ts';
import type { MapData } from '../world/mapdata.ts';
import type { PlayerState } from '../vehicle/player.ts';

export interface MapPoint {
  x: number;
  z: number;
  color: string;
  r?: number;
}

export interface Minimap {
  draw(t: number, S: PlayerState, npcs: Npc[], target: MapPoint | null, extra: MapPoint[]): void;
  /** 미리 그려 둔 전체 지도 (큰 지도에서 재사용) */
  readonly background: HTMLCanvasElement;
  readonly scale: number;
  toBg(x: number, z: number): [number, number];
}

/** 플레이어 중심으로 따라오는 북쪽 고정 미니맵. 지도는 한 번만 그려 두고 잘라 쓴다 */
export function createMinimap(canvas: HTMLCanvasElement, map: MapData, g: RoadGraph): Minimap {
  const ctx = canvas.getContext('2d')!;
  const MM = canvas.width;
  const SCALE = 0.6; // px / m
  const { minX, maxX, minZ, maxZ } = g.bbox;
  const PAD = MM;
  const bg = document.createElement('canvas');
  bg.width = Math.ceil((maxX - minX) * SCALE + PAD * 2);
  bg.height = Math.ceil((maxZ - minZ) * SCALE + PAD * 2);
  const b = bg.getContext('2d')!;
  const tx = (x: number) => (x - minX) * SCALE + PAD;
  const tz = (z: number) => (z - minZ) * SCALE + PAD;

  b.fillStyle = '#0b0e16';
  b.fillRect(0, 0, bg.width, bg.height);
  const poly = (ring: number[]) => {
    b.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      if (i === 0) b.moveTo(tx(ring[i]), tz(ring[i + 1]));
      else b.lineTo(tx(ring[i]), tz(ring[i + 1]));
    }
    b.closePath();
    b.fill();
  };
  b.fillStyle = '#0e2a52';
  for (const r of map.water) poly(r);
  b.fillStyle = '#1c3a28';
  for (const r of map.parks) poly(r);
  b.fillStyle = '#1a1f2e';
  for (const bd of map.buildings) poly(bd.ring);
  b.lineCap = 'round';
  b.lineJoin = 'round';
  for (const e of g.edges) {
    b.strokeStyle = e.rank <= 2 ? '#5a6075' : e.rank <= 4 ? '#474c5e' : '#353a4a';
    b.lineWidth = Math.max(1.5, e.width * SCALE);
    b.beginPath();
    b.moveTo(tx(e.pts[0]), tz(e.pts[1]));
    for (let i = 2; i < e.pts.length; i += 2) b.lineTo(tx(e.pts[i]), tz(e.pts[i + 1]));
    b.stroke();
  }

  return {
    background: bg,
    scale: SCALE,
    toBg: (x, z) => [tx(x), tz(z)],
    draw(t, S, npcs, target, extra) {
      const sx = tx(S.x) - MM / 2;
      const sz = tz(S.z) - MM / 2;
      ctx.drawImage(bg, sx, sz, MM, MM, 0, 0, MM, MM);
      const toView = (x: number, z: number): [number, number] => [(x - S.x) * SCALE + MM / 2, (z - S.z) * SCALE + MM / 2];
      const dot = (x: number, z: number, r: number, color: string) => {
        const [px, pz] = toView(x, z);
        if (px < -10 || pz < -10 || px > MM + 10 || pz > MM + 10) return;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, pz, r, 0, Math.PI * 2);
        ctx.fill();
      };
      for (const p of extra) dot(p.x, p.z, p.r ?? 4, p.color);
      for (const n of npcs) {
        const chasing = n.police?.chasing;
        const bus = n.kind.length > 6;
        const color = chasing
          ? Math.floor(t * 6) % 2 ? '#ff3a3a' : '#3a6bff'
          : n.rival ? n.rival.hex : bus ? `#${n.kind.colors[0].toString(16).padStart(6, '0')}` : 'rgba(200,206,220,0.6)';
        dot(n.x, n.z, n.rival || chasing ? 5 : bus ? 3.5 : 2.5, color);
      }
      if (target) {
        const [px, pz] = toView(target.x, target.z);
        const dx = px - MM / 2;
        const dz = pz - MM / 2;
        const d = Math.hypot(dx, dz);
        if (d > MM / 2 - 12) {
          // 화면 밖이면 가장자리에 화살표
          const k = (MM / 2 - 12) / d;
          ctx.save();
          ctx.translate(MM / 2 + dx * k, MM / 2 + dz * k);
          ctx.rotate(Math.atan2(dx, -dz));
          ctx.fillStyle = target.color;
          ctx.beginPath();
          ctx.moveTo(0, -9);
          ctx.lineTo(7, 6);
          ctx.lineTo(-7, 6);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else dot(target.x, target.z, 7 + Math.sin(t * 6) * 2, target.color);
      }
      ctx.save();
      ctx.translate(MM / 2, MM / 2);
      // 진행 방향 (sin h, cos h) → 화면에서 x 오른쪽, z 아래
      ctx.rotate(Math.atan2(Math.sin(S.h), -Math.cos(S.h)));
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
