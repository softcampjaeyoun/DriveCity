import { MAP_BASE } from '../world/mapdata.ts';
import type { PlayerState } from '../vehicle/player.ts';

/**
 * 목적지 길안내. 큰 지도에서 우클릭한 지점까지 전역 내비 그래프(nav.json, 등급 4 이하 도로)로 경로를 찾고,
 * 미니맵·큰 지도에 경로선을, 화면 위 화살표엔 "다음 갈림길" 방향과 남은 거리를 준다.
 * 경로에서 120m 넘게 벗어나 3초가 지나면 다시 찾고, 목적지 25m 안에 들어오면 도착으로 끝낸다
 */
export interface NavState {
  /** 경로 폴리라인 [x, z, ...] (플레이어 앞부분만) */
  route: number[];
  /** 화살표가 가리킬 지점 (경로 위 40m 앞) */
  next: { x: number; z: number };
  dest: { x: number; z: number };
  /** 남은 거리 (m) */
  remaining: number;
}
export interface Nav {
  readonly active: boolean;
  readonly dest: { x: number; z: number } | null;
  setDestination(x: number, z: number): void;
  clear(): void;
  /** 매 프레임. 경로 진행·재탐색·도착 */
  update(dt: number, S: PlayerState): NavState | null;
}

interface NavData {
  nodes: number[];
  edges: Array<{ a: number; b: number; len: number; oneway: number; pts: number[] }>;
}

export async function loadNav(): Promise<NavData | null> {
  try {
    const res = await fetch(`${MAP_BASE}nav.json`);
    if (!res.ok) return null;
    return (await res.json()) as NavData;
  } catch {
    return null;
  }
}

const CELL = 150;

