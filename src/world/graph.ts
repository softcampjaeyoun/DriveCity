import type { EdgeData, MapData, RoadClass } from './mapdata.ts';

export const LANE_W = 3.3;
export const CLASS_RANK: Record<RoadClass, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7 };

/** 교차로 번호 */
export type Node = number;
/** 진행 방향: +1 = a→b, -1 = b→a */
export type Dir = 1 | -1;

export interface Edge extends EdgeData {
  id: number;
  /** 각 꼭짓점까지의 누적 길이 */
  cum: number[];
  width: number;
  half: number;
  rank: number;
  /** 차선 폭. 골목은 좁다 */
  laneW: number;
}

export interface PointOn {
  x: number;
  z: number;
  /** 진행 방향 단위 벡터 */
  hx: number;
  hz: number;
}

export interface Step {
  e: Edge;
  dir: Dir;
}

export interface EdgeHit {
  e: Edge;
  /** a 기준 호 길이 */
  s: number;
  d: number;
  /** 중심선 기준 오른쪽(+)/왼쪽(-) 거리 (a→b 방향 기준) */
  side: number;
}

export interface RoadGraph {
  map: MapData;
  nodes: Array<[number, number]>;
  edges: Edge[];
  out: number[][];
  bbox: MapData['bbox'];
  start: Node;
  majorNodes: Node[];
  totalLen: number;
  pos(n: Node): [number, number];
  degree(n: Node): number;
  edgesAt(n: Node): Edge[];
  otherEnd(e: Edge, n: Node): Node;
  /** 간선 e 에서 노드 n 으로 들어오는 진행 방향 */
  dirInto(e: Edge, n: Node): Dir;
  canTravel(e: Edge, dir: Dir): boolean;
  lanes(e: Edge, dir: Dir): number;
  /** 중심선에서 오른쪽으로의 차선 중앙 거리 */
  laneOffset(e: Edge, dir: Dir, lane: number): number;
  /** 진행 시작점에서 s 만큼 간 지점 */
  pointAt(e: Edge, dir: Dir, s: number): PointOn;
  /** 교차로 쪽에서 곡선으로 넘기기 위해 잘라내는 길이 */
  cut(e: Edge, n: Node): number;
  nearestNode(x: number, z: number): Node;
  nearestEdge(x: number, z: number, maxD?: number): EdgeHit | null;
  route(from: Node, to: Node): Step[];
  dist(from: Node, to: Node): number;
  randomNode(): Node;
  randomEdge(): Edge;
}

