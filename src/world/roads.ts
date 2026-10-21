import { bez, clamp, type Vec2 } from '../util/math.ts';
import type { Dir, Edge, Node, PointOn, RoadGraph } from './graph.ts';

export type { Node } from './graph.ts';

/** 간선 위 직선 구간. s 는 진행 시작점 기준 호 길이, [s0, s1] 만 쓴다 */
export interface EdgeSeg {
  kind: 'edge';
  e: Edge;
  dir: Dir;
  s0: number;
  s1: number;
  /** 진행 방향 끝 노드 */
  node: Node;
  len: number;
}

/** 교차로 안 곡선 */
export interface CurveSeg {
  kind: 'curve';
  p0: Vec2;
  c: Vec2;
  p1: Vec2;
  len: number;
  turn: Turn;
}

export type Seg = EdgeSeg | CurveSeg;
export type Turn = 'straight' | 'left' | 'right' | 'uturn';

export function edgeSeg(g: RoadGraph, e: Edge, dir: Dir): EdgeSeg {
  const startNode = dir === 1 ? e.a : e.b;
  const endNode = dir === 1 ? e.b : e.a;
  const s0 = g.cut(e, startNode);
  const s1 = Math.max(s0 + 0.5, e.len - g.cut(e, endNode));
  return { kind: 'edge', e, dir, s0, s1, node: endNode, len: s1 - s0 };
}

export const rightOf = (hx: number, hz: number): [number, number] => [-hz, hx];

/** 구간 위 위치. lat 은 중심선에서 오른쪽 거리 */
export function segPos(g: RoadGraph, seg: Seg, s: number, lat: number): [number, number] {
  if (seg.kind === 'curve') return bez(seg.p0, seg.c, seg.p1, clamp(s / seg.len, 0, 1));
  const p = g.pointAt(seg.e, seg.dir, clamp(s, 0, seg.e.len));
  const [rx, rz] = rightOf(p.hx, p.hz);
  return [p.x + rx * lat, p.z + rz * lat];
}

export function turnOf(h0x: number, h0z: number, h1x: number, h1z: number): Turn {
  const dot = h0x * h1x + h0z * h1z;
  const cross = h0x * h1z - h0z * h1x;
  if (dot > 0.7) return 'straight';
  if (dot < -0.7) return 'uturn';
  // x 동쪽, z 남쪽에서 오른쪽은 (-hz, hx). cross > 0 이면 오른쪽으로 꺾는다
  return cross > 0 ? 'right' : 'left';
}

/** 두 점을 잇는 곡선. 제어점은 두 진행 방향 직선의 교점 (없으면 중점) */
export function curveBetween(from: PointOn, lat0: number, to: PointOn, lat1: number): CurveSeg {
  const [r0x, r0z] = rightOf(from.hx, from.hz);
  const [r1x, r1z] = rightOf(to.hx, to.hz);
  const p0: Vec2 = [from.x + r0x * lat0, from.z + r0z * lat0];
  const p1: Vec2 = [to.x + r1x * lat1, to.z + r1z * lat1];
  const turn = turnOf(from.hx, from.hz, to.hx, to.hz);
  let c: Vec2;
  const denom = from.hx * -to.hz - from.hz * -to.hx;
  if (turn === 'uturn' || Math.abs(denom) < 1e-3) {
    const mx = (p0[0] + p1[0]) / 2 + from.hx * (turn === 'uturn' ? 6 : 0);
    const mz = (p0[1] + p1[1]) / 2 + from.hz * (turn === 'uturn' ? 6 : 0);
    c = [mx, mz];
  } else {
    // p0 + t*h0 = p1 - u*h1
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const t = (dx * -to.hz - dz * -to.hx) / denom;
    const tc = clamp(t, 0, Math.hypot(dx, dz));
    c = [p0[0] + from.hx * tc, p0[1] + from.hz * tc];
  }
  let len = 0;
  let [px, pz] = p0;
  for (let k = 1; k <= 8; k++) {
    const [qx, qz] = bez(p0, c, p1, k / 8);
    len += Math.hypot(qx - px, qz - pz);
    px = qx;
    pz = qz;
  }
  return { kind: 'curve', p0, c, p1, len: Math.max(0.5, len), turn };
}
