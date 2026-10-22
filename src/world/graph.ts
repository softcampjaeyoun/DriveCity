import type { EdgeData, MapIndex, RoadClass, TileData } from './mapdata.ts';
import { CURB_H, hasCurb, walkWidth } from './roads.ts';

export const LANE_W = 3.3;
export const CLASS_RANK: Record<RoadClass, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7 };
/** 레벨별 노면 높이(m). tools/build-map.mjs 와 같은 값 */
export const levelHeight = (lv: number): number => (lv > 0 ? 7 + (lv - 1) * 5.5 : lv < 0 ? -6.5 - (-lv - 1) * 5.5 : 0);
/** 고가·지하차도 진입 경사. 연결로(램프)는 더 가파르다 */
export const SLOPE = 0.06;
export const slopeOf = (e: { link: boolean }): number => (e.link ? 0.08 : SLOPE);
/** 지상 평지 간선인지 (레벨 0 이고 양끝 노드도 지면). 아니면 고가·지하·램프 */
export const isFlat = (e: { yt: number; ya: number; yb: number }): boolean => e.yt === 0 && e.ya === 0 && e.yb === 0;

/** 전역 노드 번호 */
export type Node = number;
/** 진행 방향: +1 = a→b, -1 = b→a */
export type Dir = 1 | -1;

export interface Edge extends EdgeData {
  /** 각 꼭짓점까지의 누적 길이 */
  cum: number[];
  width: number;
  half: number;
  rank: number;
  /** 차선 폭. 골목은 좁다 */
  laneW: number;
  /** 이 간선을 가진 타일 */
  tile: string;
  /** 양끝 노드의 노면 높이와 이 레벨의 목표 높이. 지상 간선은 모두 0 */
  ya: number;
  yb: number;
  yt: number;
}

