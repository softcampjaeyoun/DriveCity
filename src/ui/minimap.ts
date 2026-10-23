import type { Npc } from '../ai/traffic.ts';
import type { RoadGraph } from '../world/graph.ts';
import type { TileData } from '../world/mapdata.ts';
import type { PlayerState } from '../vehicle/player.ts';

export interface MapPoint {
  x: number;
  z: number;
  color: string;
  r?: number;
}

export interface Minimap {
  draw(t: number, S: PlayerState, npcs: Npc[], target: MapPoint | null, extra: MapPoint[], route?: number[]): void;
  addTile(key: string, tile: TileData): void;
  removeTile(key: string): void;
  /** px / m */
  readonly scale: number;
}

/** 플레이어 중심으로 따라오는 북쪽 고정 미니맵. 타일마다 지도를 미리 그려 두고 잘라 쓴다 */
export function createMinimap(canvas: HTMLCanvasElement, g: RoadGraph): Minimap {
  const ctx = canvas.getContext('2d')!;
  const MM = canvas.width;
  const SCALE = 0.6;
  const T = g.index.tile;
  const { minX, minZ } = g.bbox;
  const tiles = new Map<string, { canvas: HTMLCanvasElement; x0: number; z0: number }>();

  function renderTile(tile: TileData): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = Math.ceil(T * SCALE);
    const b = c.getContext('2d')!;
    const x0 = minX + tile.i * T;
    const z0 = minZ + tile.j * T;
    const tx = (x: number) => (x - x0) * SCALE;
    const tz = (z: number) => (z - z0) * SCALE;
    b.fillStyle = '#0b0e16';
    b.fillRect(0, 0, c.width, c.height);
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
    for (const r of tile.water) poly(r);
    b.fillStyle = '#1c3a28';
    for (const r of tile.parks) poly(r);
    b.fillStyle = '#1a1f2e';
    for (const bd of tile.buildings) poly(bd.ring);
    b.lineCap = 'round';
    b.lineJoin = 'round';
    for (const d of tile.edges) {
      const e = g.edge(d.id);
      if (!e) continue;
      b.strokeStyle = e.rank <= 2 ? '#5a6075' : e.rank <= 4 ? '#474c5e' : '#353a4a';
      b.lineWidth = Math.max(1.5, e.width * SCALE);
      b.beginPath();
      b.moveTo(tx(e.pts[0]), tz(e.pts[1]));
      for (let i = 2; i < e.pts.length; i += 2) b.lineTo(tx(e.pts[i]), tz(e.pts[i + 1]));
      b.stroke();
    }
    return c;
  }

  return {
    scale: SCALE,
    addTile(key, tile) {
      if (tiles.has(key)) return;
      tiles.set(key, { canvas: renderTile(tile), x0: minX + tile.i * T, z0: minZ + tile.j * T });
    },
    removeTile(key) {
      tiles.delete(key);
    },
    draw(t, S, npcs, target, extra, route) {
      ctx.fillStyle = '#0b0e16';
      ctx.fillRect(0, 0, MM, MM);
      const toView = (x: number, z: number): [number, number] => [(x - S.x) * SCALE + MM / 2, (z - S.z) * SCALE + MM / 2];
      for (const tl of tiles.values()) {
        const [vx, vz] = toView(tl.x0, tl.z0);
        if (vx > MM || vz > MM || vx + tl.canvas.width < 0 || vz + tl.canvas.height < 0) continue;
        ctx.drawImage(tl.canvas, vx, vz);
      }
      const dot = (x: number, z: number, r: number, color: string) => {
        const [px, pz] = toView(x, z);
        if (px < -10 || pz < -10 || px > MM + 10 || pz > MM + 10) return;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, pz, r, 0, Math.PI * 2);
        ctx.fill();
      };
      if (route && route.length >= 4) {
        ctx.strokeStyle = 'rgba(255,95,168,0.9)';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < route.length; i += 2) {
          const [x, z] = toView(route[i], route[i + 1]);
          if (i === 0) ctx.moveTo(x, z);
          else ctx.lineTo(x, z);
        }
        ctx.stroke();
      }
      for (const p of extra) dot(p.x, p.z, p.r ?? 4, p.color);
      for (const n of npcs) {
        const chasing = n.police?.chasing;
        const bus = n.kind.length > 6;
        const color = chasing ? (Math.floor(t * 6) % 2 ? '#ff3a3a' : '#3a6bff') : n.rival ? n.rival.hex : bus ? `#${n.kind.colors[0].toString(16).padStart(6, '0')}` : 'rgba(200,206,220,0.6)';
        dot(n.x, n.z, n.rival || chasing ? 5 : bus ? 3.5 : 2.5, color);
      }
      if (target) {
        const [px, pz] = toView(target.x, target.z);
        const dx = px - MM / 2;
        const dz = pz - MM / 2;
        const d = Math.hypot(dx, dz);
        if (d > MM / 2 - 12) {
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
