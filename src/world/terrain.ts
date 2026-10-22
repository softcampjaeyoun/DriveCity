import * as THREE from 'three';
import { pointInRing } from './collision.ts';
import type { MapIndex, TileData } from './mapdata.ts';

/**
 * 지형 높이맵. 타일마다 n×n(25m 간격) 데시미터 정수 격자(tools/add-dem.mjs)를 들고 있고,
 * 격자 사이는 지형 메시와 똑같은 삼각형 분할(셀 대각선 (0,0)-(1,1))로 평면 보간한다 — 도로·인도가 지형 메시와 정확히 맞물리게.
 * 로드된 타일(상세·먼 타일 모두)만 알고, 밖은 0
 */
export interface Terrain {
  add(key: string, tile: TileData): void;
  remove(key: string): void;
  /** (x,z) 지형 높이(m). 한강 수면 0 기준. 타일이 없으면 0 */
  at(x: number, z: number): number;
  /** 타일 지형 메시 지오메트리 (position/normal/uv/park). 높이맵이 없으면 null */
  geometry(tile: TileData, parkMask: boolean): THREE.BufferGeometry | null;
  readonly n: number;
  readonly step: number;
}

interface Grid {
  x0: number;
  z0: number;
  data: number[];
  refs: number;
}

export function createTerrain(index: MapIndex): Terrain {
  const n = index.hm?.n ?? 41;
  const step = index.hm?.step ?? 25;
  const TILE = index.tile;
  const { minX, minZ } = index.bbox;
  const grids = new Map<string, Grid>();

  const sample = (g: Grid, x: number, z: number): number => {
    const lx = Math.min(n - 1.0001, Math.max(0, (x - g.x0) / step));
    const lz = Math.min(n - 1.0001, Math.max(0, (z - g.z0) / step));
    const ix = Math.floor(lx);
    const iz = Math.floor(lz);
    const fx = lx - ix;
    const fz = lz - iz;
    const d = g.data;
    const h00 = d[iz * n + ix];
    const h10 = d[iz * n + ix + 1];
    const h01 = d[(iz + 1) * n + ix];
    const h11 = d[(iz + 1) * n + ix + 1];
    const h = fx > fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h01 - h00) * fz + (h11 - h01) * fx;
    return h / 10;
  };

  return {
    n,
    step,
    add(key, tile) {
      const g = grids.get(key);
      if (g) {
        g.refs++;
        return;
      }
      if (!tile.hm) return;
      grids.set(key, { x0: minX + tile.i * TILE, z0: minZ + tile.j * TILE, data: tile.hm, refs: 1 });
    },
    remove(key) {
      const g = grids.get(key);
      if (!g) return;
      if (--g.refs <= 0) grids.delete(key);
    },
    at(x, z) {
      const i = Math.floor((x - minX) / TILE);
      const j = Math.floor((z - minZ) / TILE);
      const g = grids.get(`${i}_${j}`);
      return g ? sample(g, x, z) : 0;
    },
    geometry(tile, parkMask) {
      if (!tile.hm) return null;
      const x0 = minX + tile.i * TILE;
      const z0 = minZ + tile.j * TILE;
      const pos = new Float32Array(n * n * 3);
      const uv = new Float32Array(n * n * 2);
      const park = new Float32Array(n * n);
      const parks = parkMask ? tile.parks.filter((r) => r.length >= 6) : [];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          const x = x0 + i * step;
          const z = z0 + j * step;
          pos[k * 3] = x;
          pos[k * 3 + 1] = tile.hm[k] / 10;
          pos[k * 3 + 2] = z;
          uv[k * 2] = x / 10;
          uv[k * 2 + 1] = z / 10;
          if (tile.gm?.[k]) park[k] = 1;
          else if (parks.length) for (const r of parks) if (pointInRing(r, x, z)) { park[k] = 1; break; }
        }
      }
      const idx = new Uint32Array((n - 1) * (n - 1) * 6);
      let p = 0;
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          const v00 = j * n + i;
          const v10 = v00 + 1;
          const v01 = v00 + n;
          const v11 = v01 + 1;
          // 위를 보는 방향 (x,z 기준 시계 방향). 셀 대각선은 v00-v11
          idx[p++] = v00;
          idx[p++] = v11;
          idx[p++] = v10;
          idx[p++] = v00;
          idx[p++] = v01;
          idx[p++] = v11;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('park', new THREE.BufferAttribute(park, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      return geo;
    },
  };
}
