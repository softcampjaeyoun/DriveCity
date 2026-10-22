import { isFlat, type RoadGraph } from './graph.ts';
import type { TileData } from './mapdata.ts';

export interface Circle {
  x: number;
  z: number;
  r: number;
  /** 차 높이. 고가 위(지면 장애물 무시)나 지하차도 안(건물 무시) 판단용. 기본 0 */
  y?: number;
}

export interface PushResult {
  dx: number;
  dz: number;
  nx: number;
  nz: number;
}

/** 가로등·신호등 기둥·나무 줄기(원) 또는 가드레일(선분) 같은 작은 장애물. y 는 놓인 노면 높이(기본 0) */
export type Obstacle = ({ x: number; z: number; r: number } | { x0: number; z0: number; x1: number; z1: number; r: number }) & { y?: number };

/** 건물·물 폴리곤과 작은 장애물 충돌. 타일 단위로 넣고 뺀다 */
export interface CollisionWorld {
  /** 원이 건물·장애물에 겹치면 밀어낼 벡터와 법선. 없으면 null. obstacles=false 면 건물만 (카메라용) */
  push(c: Circle, obstacles?: boolean): PushResult | null;
  /** 물 위이고 다리 위가 아니면 true */
  inWater(x: number, z: number, y?: number): boolean;
  addTile(key: string, tile: TileData, obstacles: Obstacle[]): void;
  removeTile(key: string): void;
}

interface Poly {
  ring: number[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  tile: string;
}
interface Obs {
  o: Obstacle;
  tile: string;
}

const CELL = 32;

function makePoly(ring: number[], tile: string): Poly {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]);
    maxZ = Math.max(maxZ, ring[i + 1]);
  }
  return { ring, minX, maxX, minZ, maxZ, tile };
}

export function pointInRing(ring: number[], x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function nearestOnRing(ring: number[], x: number, z: number): { d: number; px: number; pz: number } {
  let best = { d: Infinity, px: 0, pz: 0 };
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2];
    const z0 = ring[i * 2 + 1];
    const dx = ring[j * 2] - x0;
    const dz = ring[j * 2 + 1] - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { d, px, pz };
  }
  return best;
}

