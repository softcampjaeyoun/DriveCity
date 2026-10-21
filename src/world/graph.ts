import { DIRS, EDGE } from '../config.ts';
import { mulberry32 } from '../util/math.ts';

/** 교차로 격자 좌표 */
export type Node = [number, number];
export type District = 'cbd' | 'old' | 'mixed' | 'park' | 'water';

export interface Block {
  i: number;
  j: number;
  x0: number;
  z0: number;
  w: number;
  d: number;
  district: District;
}

/**
 * 도로 그래프. 격자지만 간격이 제각각이고, 강을 건너는 도로는 다리가 있는 열에만 있다.
 * 서울을 본뜬 배치: 북쪽은 구도심(저층·네온)과 업무지구가 섞이고, 한강 남쪽은 고층 업무지구.
 */
export interface RoadGraph {
  xs: number[];
  zs: number[];
  nx: number;
  nz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 강 띠의 z 범위. 블록 행 riverRow 가 물이다 */
  river: { z0: number; z1: number; row: number };
  bridges: number[];
  blocks: Block[];
  inGrid(i: number, j: number): boolean;
  hasEdge(i: number, j: number, d: number): boolean;
  /** 교차로 중심 사이 거리 */
  edgeLen(i: number, j: number, d: number): number;
  degree(i: number, j: number): number;
  pos(n: Node): [number, number];
  nearest(x: number, z: number): Node;
  /** from → to 최단 경로의 방향 목록 (BFS) */
  route(from: Node, to: Node): number[];
  /** 교차로 중심 사이 그래프 거리 (m) */
  dist(from: Node, to: Node): number;
  randomNode(): Node;
}

export function buildGraph(): RoadGraph {
  const rand = mulberry32(7);
  const RIVER = 120;
  // 블록 폭 패턴. 합이 도시 크기
  const bw = [60, 48, 72, 56, 64, 52, 68, 58, 50, 66, 60];
  const bdNorth = [56, 64, 48, 70, 60];
  const bdSouth = [62, 54, 72, 58, 66];
  const bd = [...bdNorth, RIVER, ...bdSouth];
  const riverRow = bdNorth.length;
  const bridges = [2, 5, 8];

  const cum = (arr: number[]): number[] => {
    const out = [0];
    for (const v of arr) out.push(out[out.length - 1] + v + 2 * EDGE);
    return out;
  };
  const rawX = cum(bw);
  const rawZ = cum(bd);
  const cx = rawX[rawX.length - 1] / 2;
  const cz = rawZ[rawZ.length - 1] / 2;
  const xs = rawX.map((v) => v - cx);
  const zs = rawZ.map((v) => v - cz);
  const nx = xs.length;
  const nz = zs.length;

  const inGrid = (i: number, j: number) => i >= 0 && i < nx && j >= 0 && j < nz;
  const hasEdge = (i: number, j: number, d: number): boolean => {
    const ni = i + DIRS[d][0];
    const nj = j + DIRS[d][1];
    if (!inGrid(i, j) || !inGrid(ni, nj)) return false;
    // 강을 건너는 남북 도로는 다리 열에만 있다
    if (d === 0 && j === riverRow && !bridges.includes(i)) return false;
    if (d === 2 && j === riverRow + 1 && !bridges.includes(i)) return false;
    return true;
  };
  const pos = (n: Node): [number, number] => [xs[n[0]], zs[n[1]]];
  const edgeLen = (i: number, j: number, d: number) => {
    const ni = i + DIRS[d][0];
    const nj = j + DIRS[d][1];
    return Math.abs(xs[ni] - xs[i]) + Math.abs(zs[nj] - zs[j]);
  };
  const degree = (i: number, j: number) => [0, 1, 2, 3].filter((d) => hasEdge(i, j, d)).length;

  // 블록과 지역구
  const blocks: Block[] = [];
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < nz - 1; j++) {
      const x0 = xs[i] + EDGE;
      const z0 = zs[j] + EDGE;
      const w = xs[i + 1] - EDGE - x0;
      const d = zs[j + 1] - EDGE - z0;
      let district: District;
      if (j === riverRow) district = 'water';
      else if (rand() < 0.07 && !(Math.abs(x0 + w / 2) < 80 && Math.abs(z0 + d / 2) < 80)) district = 'park';
      else if (j > riverRow) district = rand() < 0.75 ? 'cbd' : 'mixed';
      else district = i >= 3 && i <= 7 ? (rand() < 0.8 ? 'old' : 'mixed') : rand() < 0.4 ? 'cbd' : 'mixed';
      blocks.push({ i, j, x0, z0, w, d, district });
    }
  }

  const key = (n: Node) => n[0] * 100 + n[1];
  const route = (from: Node, to: Node): number[] => {
    if (from[0] === to[0] && from[1] === to[1]) return [];
    const prev = new Map<number, [Node, number]>();
    const seen = new Set<number>([key(from)]);
    const queue: Node[] = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (let d = 0; d < 4; d++) {
        if (!hasEdge(cur[0], cur[1], d)) continue;
        const nxt: Node = [cur[0] + DIRS[d][0], cur[1] + DIRS[d][1]];
        const k = key(nxt);
        if (seen.has(k)) continue;
        seen.add(k);
        prev.set(k, [cur, d]);
        if (k === key(to)) {
          const dirs: number[] = [];
          let n = nxt;
          while (key(n) !== key(from)) {
            const [p, dir] = prev.get(key(n))!;
            dirs.push(dir);
            n = p;
          }
          return dirs.reverse();
        }
        queue.push(nxt);
      }
    }
    return [];
  };
  const dist = (from: Node, to: Node): number => {
    let n: Node = [from[0], from[1]];
    let total = 0;
    for (const d of route(from, to)) {
      total += edgeLen(n[0], n[1], d);
      n = [n[0] + DIRS[d][0], n[1] + DIRS[d][1]];
    }
    return total;
  };
  const nearestIdx = (arr: number[], v: number) => {
    let best = 0;
    for (let k = 1; k < arr.length; k++) if (Math.abs(arr[k] - v) < Math.abs(arr[best] - v)) best = k;
    return best;
  };

  return {
    xs,
    zs,
    nx,
    nz,
    minX: xs[0] - EDGE,
    maxX: xs[nx - 1] + EDGE,
    minZ: zs[0] - EDGE,
    maxZ: zs[nz - 1] + EDGE,
    river: { z0: zs[riverRow] + EDGE, z1: zs[riverRow + 1] - EDGE, row: riverRow },
    bridges,
    blocks,
    inGrid,
    hasEdge,
    edgeLen,
    degree,
    pos,
    nearest: (x, z) => [nearestIdx(xs, x), nearestIdx(zs, z)],
    route,
    dist,
    randomNode: () => [Math.floor(Math.random() * nx), Math.floor(Math.random() * nz)],
  };
}
