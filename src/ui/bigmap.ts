import type { Npc } from '../ai/traffic.ts';
import type { RoadGraph } from '../world/graph.ts';
import type { PlayerState } from '../vehicle/player.ts';
import type { MapPoint, Minimap } from './minimap.ts';

/** 미니맵을 누르거나 Tab 을 누르면 화면 가득 펼쳐지는 지도 */
export interface BigMap {
  readonly open: boolean;
  toggle(): void;
  draw(t: number, S: PlayerState, npcs: Npc[], target: MapPoint | null, extra: MapPoint[]): void;
}

export function createBigMap(root: HTMLElement, mini: Minimap, g: RoadGraph, placeOf: (x: number, z: number) => string): BigMap {
  const canvas = document.createElement('canvas');
  const label = document.createElement('div');
  label.className = 'bigmap-label';
  root.append(canvas, label);
  const ctx = canvas.getContext('2d')!;
  let open = false;
  const bg = mini.background;
  const { minX, maxX, minZ, maxZ } = g.bbox;

  function layout(): { scale: number; ox: number; oz: number } {
    const w = root.clientWidth;
    const h = root.clientHeight;
    canvas.width = w;
    canvas.height = h;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    const scale = Math.min((w - 40) / spanX, (h - 80) / spanZ);
    return { scale, ox: (w - spanX * scale) / 2, oz: (h - spanZ * scale) / 2 + 10 };
  }

  return {
    get open() {
      return open;
    },
    toggle() {
      open = !open;
      root.hidden = !open;
    },
    draw(t, S, npcs, target, extra) {
      if (!open) return;
      const { scale, ox, oz } = layout();
      const toView = (x: number, z: number): [number, number] => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
      ctx.fillStyle = '#0b0e16';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 미니맵 배경에서 지도 영역만 잘라 전체를 맞춰 그린다
      const bgScale = mini.scale;
      const [sx, sz] = mini.toBg(minX, minZ);
      ctx.drawImage(bg, sx, sz, (maxX - minX) * bgScale, (maxZ - minZ) * bgScale, ox, oz, (maxX - minX) * scale, (maxZ - minZ) * scale);
      const dot = (x: number, z: number, r: number, color: string) => {
        const [px, pz] = toView(x, z);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, pz, r, 0, Math.PI * 2);
        ctx.fill();
      };
      for (const p of extra) dot(p.x, p.z, (p.r ?? 4) + 2, p.color);
      for (const n of npcs) {
        if (n.police?.chasing) dot(n.x, n.z, 5, Math.floor(t * 6) % 2 ? '#ff3a3a' : '#3a6bff');
        else if (n.rival) dot(n.x, n.z, 5, n.rival.hex);
      }
      if (target) dot(target.x, target.z, 8 + Math.sin(t * 6) * 2, target.color);
      const [px, pz] = toView(S.x, S.z);
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(Math.atan2(Math.sin(S.h), -Math.cos(S.h)));
      ctx.fillStyle = '#ffae4a';
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(9, 10);
      ctx.lineTo(-9, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // 지명 라벨
      ctx.font = '600 13px "IBM Plex Sans KR", sans-serif';
      ctx.fillStyle = 'rgba(233,237,246,0.85)';
      ctx.textAlign = 'center';
      for (const p of g.map.places) {
        const [x, z] = toView(p.x, p.z);
        ctx.fillText(p.name, x, z);
      }
      label.textContent = `${placeOf(S.x, S.z)} · 미니맵 클릭 또는 Tab 으로 닫기`;
    },
  };
}