export function createNav(data: NavData | null, toast: (big: string, sub: string, secs?: number) => void): Nav {
  const nodeCount = data ? data.nodes.length / 2 : 0;
  // 인접 리스트
  const out: number[][] = Array.from({ length: nodeCount }, () => []);
  const grid = new Map<string, number[]>();
  if (data) {
    data.edges.forEach((e, i) => {
      out[e.a].push(i);
      if (!e.oneway) out[e.b].push(i);
    });
    for (let n = 0; n < nodeCount; n++) {
      const k = `${Math.floor(data.nodes[n * 2] / CELL)},${Math.floor(data.nodes[n * 2 + 1] / CELL)}`;
      const l = grid.get(k) ?? [];
      l.push(n);
      grid.set(k, l);
    }
  }
  const nearestNode = (x: number, z: number): number => {
    if (!data) return -1;
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r <= 8 && best < 0; r++) {
      const cx = Math.floor(x / CELL);
      const cz = Math.floor(z / CELL);
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          for (const n of grid.get(`${cx + i},${cz + j}`) ?? []) {
            const d = Math.hypot(data.nodes[n * 2] - x, data.nodes[n * 2 + 1] - z);
            if (d < bd) {
              bd = d;
              best = n;
            }
          }
        }
      }
      // 이 고리에서 찾았으면 다음 고리에 더 가까운 게 있을 수 없으니(고리 간격 CELL) 한 고리만 더 보고 끝
      if (best >= 0 && r >= 1) break;
    }
    return best;
  };

  /** 다익스트라. 목적지까지 간선 번호 열 */
  function dijkstra(from: number, to: number): number[] | null {
    if (!data || from < 0 || to < 0) return null;
    const dist = new Float64Array(nodeCount).fill(Infinity);
    const prevEdge = new Int32Array(nodeCount).fill(-1);
    const heap: Array<[number, number]> = [[0, from]];
    dist[from] = 0;
    const push = (it: [number, number]) => {
      heap.push(it);
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
      if (n === to) break;
      for (const ei of out[n]) {
        const e = data.edges[ei];
        const m = e.a === n ? e.b : e.a;
        const nd = d + e.len;
        if (nd < dist[m]) {
          dist[m] = nd;
          prevEdge[m] = ei;
          push([nd, m]);
        }
      }
    }
    if (!Number.isFinite(dist[to])) return null;
    const path: number[] = [];
    let n = to;
    while (n !== from) {
      const ei = prevEdge[n];
      if (ei < 0) return null;
      path.push(ei);
      const e = data.edges[ei];
      n = e.a === n ? e.b : e.a;
    }
    return path.reverse();
  }

  let dest: { x: number; z: number } | null = null;
  let route: number[] = [];
  let cum: number[] = [];
  let offTimer = 0;
  let lastRouteFrom = -1;

  function plan(x: number, z: number): boolean {
    if (!dest) return false;
    const from = nearestNode(x, z);
    const to = nearestNode(dest.x, dest.z);
    const path = dijkstra(from, to);
    if (!path) {
      route = [];
      cum = [];
      return false;
    }
    const pts: number[] = [x, z];
    let n = from;
    for (const ei of path) {
      const e = data!.edges[ei];
      const forward = e.a === n;
      const p = e.pts;
      if (forward) for (let i = 0; i < p.length; i += 2) pts.push(p[i], p[i + 1]);
      else for (let i = p.length - 2; i >= 0; i -= 2) pts.push(p[i], p[i + 1]);
      n = forward ? e.b : e.a;
    }
    pts.push(dest.x, dest.z);
    route = pts;
    cum = [0];
    for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
    lastRouteFrom = from;
    return true;
  }

  /** 경로 위에서 플레이어와 가장 가까운 점의 호 길이와 거리 */
  function project(x: number, z: number): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    for (let i = 0; i + 3 < route.length; i += 2) {
      const x0 = route[i];
      const z0 = route[i + 1];
      const dx = route[i + 2] - x0;
      const dz = route[i + 3] - z0;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
      const d = Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t));
      if (d < best.d) best = { s: cum[i / 2] + Math.sqrt(l2) * t, d };
    }
    return best;
  }
  function pointAt(s: number): { x: number; z: number } {
    const n = cum.length;
    const sa = Math.min(Math.max(0, s), cum[n - 1] ?? 0);
    let lo = 0;
    let hi = Math.max(0, n - 2);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= sa) lo = mid;
      else hi = mid - 1;
    }
    const l = cum[lo + 1] - cum[lo] || 1;
    const t = (sa - cum[lo]) / l;
    return { x: route[lo * 2] + (route[lo * 2 + 2] - route[lo * 2]) * t, z: route[lo * 2 + 1] + (route[lo * 2 + 3] - route[lo * 2 + 1]) * t };
  }

  return {
    get active() {
      return !!dest;
    },
    get dest() {
      return dest;
    },
    setDestination(x, z) {
      dest = { x, z };
      route = [];
      offTimer = 0;
      lastRouteFrom = -1;
      toast('목적지 설정', data ? '화살표와 지도 경로를 따라가세요 · X 취소' : '내비 데이터가 없어 직선 방향만 안내해요', 2.2);
    },
    clear() {
      dest = null;
      route = [];
      cum = [];
    },
    update(dt, S) {
      if (!dest) return null;
      const straight = Math.hypot(dest.x - S.x, dest.z - S.z);
      if (straight < 25) {
        toast('목적지 도착', '', 2);
        dest = null;
        route = [];
        return null;
      }
      if (!route.length) {
        if (!data || !plan(S.x, S.z)) return { route: [], next: dest, dest, remaining: straight };
      }
      const pr = project(S.x, S.z);
      // 벗어남: 120m 넘게 3초 → 다시 찾기 (출발 노드가 바뀌었을 때만)
      if (pr.d > 120) {
        offTimer += dt;
        if (offTimer > 3) {
          offTimer = 0;
          if (nearestNode(S.x, S.z) !== lastRouteFrom) plan(S.x, S.z);
        }
      } else offTimer = 0;
      const total = cum[cum.length - 1] ?? 0;
      const remaining = Math.max(straight, total - pr.s);
      const next = pointAt(pr.s + 40);
      // 지도에 그릴 경로: 지나온 부분은 뺀다
      let i = 0;
      while (i + 1 < cum.length && cum[i + 1] < pr.s) i++;
      const ahead = [S.x, S.z, ...route.slice((i + 1) * 2)];
      return { route: ahead, next, dest, remaining };
    },
  };
}
