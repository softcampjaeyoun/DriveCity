import { DIRS, EDGE, LANES, backOf } from '../config.ts';
import { bez, clamp, type Vec2 } from '../util/math.ts';
import type { Node, RoadGraph } from './graph.ts';

export type { Node } from './graph.ts';

/** AI 차량이 따라가는 한 구간. 직선(교차로 사이) 또는 곡선(교차로 안) */
export interface Segment {
  p0: Vec2;
  p1: Vec2;
  /** 곡선 제어점. null 이면 직선 */
  c: Vec2 | null;
  /** 교차로에서 방향을 바꾸는 구간인지 */
  turn: boolean;
  len: number;
  /** 직선 구간의 진행 방향 (오른쪽 벡터 계산용) */
  dir: number;
}

export const rightOf = (d: number): [number, number] => [-DIRS[d][1], DIRS[d][0]];
export const dirHeading = (d: number): number => Math.atan2(DIRS[d][0], DIRS[d][1]);

/** 교차로 from 에서 방향 d 로 다음 교차로 직전까지 가는 직선. lat 은 도로 중앙에서 오른쪽 거리 */
export function lineSeg(g: RoadGraph, from: Node, d: number, lat: number): Segment {
  const [ax, az] = g.pos(from);
  const [dx, dz] = DIRS[d];
  const [rx, rz] = rightOf(d);
  const len = g.edgeLen(from[0], from[1], d);
  return {
    p0: [ax + dx * EDGE + rx * lat, az + dz * EDGE + rz * lat],
    p1: [ax + dx * (len - EDGE) + rx * lat, az + dz * (len - EDGE) + rz * lat],
    c: null,
    turn: false,
    len: len - 2 * EDGE,
    dir: d,
  };
}

/** 교차로 node 안에서 d1 방향으로 들어와 d2 방향으로 나가는 곡선 */
export function curveSeg(g: RoadGraph, node: Node, d1: number, d2: number, latIn: number, latOut: number): Segment {
  const [bx, bz] = g.pos(node);
  const [ax, az] = DIRS[d1];
  const [r1x, r1z] = rightOf(d1);
  const [ex, ez] = DIRS[d2];
  const [r2x, r2z] = rightOf(d2);
  const p0: Vec2 = [bx - ax * EDGE + r1x * latIn, bz - az * EDGE + r1z * latIn];
  const p1: Vec2 = [bx + ex * EDGE + r2x * latOut, bz + ez * EDGE + r2z * latOut];
  let c: Vec2;
  if (d1 === d2) c = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  else if (d2 === backOf(d1)) c = [bx + ax * EDGE, bz + az * EDGE]; // 유턴
  else c = [bx + r1x * latIn + r2x * latOut, bz + r1z * latIn + r2z * latOut];

  let len = 0;
  let [px, pz] = p0;
  for (let k = 1; k <= 8; k++) {
    const [qx, qz] = bez(p0, c, p1, k / 8);
    len += Math.hypot(qx - px, qz - pz);
    px = qx;
    pz = qz;
  }
  return { p0, p1, c, turn: d1 !== d2, len, dir: d2 };
}

export function segAt(seg: Segment, s: number): [number, number] {
  const t = clamp(s / seg.len, 0, 1);
  if (!seg.c) return [seg.p0[0] + (seg.p1[0] - seg.p0[0]) * t, seg.p0[1] + (seg.p1[1] - seg.p0[1]) * t];
  return bez(seg.p0, seg.c, seg.p1, t);
}

/** 가장 가까운 차선 인덱스 */
export const laneIndex = (lat: number): number => (Math.abs(lat - LANES[0]) <= Math.abs(lat - LANES[1]) ? 0 : 1);
