import { BLOCK, HALF, N, ROAD, roadAt } from '../config.ts';
import type { Npc } from '../ai/traffic.ts';
import type { City } from '../world/city.ts';
import type { PlayerState } from '../vehicle/player.ts';

export interface Minimap {
  draw(t: number, S: PlayerState, npcs: Npc[], target: { x: number; z: number }, battle: boolean): void;
}

export function createMinimap(canvas: HTMLCanvasElement, city: City): Minimap {
  const g = canvas.getContext('2d')!;
  const MM = canvas.width;
  const MS = MM / (2 * (HALF + ROAD));
  const toMap = (x: number, z: number): [number, number] => [MM / 2 - x * MS, MM / 2 - z * MS];

  // 도로와 블록은 바뀌지 않으니 한 번만 그려 둔다
  const bg = document.createElement('canvas');
  bg.width = bg.height = MM;
  const bgCtx = bg.getContext('2d')!;
  bgCtx.fillStyle = '#3a3f4e';
  bgCtx.fillRect(0, 0, MM, MM);
  for (let bx = 0; bx < N; bx++) {
    for (let bz = 0; bz < N; bz++) {
      const x0 = roadAt(bx) + ROAD / 2;
      const z0 = roadAt(bz) + ROAD / 2;
      const [a, b] = toMap(x0 + BLOCK, z0 + BLOCK);
      const isPark = city.parks.some((p) => p.x0 === x0 && p.z0 === z0);
      bgCtx.fillStyle = isPark ? '#1c3a28' : '#141824';
      bgCtx.fillRect(a, b, BLOCK * MS, BLOCK * MS);
    }
  }

  return {
    draw(t, S, npcs, target, battle) {
      g.drawImage(bg, 0, 0);
      for (const n of npcs) {
        const [nx, nz] = toMap(n.x, n.z);
        const bus = n.kind.length > 6;
        g.fillStyle = n.rival ? n.rival.hex : bus ? `#${n.kind.colors[0].toString(16).padStart(6, '0')}` : 'rgba(200,206,220,0.55)';
        g.beginPath();
        g.arc(nx, nz, n.rival ? 5 : bus ? 3.5 : 2.5, 0, Math.PI * 2);
        g.fill();
      }
      const [tx, tz] = toMap(target.x, target.z);
      g.fillStyle = battle ? '#ffae4a' : '#4fd1ff';
      g.beginPath();
      g.arc(tx, tz, 7 + Math.sin(t * 6) * 2, 0, Math.PI * 2);
      g.fill();
      const [cx, cz] = toMap(S.x, S.z);
      g.save();
      g.translate(cx, cz);
      g.rotate(-S.h);
      g.fillStyle = '#ffae4a';
      g.beginPath();
      g.moveTo(0, -11);
      g.lineTo(8, 9);
      g.lineTo(-8, 9);
      g.closePath();
      g.fill();
      g.restore();
    },
  };
}