export interface PointOn {
  x: number;
  z: number;
  /** 노면 높이 */
  y: number;
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

/**
 * 타일이 들어오고 나가는 동적 도로 그래프.
 * 노드·간선은 전역 번호로 식별하므로 타일이 바뀌어도 번호가 그대로다.
 */
export interface RoadGraph {
  index: MapIndex;
  bbox: MapIndex['bbox'];
  start: Node;
  /** 로드된 간선 (반복 가능) */
  readonly edges: Iterable<Edge>;
  readonly edgeCount: number;
  readonly totalLen: number;
  /** 로드된 3갈래 이상 교차로 */
  readonly majorNodes: Node[];
  /** 그래프가 바뀔 때마다 1씩 오른다. 캐시 무효화용 */
  readonly version: number;
  has(n: Node): boolean;
  hasEdge(id: number): boolean;
  edge(id: number): Edge | undefined;
  pos(n: Node): [number, number];
  /** 노드의 노면 높이 */
  posY(n: Node): number;
  /** 간선 a 쪽 끝에서 sa 만큼 간 지점의 노면 높이 */
  heightAt(e: Edge, sa: number): number;
  /** (x, z) 아래 노면 높이. 고가와 지상 도로가 겹치는 곳은 yRef 에 가까운 면을 고른다. 길 밖이면 0 */
  groundAt(x: number, z: number, yRef: number): number;
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
  /** 로드된 큰 교차로 중 무작위. 범위를 주면 그 안에서 */
  randomNode(near?: { x: number; z: number; min: number; max: number }): Node;
  randomEdge(near?: { x: number; z: number; r: number }): Edge;
  addTile(key: string, tile: TileData): void;
  removeTile(key: string): void;
  onChange(fn: () => void): void;
}

const CELL = 40;
const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

export function createGraph(index: MapIndex): RoadGraph {
  const nodes = new Map<Node, [number, number, number]>();
  const nodeRef = new Map<Node, number>();
  const edges = new Map<number, Edge>();
  const out = new Map<Node, number[]>();
  const tileEdges = new Map<string, number[]>();
  const nodeGrid = new Map<string, Set<Node>>();
  const edgeGrid = new Map<string, Set<number>>();
  const listeners: Array<() => void> = [];
  let version = 0;
  let totalLen = 0;
  let majorCache: Node[] | null = null;
  let edgeArrCache: Edge[] | null = null;

  const bump = () => {
    version++;
    majorCache = null;
    edgeArrCache = null;
    for (const fn of listeners) fn();
  };
  const degree = (n: Node) => out.get(n)?.length ?? 0;

  const edgeCells = (e: Edge): string[] => {
    const keys = new Set<string>();
    for (let i = 0; i < e.pts.length - 2; i += 2) {
      const x0 = e.pts[i];
      const z0 = e.pts[i + 1];
      const x1 = e.pts[i + 2];
      const z1 = e.pts[i + 3];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / CELL));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        keys.add(cellKey(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t));
      }
    }
    return [...keys];
  };

  function addTile(key: string, tile: TileData): void {
    if (tileEdges.has(key)) return;
    const ids: number[] = [];
    for (const [id, x, z, y] of tile.nodes) {
      nodeRef.set(id, (nodeRef.get(id) ?? 0) + 1);
      if (!nodes.has(id)) {
        nodes.set(id, [x, z, y ?? 0]);
        const k = cellKey(x, z);
        let s = nodeGrid.get(k);
        if (!s) {
          s = new Set();
          nodeGrid.set(k, s);
        }
        s.add(id);
      }
    }
    for (const d of tile.edges) {
      if (edges.has(d.id)) continue;
      const cum = [0];
      for (let i = 2; i < d.pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(d.pts[i] - d.pts[i - 2], d.pts[i + 1] - d.pts[i - 1]));
      const lanesTotal = d.lb === 0 ? d.lf : d.lf + d.lb;
      const rank = CLASS_RANK[d.cls] ?? 6;
      const laneW = rank >= 6 ? 2.6 : LANE_W;
      const width = lanesTotal * laneW;
      const lv = d.lv ?? 0;
      const e: Edge = { ...d, lv, cum, len: cum[cum.length - 1] || d.len, width, half: width / 2, rank, laneW, tile: key, ya: nodes.get(d.a)?.[2] ?? 0, yb: nodes.get(d.b)?.[2] ?? 0, yt: levelHeight(lv) };
      edges.set(e.id, e);
      ids.push(e.id);
      totalLen += e.len;
      for (const n of [e.a, e.b]) {
        let list = out.get(n);
        if (!list) {
          list = [];
          out.set(n, list);
        }
        list.push(e.id);
      }
      for (const k of edgeCells(e)) {
        let s = edgeGrid.get(k);
        if (!s) {
          s = new Set();
          edgeGrid.set(k, s);
        }
        s.add(e.id);
      }
    }
    tileEdges.set(key, ids);
    bump();
  }

  function removeTile(key: string): void {
    const ids = tileEdges.get(key);
    if (!ids) return;
    tileEdges.delete(key);
    const touched = new Set<Node>();
    for (const id of ids) {
      const e = edges.get(id);
      if (!e) continue;
      edges.delete(id);
      totalLen -= e.len;
      for (const n of [e.a, e.b]) {
        const list = out.get(n);
        if (list) {
          const i = list.indexOf(id);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) out.delete(n);
        }
        touched.add(n);
      }
      for (const k of edgeCells(e)) edgeGrid.get(k)?.delete(id);
    }
    for (const n of touched) {
      const r = (nodeRef.get(n) ?? 1) - 1;
      if (r > 0) {
        nodeRef.set(n, r);
        continue;
      }
      nodeRef.delete(n);
      const p = nodes.get(n);
      if (p) nodeGrid.get(cellKey(p[0], p[1]))?.delete(n);
      nodes.delete(n);
      out.delete(n);
    }
    bump();
  }

  /** 양끝에서 각각 경사를 따라 목표 높이(yt)로 다가가는 두 꺾은선 중 yt 에서 먼 쪽 (tools/build-map.mjs profileY 와 같은 규칙) */
  const heightAt = (e: Edge, sa: number): number => {
    if (isFlat(e)) return 0;
    const s = Math.min(Math.max(0, sa), e.len);
    const S = slopeOf(e);
    const toward = (y0: number, dist: number) => y0 + Math.max(-S * dist, Math.min(S * dist, e.yt - y0));
    const fa = toward(e.ya, s);
    const fb = toward(e.yb, e.len - s);
    return Math.abs(fa - e.yt) >= Math.abs(fb - e.yt) ? fa : fb;
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
    return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, y: heightAt(e, sa), hx, hz };
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
        const side = ((x - px) * -dz + (z - pz) * dx) / l;
        best = { e, s: e.cum[i / 2] + l * t, d, side };
      }
    }
    return best;
  }
  const cellsAround = (x: number, z: number, r: number): string[] => {
    const keys: string[] = [];
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const rc = Math.ceil(r / CELL);
    for (let i = -rc; i <= rc; i++) for (let j = -rc; j <= rc; j++) keys.push(`${cx + i},${cz + j}`);
    return keys;
  };

  // ----- 다익스트라 (로드된 영역 안) -----
  function dijkstra(from: Node, to: Node): { prev: Map<Node, Node>; prevEdge: Map<Node, number>; dist: Map<Node, number> } | null {
    if (!nodes.has(from) || !nodes.has(to)) return null;
    const dist = new Map<Node, number>();
    const prev = new Map<Node, Node>();
    const prevEdge = new Map<Node, number>();
    const heap: Array<[number, number]> = [[0, from]];
    dist.set(from, 0);
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
      if (d > (dist.get(n) ?? Infinity)) continue;
      if (n === to) return { prev, prevEdge, dist };
      for (const id of out.get(n) ?? []) {
        const e = edges.get(id)!;
        const dir: Dir = e.a === n ? 1 : -1;
        if (!(dir === 1 ? e.lf > 0 : e.lb > 0)) continue;
        const m = dir === 1 ? e.b : e.a;
        const w = e.len * (1 + e.rank * 0.08);
        if (d + w < (dist.get(m) ?? Infinity)) {
          dist.set(m, d + w);
          prev.set(m, n);
          prevEdge.set(m, id);
          push([d + w, m]);
        }
      }
    }
    return null;
  }

  const g: RoadGraph = {
    index,
    bbox: index.bbox,
    start: index.start.node,
    get edges() {
      return edges.values();
    },
    get edgeCount() {
      return edges.size;
    },
    get totalLen() {
      return totalLen;
    },
    get majorNodes() {
      if (!majorCache) {
        majorCache = [];
        for (const [n, list] of out) if (list.length >= 3 && list.some((id) => (edges.get(id)?.rank ?? 9) <= 6)) majorCache.push(n);
      }
      return majorCache;
    },
    get version() {
      return version;
    },
    has: (n) => nodes.has(n),
    hasEdge: (id) => edges.has(id),
    edge: (id) => edges.get(id),
    pos(n) {
      const p = nodes.get(n);
      return p ? [p[0], p[1]] : [0, 0];
    },
    posY: (n) => nodes.get(n)?.[2] ?? 0,
    heightAt,
    groundAt(x, z, yRef) {
      // 후보: 지면(0, 인도 위면 연석 높이)과, 이 점을 노면 폭(+난간 여유) 안에 두는 고가·지하 간선들
      let ground = 0;
      let groundHit: EdgeHit | null = null;
      let best = 0;
      let bestD = Infinity;
      const seen = new Set<number>();
      for (const k of cellsAround(x, z, 16)) {
        for (const id of edgeGrid.get(k) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const e = edges.get(id)!;
          const hit = projectOnEdge(e, x, z);
          if (isFlat(e)) {
            if (hit.d <= 16 && (!groundHit || hit.d < groundHit.d)) groundHit = hit;
            continue;
          }
          if (hit.d > e.half + 2.5) continue;
          const y = heightAt(e, hit.s);
          const d = Math.abs(y - yRef);
          if (d < bestD) {
            bestD = d;
            best = y;
          }
        }
      }
      // 가장 가까운 지상 길의 차도 밖·인도 안이면 연석만큼 올라선다
      if (groundHit && hasCurb(groundHit.e.rank) && groundHit.d > groundHit.e.half + 0.3 && groundHit.d < groundHit.e.half + walkWidth(groundHit.e.rank)) ground = CURB_H;
      return Math.abs(ground - yRef) <= bestD ? ground : best;
    },
    degree,
    edgesAt: (n) => (out.get(n) ?? []).map((id) => edges.get(id)!),
    otherEnd: (e, n) => (e.a === n ? e.b : e.a),
    dirInto: (e, n) => (e.b === n ? 1 : -1),
    canTravel: (e, dir) => (dir === 1 ? e.lf > 0 : e.lb > 0),
    lanes: (e, dir) => (dir === 1 ? e.lf : e.lb),
    laneOffset(e, dir, lane) {
      const n = dir === 1 ? e.lf : e.lb;
      const i = Math.min(Math.max(0, lane), n - 1);
      if (e.lb === 0) return (i + 0.5 - n / 2) * e.laneW;
      return (i + 0.5) * e.laneW;
    },
    pointAt,
    cut(e, n) {
      if (degree(n) < 3) return 0;
      let w = 0;
      for (const id of out.get(n) ?? []) if (id !== e.id) w = Math.max(w, edges.get(id)!.half);
      return Math.min(w + 2, e.len * 0.35);
    },
    nearestNode(x, z) {
      let best = -1;
      let bd = Infinity;
      for (let r = 1; r <= 8; r++) {
        for (const k of cellsAround(x, z, r * CELL)) {
          for (const i of nodeGrid.get(k) ?? []) {
            const p = nodes.get(i)!;
            const d = Math.hypot(p[0] - x, p[1] - z);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
        if (bd < r * CELL) return best;
      }
      if (best < 0) {
        for (const [i, p] of nodes) {
          const d = Math.hypot(p[0] - x, p[1] - z);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
      return best < 0 ? index.start.node : best;
    },
    nearestEdge(x, z, maxD = 60) {
      let best: EdgeHit | null = null;
      const seen = new Set<number>();
      for (const k of cellsAround(x, z, maxD)) {
        for (const id of edgeGrid.get(k) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const hit = projectOnEdge(edges.get(id)!, x, z);
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
      while (n !== from && r.prev.has(n)) {
        const e = edges.get(r.prevEdge.get(n)!)!;
        steps.push({ e, dir: e.b === n ? 1 : -1 });
        n = r.prev.get(n)!;
      }
      return steps.reverse();
    },
    dist(from, to) {
      const r = dijkstra(from, to);
      return r ? (r.dist.get(to) ?? Infinity) : Infinity;
    },
    randomNode(near) {
      const major = g.majorNodes;
      if (!major.length) return index.start.node;
      if (!near) return major[Math.floor(Math.random() * major.length)];
      for (let tries = 0; tries < 40; tries++) {
        const n = major[Math.floor(Math.random() * major.length)];
        const [x, z] = nodes.get(n)!;
        const d = Math.hypot(x - near.x, z - near.z);
        if (d >= near.min && d <= near.max) return n;
      }
      // 조건에 맞는 게 없으면 가장 가까운 후보
      let best = major[0];
      let bd = Infinity;
      for (const n of major) {
        const [x, z] = nodes.get(n)!;
        const d = Math.abs(Math.hypot(x - near.x, z - near.z) - (near.min + near.max) / 2);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    },
    randomEdge(near) {
      if (!edgeArrCache) edgeArrCache = [...edges.values()];
      const arr = edgeArrCache;
      if (!arr.length) throw new Error('로드된 도로가 없어요');
      if (near) {
        for (let tries = 0; tries < 60; tries++) {
          const e = arr[Math.floor(Math.random() * arr.length)];
          if (Math.hypot(e.pts[0] - near.x, e.pts[1] - near.z) <= near.r) return e;
        }
      }
      let r = Math.random() * totalLen;
      for (const e of arr) {
        r -= e.len;
        if (r <= 0) return e;
      }
      return arr[arr.length - 1];
    },
    addTile,
    removeTile,
    onChange(fn) {
      listeners.push(fn);
    },
  };
  return g;
}