export function createCollisionWorld(g: RoadGraph): CollisionWorld {
  const grid = new Map<string, Poly[]>();
  const obsGrid = new Map<string, Obs[]>();
  const waterByTile = new Map<string, Poly[]>();
  const cellsOf = (minX: number, maxX: number, minZ: number, maxZ: number): string[] => {
    const out: string[] = [];
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) out.push(`${cx},${cz}`);
    return out;
  };
  const addPoly = (p: Poly) => {
    for (const k of cellsOf(p.minX, p.maxX, p.minZ, p.maxZ)) {
      const list = grid.get(k) ?? [];
      list.push(p);
      grid.set(k, list);
    }
  };
  const addObs = (o: Obstacle, tile: string) => {
    const xs = 'x' in o ? [o.x] : [o.x0, o.x1];
    const zs = 'z' in o ? [o.z] : [o.z0, o.z1];
    for (const k of cellsOf(Math.min(...xs) - o.r, Math.max(...xs) + o.r, Math.min(...zs) - o.r, Math.max(...zs) + o.r)) {
      const list = obsGrid.get(k) ?? [];
      list.push({ o, tile });
      obsGrid.set(k, list);
    }
  };

  function pushObstacle(c: Circle): PushResult | null {
    const seen = new Set<Obstacle>();
    const cy = c.y ?? 0;
    for (const k of cellsOf(c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r)) {
      for (const { o } of obsGrid.get(k) ?? []) {
        if (seen.has(o)) continue;
        seen.add(o);
        // 다른 높이(고가 위 vs 지면)의 장애물은 지나친다
        if (Math.abs((o.y ?? 0) - cy) > 3) continue;
        let px: number;
        let pz: number;
        if ('x' in o) {
          px = o.x;
          pz = o.z;
        } else {
          const dx = o.x1 - o.x0;
          const dz = o.z1 - o.z0;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.min(1, Math.max(0, ((c.x - o.x0) * dx + (c.z - o.z0) * dz) / l2));
          px = o.x0 + dx * t;
          pz = o.z0 + dz * t;
        }
        let nx = c.x - px;
        let nz = c.z - pz;
        const d = Math.hypot(nx, nz);
        const minD = c.r + o.r;
        if (d >= minD) continue;
        if (d < 1e-4) {
          nx = 1;
          nz = 0;
        } else {
          nx /= d;
          nz /= d;
        }
        const depth = minD - d;
        return { dx: nx * depth, dz: nz * depth, nx, nz };
      }
    }
    return null;
  }

  return {
    addTile(key, tile, obstacles) {
      for (const b of tile.buildings) addPoly(makePoly(b.ring, key));
      // 고가·다리 난간과 지하차도 옹벽: 높이를 따라가도록 20m 이하로 잘라 넣는다
      for (const d of tile.edges) {
        const e = g.edge(d.id);
        if (!e || isFlat(e)) continue;
        const sunken = e.yt < 0 || Math.min(e.ya, e.yb) < 0;
        const off = sunken ? e.half + 0.7 : e.half + 0.9;
        for (let i = 0; i < e.pts.length - 2; i += 2) {
          const x0 = e.pts[i];
          const z0 = e.pts[i + 1];
          const x1 = e.pts[i + 2];
          const z1 = e.pts[i + 3];
          const l = Math.hypot(x1 - x0, z1 - z0) || 1;
          const nx = -(z1 - z0) / l;
          const nz = (x1 - x0) / l;
          const parts = Math.max(1, Math.ceil(l / 20));
          for (let p = 0; p < parts; p++) {
            const t0 = p / parts;
            const t1 = (p + 1) / parts;
            const y = g.heightAt(e, e.cum[i / 2] + (l * (t0 + t1)) / 2);
            // 지하차도 옹벽은 노면이 지면 아래로 내려간 곳에만
            if (sunken && y > -0.25) continue;
            for (const side of [-1, 1]) {
              const ox = nx * off * side;
              const oz = nz * off * side;
              addObs({ x0: x0 + (x1 - x0) * t0 + ox, z0: z0 + (z1 - z0) * t0 + oz, x1: x0 + (x1 - x0) * t1 + ox, z1: z0 + (z1 - z0) * t1 + oz, r: 0.25, y }, key);
            }
          }
        }
      }
      for (const o of obstacles) addObs(o, key);
      waterByTile.set(
        key,
        tile.water.map((r) => makePoly(r, key)),
      );
    },
    removeTile(key) {
      for (const [k, list] of grid) {
        const kept = list.filter((p) => p.tile !== key);
        if (kept.length) grid.set(k, kept);
        else grid.delete(k);
      }
      for (const [k, list] of obsGrid) {
        const kept = list.filter((o) => o.tile !== key);
        if (kept.length) obsGrid.set(k, kept);
        else obsGrid.delete(k);
      }
      waterByTile.delete(key);
    },
    push(c, obstacles = true) {
      if (obstacles) {
        const hit = pushObstacle(c);
        if (hit) return hit;
      }
      // 지하차도 안에서는 위에 있는 건물과 부딪히지 않는다 (옹벽이 차를 잡아 둔다)
      if ((c.y ?? 0) < -2.5) return null;
      const seen = new Set<Poly>();
      for (const k of cellsOf(c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r)) {
        for (const p of grid.get(k) ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          if (c.x < p.minX - c.r || c.x > p.maxX + c.r || c.z < p.minZ - c.r || c.z > p.maxZ + c.r) continue;
          const near = nearestOnRing(p.ring, c.x, c.z);
          const inside = pointInRing(p.ring, c.x, c.z);
          if (!inside && near.d >= c.r) continue;
          let nx = c.x - near.px;
          let nz = c.z - near.pz;
          const d = Math.hypot(nx, nz) || 1;
          nx /= d;
          nz /= d;
          if (inside) {
            nx = -nx;
            nz = -nz;
          }
          const depth = inside ? near.d + c.r : c.r - near.d;
          return { dx: nx * depth, dz: nz * depth, nx, nz };
        }
      }
      return null;
    },
    inWater(x, z, y = 0) {
      if (y > 1.5) return false;
      let wet = false;
      for (const list of waterByTile.values()) {
        for (const p of list) {
          if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
          if (pointInRing(p.ring, x, z)) {
            wet = true;
            break;
          }
        }
        if (wet) break;
      }
      if (!wet) return false;
      const hit = g.nearestEdge(x, z, 12);
      return !(hit && hit.e.bridge && hit.d <= hit.e.half + 2.5);
    },
  };
}