export function buildGraph(map: MapData): RoadGraph {
  const nodes = map.nodes;
  const edges: Edge[] = map.edges.map((d, id) => {
    const cum = [0];
    for (let i = 2; i < d.pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(d.pts[i] - d.pts[i - 2], d.pts[i + 1] - d.pts[i - 1]));
    const lanesTotal = d.lb === 0 ? d.lf : d.lf + d.lb;
    const rank = CLASS_RANK[d.cls] ?? 6;
    // 골목(residential·living_street)은 실제로 좁아서 차선 폭을 줄여야 건물과 안 겹친다
    const laneW = rank >= 6 ? 2.6 : LANE_W;
    const width = lanesTotal * laneW;
    return { ...d, id, cum, len: cum[cum.length - 1] || d.len, width, half: width / 2, rank, laneW };
  });
  const out: number[][] = nodes.map(() => []);
  for (const e of edges) {
    out[e.a].push(e.id);
    out[e.b].push(e.id);
  }
  const degree = (n: Node) => out[n].length;
  const totalLen = edges.reduce((s, e) => s + e.len, 0);
  const majorNodes: Node[] = [];
  for (let n = 0; n < nodes.length; n++) if (degree(n) >= 3 && out[n].some((id) => edges[id].rank <= 6)) majorNodes.push(n);

  // ----- 공간 색인 -----
  const CELL = 40;
  const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  const nodeGrid = new Map<string, number[]>();
  nodes.forEach(([x, z], i) => {
    const k = cellKey(x, z);
    const list = nodeGrid.get(k) ?? [];
    list.push(i);
    nodeGrid.set(k, list);
  });
  const edgeGrid = new Map<string, Set<number>>();
  for (const e of edges) {
    for (let i = 0; i < e.pts.length - 2; i += 2) {
      const x0 = e.pts[i];
      const z0 = e.pts[i + 1];
      const x1 = e.pts[i + 2];
      const z1 = e.pts[i + 3];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / CELL));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const key = cellKey(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
        const set = edgeGrid.get(key) ?? new Set<number>();
        set.add(e.id);
        edgeGrid.set(key, set);
      }
    }
  }
  const cellsAround = (x: number, z: number, r: number): string[] => {
    const keys: string[] = [];
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const rc = Math.ceil(r / CELL);
    for (let i = -rc; i <= rc; i++) for (let j = -rc; j <= rc; j++) keys.push(`${cx + i},${cz + j}`);
    return keys;
  };

  const pointAt = (e: Edge, dir: Dir, s: number): PointOn => {
    const sa = dir === 1 ? s : e.len - s;
    const cum = e.cum;
    let lo = 0;
    let hi = cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= sa) lo = mid;
      else hi = mid - 1;
    }
    const segLen = cum[lo + 1] - cum[lo] || 1;
    const t = Math.min(1, Math.max(0, (sa - cum[lo]) / segLen));
    const x0 = e.pts[lo * 2];
    const z0 = e.pts[lo * 2 + 1];
    const x1 = e.pts[lo * 2 + 2];
    const z1 = e.pts[lo * 2 + 3];
    let hx = (x1 - x0) / segLen;
    let hz = (z1 - z0) / segLen;
    if (dir === -1) {
      hx = -hx;
      hz = -hz;
    }
    return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, hx, hz };
  };

  function projectOnEdge(e: Edge, x: number, z: number): EdgeHit {
    let best: EdgeHit = { e, s: 0, d: Infinity, side: 0 };
    for (let i = 0; i < e.pts.length - 2; i += 2) {
      const x0 = e.pts[i];
      const z0 = e.pts[i + 1];
      const dx = e.pts[i + 2] - x0;
      const dz = e.pts[i + 3] - z0;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
      const px = x0 + dx * t;
      const pz = z0 + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.d) {
        const l = Math.sqrt(l2);
        // 오른쪽(+): 진행 방향 (dx,dz) 의 오른쪽 = (-dz, dx)
        const side = ((x - px) * -dz + (z - pz) * dx) / l;
        best = { e, s: e.cum[i / 2] + l * t, d, side };
      }
    }
    return best;
  }

  // ----- 다익스트라 -----
  function dijkstra(from: Node, to: Node): { prev: Int32Array; prevEdge: Int32Array; dist: Float64Array } | null {
    const dist = new Float64Array(nodes.length).fill(Infinity);
    const prev = new Int32Array(nodes.length).fill(-1);
    const prevEdge = new Int32Array(nodes.length).fill(-1);
    const heap: Array<[number, number]> = [[0, from]];
    dist[from] = 0;
    const push = (item: [number, number]) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, n] = pop();
      if (d > dist[n]) continue;
      if (n === to) return { prev, prevEdge, dist };
      for (const id of out[n]) {
        const e = edges[id];
        const dir: Dir = e.a === n ? 1 : -1;
        if (!(dir === 1 ? e.lf > 0 : e.lb > 0)) continue;
        const m = dir === 1 ? e.b : e.a;
        // 좁은 길은 조금 비싸게 쳐서 큰길을 선호
        const w = e.len * (1 + e.rank * 0.08);
        if (d + w < dist[m]) {
          dist[m] = d + w;
          prev[m] = n;
          prevEdge[m] = id;
          push([d + w, m]);
        }
      }
    }
    return null;
  }

  const g: RoadGraph = {
    map,
    nodes,
    edges,
    out,
    bbox: map.bbox,
    start: map.start,
    majorNodes,
    totalLen,
    pos: (n) => [nodes[n][0], nodes[n][1]],
    degree,
    edgesAt: (n) => out[n].map((id) => edges[id]),
    otherEnd: (e, n) => (e.a === n ? e.b : e.a),
    dirInto: (e, n) => (e.b === n ? 1 : -1),
    canTravel: (e, dir) => (dir === 1 ? e.lf > 0 : e.lb > 0),
    lanes: (e, dir) => (dir === 1 ? e.lf : e.lb),
    laneOffset(e, dir, lane) {
      const n = dir === 1 ? e.lf : e.lb;
      const i = Math.min(Math.max(0, lane), n - 1);
      if (e.lb === 0) return (i + 0.5 - n / 2) * e.laneW; // 일방통행은 도로 전체를 쓴다
      return (i + 0.5) * e.laneW;
    },
    pointAt,
    cut(e, n) {
      if (degree(n) < 3) return 0;
      // 교차로의 다른 길 폭만큼 들어가서 곡선을 시작한다
      let w = 0;
      for (const id of out[n]) if (id !== e.id) w = Math.max(w, edges[id].half);
      return Math.min(w + 2, e.len * 0.35);
    },
    nearestNode(x, z) {
      let best = 0;
      let bd = Infinity;
      for (let r = 1; r <= 8; r++) {
        for (const k of cellsAround(x, z, r * CELL)) {
          for (const i of nodeGrid.get(k) ?? []) {
            const d = Math.hypot(nodes[i][0] - x, nodes[i][1] - z);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
        if (bd < r * CELL) return best;
      }
      if (bd === Infinity) {
        nodes.forEach(([nx, nz], i) => {
          const d = Math.hypot(nx - x, nz - z);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
      }
      return best;
    },
    nearestEdge(x, z, maxD = 60) {
      let best: EdgeHit | null = null;
      const seen = new Set<number>();
      for (const k of cellsAround(x, z, maxD)) {
        for (const id of edgeGrid.get(k) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const hit = projectOnEdge(edges[id], x, z);
          if (hit.d <= maxD && (!best || hit.d < best.d)) best = hit;
        }
      }
      return best;
    },
    route(from, to) {
      if (from === to) return [];
      const r = dijkstra(from, to);
      if (!r) return [];
      const steps: Step[] = [];
      let n = to;
      while (n !== from && r.prev[n] >= 0) {
        const e = edges[r.prevEdge[n]];
        steps.push({ e, dir: e.b === n ? 1 : -1 });
        n = r.prev[n];
      }
      return steps.reverse();
    },
    dist(from, to) {
      const r = dijkstra(from, to);
      return r ? r.dist[to] : Infinity;
    },
    randomNode: () => majorNodes[Math.floor(Math.random() * majorNodes.length)] ?? 0,
    randomEdge() {
      let r = Math.random() * totalLen;
      for (const e of edges) {
        r -= e.len;
        if (r <= 0) return e;
      }
      return edges[edges.length - 1];
    },
  };
  return g;
}
