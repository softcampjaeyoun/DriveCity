import type { RoadGraph } from './graph.ts';
import type { MapData } from './mapdata.ts';

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface PushResult {
  dx: number;
  dz: number;
  nx: number;
  nz: number;
}

/** 건물·물 폴리곤 충돌. 공간 해시로 근처 폴리곤만 본다 */
export interface CollisionWorld {
  /** 원이 건물에 겹치면 밀어낼 벡터와 법선. 없으면 null */
  push(c: Circle): PushResult | null;
  /** 물 위이고 다리 위가 아니면 true */
  inWater(x: number, z: number): boolean;
}

interface Poly {
  ring: number[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const CELL = 32;

function makePoly(ring: number[]): Poly {
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
  return { ring, minX, maxX, minZ, maxZ };
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

export function createCollisionWorld(map: MapData, g: RoadGraph): CollisionWorld {
  const grid = new Map<string, Poly[]>();
  const add = (p: Poly) => {
    for (let cx = Math.floor(p.minX / CELL); cx <= Math.floor(p.maxX / CELL); cx++) {
      for (let cz = Math.floor(p.minZ / CELL); cz <= Math.floor(p.maxZ / CELL); cz++) {
        const k = `${cx},${cz}`;
        const list = grid.get(k) ?? [];
        list.push(p);
        grid.set(k, list);
      }
    }
  };
  for (const b of map.buildings) add(makePoly(b.ring));
  const water = map.water.map(makePoly);
  const bridges = g.edges.filter((e) => e.bridge);

  const candidates = (x: number, z: number, r: number): Poly[] => {
    const out: Poly[] = [];
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const list = grid.get(`${cx},${cz}`);
        if (list) out.push(...list);
      }
    }
    return out;
  };

  return {
    push(c) {
      for (const p of candidates(c.x, c.z, c.r)) {
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
      return null;
    },
    inWater(x, z) {
      let wet = false;
      for (const p of water) {
        if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
        if (pointInRing(p.ring, x, z)) {
          wet = true;
          break;
        }
      }
      if (!wet) return false;
      for (const e of bridges) {
        const hit = g.nearestEdge(x, z, e.half + 3);
        if (hit && hit.e.bridge && hit.d <= hit.e.half + 2.5) return false;
      }
      return true;
    },
  };
}
