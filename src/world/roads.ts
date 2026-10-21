import { CELL, DIRS, EDGE, LANE, N, ROAD, roadAt } from '../config.ts';
import { bez, clamp, type Vec2 } from '../util/math.ts';

/** 교차로 격자 좌표 (0..N) */
export type Node = [number, number];

/** AI 차량이 따라가는 한 구간. 직선(교차로 사이) 또는 곡선(교차로 안) */
export interface Segment {
  p0: Vec2;
  p1: Vec2;
  /** 곡선 제어점. null 이면 직선 */
  c: Vec2 | null;
  /** 교차로에서 방향을 바꾸는 구간인지 */
  turn: boolean;
  len: number;
}

export const nodePos = (n: Node): [number, number] => [roadAt(n[0]), roadAt(n[1])];
export const inGrid = (i: number, j: number): boolean => i >= 0 && i <= N && j >= 0 && j <= N;
export const rightOf = (d: number): [number, number] => [-DIRS[d][1], DIRS[d][0]];
export const dirHeading = (d: number): number => Math.atan2(DIRS[d][0], DIRS[d][1]);

/** 교차로 from 에서 방향 d 로 다음 교차로 직전까지 가는 직선 차선 */
export function lineSeg(from: Node, d: number): Segment {
  const [ax, az] = nodePos(from);
  const [dx, dz] = DIRS[d];
  const [rx, rz] = rightOf(d);
  return {
    p0: [ax + dx * EDGE + rx * LANE, az + dz * EDGE + rz * LANE],
    p1: [ax + dx * (CELL - EDGE) + rx * LANE, az + dz * (CELL - EDGE) + rz * LANE],
    c: null,
    turn: false,
    len: CELL - ROAD,
  };
}

/** 교차로 node 안에서 d1 방향으로 들어와 d2 방향으로 나가는 곡선 */
export function curveSeg(node: Node, d1: number, d2: number): Segment {
  const [bx, bz] = nodePos(node);
  const [ax, az] = DIRS[d1];
  const [r1x, r1z] = rightOf(d1);
  const [ex, ez] = DIRS[d2];
  const [r2x, r2z] = rightOf(d2);
  const p0: Vec2 = [bx - ax * EDGE + r1x * LANE, bz - az * EDGE + r1z * LANE];
  const p1: Vec2 = [bx + ex * EDGE + r2x * LANE, bz + ez * EDGE + r2z * LANE];
  let c: Vec2;
  if (d1 === d2) c = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  else if (d2 === (d1 + 2) % 4) c = [bx + ax * EDGE, bz + az * EDGE]; // 유턴
  else c = [bx + (r1x + r2x) * LANE, bz + (r1z + r2z) * LANE];

  let len = 0;
  let [px, pz] = p0;
  for (let k = 1; k <= 8; k++) {
    const [qx, qz] = bez(p0, c, p1, k / 8);
    len += Math.hypot(qx - px, qz - pz);
    px = qx;
    pz = qz;
  }
  return { p0, p1, c, turn: d1 !== d2, len };
}

export function segAt(seg: Segment, s: number): [number, number] {
  const t = clamp(s / seg.len, 0, 1);
  if (!seg.c) return [seg.p0[0] + (seg.p1[0] - seg.p0[0]) * t, seg.p0[1] + (seg.p1[1] - seg.p0[1]) * t];
  return bez(seg.p0, seg.c, seg.p1, t);
}

/** start 에서 goal 까지 가는 단순 경로 (축 하나씩 직진) */
export function routeTo(start: Node, goal: Node): number[] {
  const xs = goal[0] > start[0] ? 1 : 3;
  const zs = goal[1] > start[1] ? 0 : 2;
  const xa = Array<number>(Math.abs(goal[0] - start[0])).fill(xs);
  const za = Array<number>(Math.abs(goal[1] - start[1])).fill(zs);
  return Math.random() < 0.5 ? xa.concat(za) : za.concat(xa);
}

/** 가장 가까운 교차로로 좌표를 맞춤 (리셋용) */
export function snapToNode(x: number, z: number): [number, number] {
  const snap = (v: number) => roadAt(clamp(Math.round((v + N * CELL / 2) / CELL), 0, N));
  return [snap(x), snap(z)];
}
