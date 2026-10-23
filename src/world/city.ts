import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/math.ts';
import { aptTextures, arrowTexture, billboardTexture, busLaneTexture, dongTexture, facadeSet, loadMerged, loadTex, shopNameAtlas, signTexture, storefrontTextures, streetSignTexture, subwaySignTexture, SUB_KO, type ArrowKind, type MergedModel } from '../render/assets.ts';
import { withGrime, withParkMask } from '../render/materials.ts';
import { buildTreeSet, hedgeTexture } from '../render/trees.ts';
import { glowTexture, windowTexture } from '../render/textures.ts';
import { isFlat, type Edge, type Node, type RoadGraph } from './graph.ts';
import type { BuildingData, MapIndex, TileData } from './mapdata.ts';
import type { Terrain } from './terrain.ts';
import { pointInRing, type Obstacle } from './collision.ts';
import { CURB_H, hasCurb, laneRoles, rightOf, walkWidth } from './roads.ts';

/** 보행자가 걷는 길 하나: 인도 폴리라인, 횡단보도(인도 끝 → 연석 → 건너편 연석 → 건너편 인도 끝), 교차로 모서리 연결 */
export interface WalkPath {
  /** [x0, z0, x1, z1, ...] */
  pts: number[];
  /** 꼭짓점마다 차도에서 멀어지는 방향 (비킬 때 씀). 횡단보도·연결은 0 */
  nrm: number[];
  cum: number[];
  len: number;
  y: number;
  /** 보행자 밀도 배수. 0 이면 여기서 태어나지 않는다 (횡단보도·연결) */
  crowd: number;
  /** 차도를 건너는 구간 [s0, s1] 과 신호를 볼 교차로·간선 */
  cross?: { s0: number; s1: number; node: Node; edge: number };
}

/** 버스 정류장: 간선 id 와 a 기준 호 길이, 길 어느 쪽인지(+1 = a→b 기준 오른쪽), 대기소 위치 */
export interface BusStop {
  key: string;
  edge: number;
  s: number;
  side: 1 | -1;
  x: number;
  z: number;
}

/** 타일 하나의 도시 메시. 타일이 내려가면 dispose */
export interface TileScene {
  group: THREE.Group;
  obstacles: Obstacle[];
  walks: WalkPath[];
  stops: BusStop[];
  /** 디버그용 개수 (지하철 출입구, 중앙분리대 띠, 주차 차량 ...) */
  counts: Record<string, number>;
  dispose(): void;
  /** 가까운 타일에만 더하는 상세(주차 차량·상호 간판)를 만들 때 쓰는 문맥 */
  ctx: ExtrasCtx;
  /** 상세가 올라와 있으면 그 묶음 */
  extras: { group: THREE.Group; obstacles: Obstacle[]; dispose(): void } | null;
}

/** 타일 상세(buildExtras)에 필요한, buildTile 이 만들어 둔 것들 */
export interface ExtrasCtx {
  tile: TileData;
  g: RoadGraph;
  edges: Edge[];
  inBuilding: (x: number, z: number) => boolean;
  nearestWall: (x: number, z: number, maxD: number) => { px: number; pz: number; nx: number; nz: number; len: number } | null;
}

export interface City {
  /** 타일 메시를 만든다. yield 마다 끊어 여러 프레임에 나눠 돌릴 수 있고, 다 돌면 TileScene 을 돌려준다 */
  buildTile(key: string, tile: TileData, g: RoadGraph, isSignal: (n: Node) => boolean): Generator<string, TileScene>;
  removeTile(key: string): void;
  /** 플레이어 가까운 타일에만 더하는 상세(길가 주차 차량, 상호 간판). 충돌체 목록을 돌려준다. 이미 있으면 null */
  buildExtras(key: string): Generator<string, Obstacle[] | null>;
  removeExtras(key: string): void;
  /** 매 프레임 호출. 고층 빌딩 경고등 깜빡임, 물결 */
  update(t: number): void;
  /** 비가 올 때 노면을 젖은 느낌으로 */
  setWet(wet: boolean): void;
  /** 0 낮 .. 1 밤. 재질 색과 창문·가로등·네온 밝기를 바꾼다 */
  setNight(night: number): void;
  /** 셰이더 미리 컴파일용: 도시가 쓰는 재질 전부와 쓰이는 꼴(인스턴스, 인스턴스 색, 꼭짓점 색, 점) */
  warmMaterials(): WarmMaterial[];
}

export interface WarmMaterial {
  mat: THREE.Material;
  /** InstancedMesh 로도 그린다 */
  inst?: boolean;
  /** 인스턴스 색(instanceColor)을 쓴다 */
  instColor?: boolean;
  /** Points 로 그린다 */
  points?: boolean;
}

const STORE_H = 3.6;
const mixHex = (mat: { color: THREE.Color }, day: number, night: number, k: number) => mat.color.setHex(day).lerp(new THREE.Color(night), k);

/** 삼각형을 모아 BufferGeometry 하나로 */
class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  col: number[] = [];
  /** useColor 일 때 이후 꼭짓점에 찍히는 색 (건물마다 바꿔 같은 질감이라도 톤이 다르게) */
  tint: [number, number, number] = [1, 1, 1];
  readonly useColor: boolean;
  constructor(useColor = false) {
    this.useColor = useColor;
  }
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    if (this.useColor) this.col.push(this.tint[0], this.tint[1], this.tint[2]);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.useColor) geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    return geo;
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
}

/** 폴리라인 각 꼭짓점의 옆 방향(오른쪽) 벡터. 꺾이는 곳은 이음새가 벌어지지 않게 마이터로 늘인다. [nx, nz, ...] */
function sideNormals(pts: number[]): number[] {
  const n = pts.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let nz = 0;
    let count = 0;
    for (const [j0, j1] of [
      [i - 1, i],
      [i, i + 1],
    ]) {
      if (j0 < 0 || j1 >= n) continue;
      const dx = pts[j1 * 2] - pts[j0 * 2];
      const dz = pts[j1 * 2 + 1] - pts[j0 * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l;
      nz += dx / l;
      count++;
    }
    nx /= count || 1;
    nz /= count || 1;
    const l = Math.hypot(nx, nz) || 1;
    const scale = Math.min(1 / Math.max(l, 0.5), 1.6);
    out.push((nx / l) * scale, (nz / l) * scale);
  }
  return out;
}

/** 폴리라인을 따라 폭 2*half 의 띠. u 는 0..1 가로, v 는 길이/vTile. ys 를 주면 꼭짓점마다 그 높이에 y 를 더한다 */
/** 폴리라인을 step 간격 이하로 잘게 나눈다 (지형을 따라가게). 꼭짓점은 그대로 둔다 */
function densify(pts: number[], step: number): number[] {
  const n = pts.length / 2;
  if (n < 2) return pts.slice();
  const out: number[] = [pts[0], pts[1]];
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i * 2];
    const z0 = pts[i * 2 + 1];
    const x1 = pts[i * 2 + 2];
    const z1 = pts[i * 2 + 3];
    const l = Math.hypot(x1 - x0, z1 - z0);
    const k = Math.max(1, Math.ceil(l / step));
    for (let m = 1; m <= k; m++) out.push(x0 + ((x1 - x0) * m) / k, z0 + ((z1 - z0) * m) / k);
  }
  return out;
}

function ribbon(b: GeoBuilder, pts: number[], half: number, y: number, vTile = 8, ys?: number[], groundAt?: (x: number, z: number) => number): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const nrm = sideNormals(pts);
  const left: number[] = [];
  const right: number[] = [];
  const K = Math.max(1, Math.ceil((half * 2) / 4));
  const rows: number[][] = Array.from({ length: K + 1 }, () => []);
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2];
    const pz = pts[i * 2 + 1];
    if (i > 0) cum += Math.hypot(px - pts[i * 2 - 2], pz - pts[i * 2 - 1]);
    const nx = nrm[i * 2];
    const nz = nrm[i * 2 + 1];
    const py = y + (ys && !groundAt ? ys[i] : 0);
    if (groundAt) {
      // 지상 도로: 폭 방향으로도 4m 이하로 나눠 꼭짓점마다 지형을 따른다 (노면 = 지형면, 지형 메시가 뚫고 나오지 않게)
      for (let k = 0; k <= K; k++) {
        const t = k / K;
        const ox = px + nx * half * (t * 2 - 1);
        const oz = pz + nz * half * (t * 2 - 1);
        rows[k].push(b.vertex(ox, y + groundAt(ox, oz), oz, 0, 1, 0, t, cum / vTile));
      }
    } else {
      left.push(b.vertex(px - nx * half, py, pz - nz * half, 0, 1, 0, 0, cum / vTile));
      right.push(b.vertex(px + nx * half, py, pz + nz * half, 0, 1, 0, 1, cum / vTile));
    }
  }
  if (groundAt) {
    for (let k = 0; k < K; k++) for (let i = 0; i < n - 1; i++) b.quad(rows[k][i], rows[k + 1][i], rows[k + 1][i + 1], rows[k][i + 1]);
  } else for (let i = 0; i < n - 1; i++) b.quad(left[i], right[i], right[i + 1], left[i + 1]);
}

/** 교차로 원판을 지형 위 부채꼴로 (4m 고리마다 꼭짓점이 지형을 따른다) */
function discFan(b: GeoBuilder, x: number, z: number, r: number, y: number, groundAt: (x: number, z: number) => number): void {
  const SEG = 20;
  const rings = Math.max(1, Math.ceil(r / 4));
  const center = b.vertex(x, y + groundAt(x, z), z, 0, 1, 0, 0.5, 0.5);
  const ringIdx: number[][] = [];
  for (let q = 1; q <= rings; q++) {
    const rr = (r * q) / rings;
    const row: number[] = [];
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const vx = x + Math.cos(a) * rr;
      const vz = z + Math.sin(a) * rr;
      row.push(b.vertex(vx, y + groundAt(vx, vz), vz, 0, 1, 0, 0.5 + (Math.cos(a) * rr) / (2 * r), 0.5 + (Math.sin(a) * rr) / (2 * r)));
    }
    ringIdx.push(row);
  }
  // (x,z) 기준 시계 방향이 위를 본다: k → k+1 은 반시계(각도 증가)이므로 center, k+1, k 순서
  for (let k = 0; k < SEG; k++) b.idx.push(center, ringIdx[0][(k + 1) % SEG], ringIdx[0][k]);
  for (let q = 1; q < rings; q++) for (let k = 0; k < SEG; k++) b.quad(ringIdx[q - 1][k], ringIdx[q - 1][(k + 1) % SEG], ringIdx[q][(k + 1) % SEG], ringIdx[q][k]);
}

/**
 * 길 양쪽 인도: 차도 가장자리(inner)에서 outer 까지 연석 높이로 올라간 보도 윗면과, 차도 쪽을 향한 연석 수직면.
 * 윗면은 walkB 에, 연석면은 curbB 에 넣는다 (재질이 다르다)
 */
function sidewalk(walkB: GeoBuilder, curbB: GeoBuilder, pts: number[], inner: number, outer: number, groundAt: (x: number, z: number) => number, y: number, sides: readonly number[] = [-1, 1]): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const nrm = sideNormals(pts);
  for (const side of sides) {
    const top: number[] = [];
    const edge: number[] = [];
    const lowA: number[] = [];
    const lowB: number[] = [];
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const px = pts[i * 2];
      const pz = pts[i * 2 + 1];
      if (i > 0) cum += Math.hypot(px - pts[i * 2 - 2], pz - pts[i * 2 - 1]);
      const nx = nrm[i * 2] * side;
      const nz = nrm[i * 2 + 1] * side;
      const ix = px + nx * inner;
      const iz = pz + nz * inner;
      const ox = px + nx * outer;
      const oz = pz + nz * outer;
      const gi = groundAt(ix, iz);
      edge.push(walkB.vertex(ix, gi + y, iz, 0, 1, 0, 0, cum / 3));
      top.push(walkB.vertex(ox, groundAt(ox, oz) + y, oz, 0, 1, 0, (outer - inner) / 3, cum / 3));
      // 연석: 차도 쪽을 향한 수직면 (법선 -n)
      lowA.push(curbB.vertex(ix, gi + 0.015, iz, -nx, 0, -nz, cum / 1.5, 0));
      lowB.push(curbB.vertex(ix, gi + y, iz, -nx, 0, -nz, cum / 1.5, 1));
    }
    for (let i = 0; i < n - 1; i++) {
      if (side > 0) {
        walkB.quad(edge[i], top[i], top[i + 1], edge[i + 1]);
        curbB.quad(lowB[i], lowA[i], lowA[i + 1], lowB[i + 1]);
      } else {
        walkB.quad(top[i], edge[i], edge[i + 1], top[i + 1]);
        curbB.quad(lowA[i], lowB[i], lowB[i + 1], lowA[i + 1]);
      }
    }
  }
}

/** 폴리라인에서 호 길이 [s0, s1] 구간만 잘라낸다 */
function slicePolyline(pts: number[], s0: number, s1: number): number[] {
  const out: number[] = [];
  if (s1 - s0 < 0.2) return out;
  let cum = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i * 2];
    const z0 = pts[i * 2 + 1];
    const dx = pts[i * 2 + 2] - x0;
    const dz = pts[i * 2 + 3] - z0;
    const l = Math.hypot(dx, dz);
    const a = cum;
    const b = cum + l;
    cum = b;
    if (l < 1e-6 || b <= s0 || a >= s1) continue;
    if (!out.length) {
      const t = Math.max(0, (s0 - a) / l);
      out.push(x0 + dx * t, z0 + dz * t);
    }
    if (b <= s1) out.push(x0 + dx, z0 + dz);
    else {
      const t = (s1 - a) / l;
      out.push(x0 + dx * t, z0 + dz * t);
    }
  }
  return out;
}
function polylineLen(pts: number[]): number {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
}
/** 꼭짓점마다 누적 호 길이 */
function cumOf(pts: number[]): number[] {
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  return cum;
}
/** 폴리라인 위 호 길이 s 의 점 */
function ptAt(pts: number[], cum: number[], s: number): [number, number] {
  const n = cum.length;
  if (n < 2) return [pts[0] ?? 0, pts[1] ?? 0];
  const sa = Math.min(Math.max(0, s), cum[n - 1]);
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= sa) lo = mid;
    else hi = mid - 1;
  }
  const l = cum[lo + 1] - cum[lo] || 1;
  const t = (sa - cum[lo]) / l;
  return [pts[lo * 2] + (pts[lo * 2 + 2] - pts[lo * 2]) * t, pts[lo * 2 + 1] + (pts[lo * 2 + 3] - pts[lo * 2 + 1]) * t];
}
/** 폴리라인을 옆으로 off 만큼 민 폴리라인과, 꼭짓점마다 민 방향(단위 벡터) */
function offsetPolyline(pts: number[], off: number): { pts: number[]; nrm: number[] } {
  const nrm = sideNormals(pts);
  const out: number[] = [];
  const dir: number[] = [];
  for (let i = 0; i < pts.length / 2; i++) {
    const nx = nrm[i * 2];
    const nz = nrm[i * 2 + 1];
    out.push(pts[i * 2] + nx * off, pts[i * 2 + 1] + nz * off);
    const l = Math.hypot(nx, nz) || 1;
    const s = Math.sign(off) || 1;
    dir.push((nx / l) * s, (nz / l) * s);
  }
  return { pts: out, nrm: dir };
}

/** 폴리라인을 따라 폭 2*half, 바닥 y0 윗면 y1 인 네모 띠(윗면·양 옆면·양 끝막이). 띠녹지 울타리에 쓴다 */
function extrudeStrip(b: GeoBuilder, pts: number[], half: number, y0: number, y1: number, uvWorld = false, groundAt?: (x: number, z: number) => number): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const nrm = sideNormals(pts);
  const lt: number[] = [];
  const rt: number[] = [];
  const lb: number[] = [];
  const rb: number[] = [];
  const ltS: number[] = [];
  const rtS: number[] = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2];
    const pz = pts[i * 2 + 1];
    if (i > 0) cum += Math.hypot(px - pts[i * 2 - 2], pz - pts[i * 2 - 1]);
    const nx = nrm[i * 2];
    const nz = nrm[i * 2 + 1];
    const v = cum / 2;
    const lx = px - nx * half;
    const lz = pz - nz * half;
    const rx = px + nx * half;
    const rz = pz + nz * half;
    const gl = groundAt ? groundAt(lx, lz) : 0;
    const gr = groundAt ? groundAt(rx, rz) : 0;
    if (uvWorld) {
      // 윗면은 월드 xz(2m 한 장), 옆면은 길이·높이 기준. 옆면은 꼭짓점을 따로 둬 uv 가 섞이지 않게
      lt.push(b.vertex(lx, gl + y1, lz, 0, 1, 0, lx / 2, lz / 2));
      rt.push(b.vertex(rx, gr + y1, rz, 0, 1, 0, rx / 2, rz / 2));
      ltS.push(b.vertex(lx, gl + y1, lz, -nx, 0, -nz, v, y1 / 2));
      rtS.push(b.vertex(rx, gr + y1, rz, nx, 0, nz, v, y1 / 2));
      lb.push(b.vertex(lx, gl + y0, lz, -nx, 0, -nz, v, y0 / 2));
      rb.push(b.vertex(rx, gr + y0, rz, nx, 0, nz, v, y0 / 2));
    } else {
      lt.push(b.vertex(lx, gl + y1, lz, 0, 1, 0, 0, v));
      rt.push(b.vertex(rx, gr + y1, rz, 0, 1, 0, 1, v));
      lb.push(b.vertex(lx, gl + y0, lz, -nx, 0, -nz, 0, v));
      rb.push(b.vertex(rx, gr + y0, rz, nx, 0, nz, 1, v));
    }
  }
  const lts = uvWorld ? ltS : lt;
  const rts = uvWorld ? rtS : rt;
  for (let i = 0; i < n - 1; i++) {
    b.quad(lt[i], rt[i], rt[i + 1], lt[i + 1]);
    b.quad(lb[i], lts[i], lts[i + 1], lb[i + 1]);
    b.quad(rts[i], rb[i], rb[i + 1], rts[i + 1]);
  }
  // 끝막이
  b.quad(lb[0], rb[0], rts[0], lts[0]);
  const e = n - 1;
  b.quad(rb[e], lb[e], lts[e], rts[e]);
}

/** 세워 둔 사각 간판 하나를 b 에 넣는다 (yaw 방향 +Z 를 바라봄, 아틀라스 uv) */
function signQuad(b: GeoBuilder, x: number, y: number, z: number, yaw: number, w: number, h: number, uv: [number, number, number, number]): void {
  const rx = Math.cos(yaw) * w * 0.5;
  const rz = -Math.sin(yaw) * w * 0.5;
  const nx = Math.sin(yaw);
  const nz = Math.cos(yaw);
  const [u0, v0, u1, v1] = uv;
  const a = b.vertex(x - rx, y - h / 2, z - rz, nx, 0, nz, u0, v0);
  const c = b.vertex(x + rx, y - h / 2, z + rz, nx, 0, nz, u1, v0);
  const d = b.vertex(x + rx, y + h / 2, z + rz, nx, 0, nz, u1, v1);
  const e = b.vertex(x - rx, y + h / 2, z - rz, nx, 0, nz, u0, v1);
  b.quad(a, c, d, e);
}

/** 고가 상판 몸체: 윗면·밑면(1.2m 아래)·양 옆면 */
function deckBody(b: GeoBuilder, pts: number[], ys: number[], half: number): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const nrm = sideNormals(pts);
  const T = 1.2;
  const lt: number[] = [];
  const rt: number[] = [];
  const lb: number[] = [];
  const rb: number[] = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2];
    const pz = pts[i * 2 + 1];
    if (i > 0) cum += Math.hypot(px - pts[i * 2 - 2], pz - pts[i * 2 - 1]);
    const nx = nrm[i * 2];
    const nz = nrm[i * 2 + 1];
    const lx = px - nx * half;
    const lz = pz - nz * half;
    const rx = px + nx * half;
    const rz = pz + nz * half;
    const v = cum / 6;
    lt.push(b.vertex(lx, ys[i], lz, 0, 1, 0, 0, v));
    rt.push(b.vertex(rx, ys[i], rz, 0, 1, 0, 1, v));
    lb.push(b.vertex(lx, ys[i] - T, lz, -nx, 0, -nz, 0, v));
    rb.push(b.vertex(rx, ys[i] - T, rz, nx, 0, nz, 1, v));
  }
  for (let i = 0; i < n - 1; i++) {
    b.quad(lt[i], rt[i], rt[i + 1], lt[i + 1]);
    b.quad(rb[i], lb[i], lb[i + 1], rb[i + 1]);
    b.quad(lb[i], lt[i], lt[i + 1], lb[i + 1]);
    b.quad(rt[i], rb[i], rb[i + 1], rt[i + 1]);
  }
}

/**
 * 지하차도: 노면이 지면 아래로 내려간 곳에 양쪽 옹벽, 4.5m 보다 깊으면 천장(-1m)으로 덮는다.
 * mask 에는 트인 구간을 지면 높이로 넣어 바닥 평면에 스텐실 구멍을 낸다
 */
function trench(b: GeoBuilder, mask: GeoBuilder, pts: number[], ys: number[], half: number): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const nrm = sideNormals(pts);
  const OPEN = -0.25;
  const COVER = -4.5;
  const CEIL = -1.0;
  const wo = half + 0.7;
  const mo = half + 0.55;
  const covered = (y: number) => y < COVER;
  const topOf = (y: number) => (covered(y) ? CEIL : 0.5);
  for (let i = 0; i < n - 1; i++) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (y0 > OPEN && y1 > OPEN) continue;
    const corners = (k: number, off: number) => {
      const nx = nrm[k * 2];
      const nz = nrm[k * 2 + 1];
      return [pts[k * 2] - nx * off, pts[k * 2 + 1] - nz * off, pts[k * 2] + nx * off, pts[k * 2 + 1] + nz * off, nx, nz] as const;
    };
    const [lx0, lz0, rx0, rz0, nx0, nz0] = corners(i, wo);
    const [lx1, lz1, rx1, rz1, nx1, nz1] = corners(i + 1, wo);
    const t0 = topOf(y0);
    const t1 = topOf(y1);
    // 옹벽 (안쪽을 향한 법선)
    const lf0 = b.vertex(lx0, y0, lz0, nx0, 0, nz0, 0, y0);
    const lf1 = b.vertex(lx1, y1, lz1, nx1, 0, nz1, 1, y1);
    const lt0 = b.vertex(lx0, t0, lz0, nx0, 0, nz0, 0, t0);
    const lt1 = b.vertex(lx1, t1, lz1, nx1, 0, nz1, 1, t1);
    b.quad(lf0, lf1, lt1, lt0);
    const rf0 = b.vertex(rx0, y0, rz0, -nx0, 0, -nz0, 0, y0);
    const rf1 = b.vertex(rx1, y1, rz1, -nx1, 0, -nz1, 1, y1);
    const rt0 = b.vertex(rx0, t0, rz0, -nx0, 0, -nz0, 0, t0);
    const rt1 = b.vertex(rx1, t1, rz1, -nx1, 0, -nz1, 1, t1);
    b.quad(rt0, rt1, rf1, rf0);
    if (covered(y0) && covered(y1)) {
      // 천장 (아래를 향한 법선)
      const a = b.vertex(lx0, CEIL, lz0, 0, -1, 0, 0, 0);
      const c = b.vertex(rx0, CEIL, rz0, 0, -1, 0, 1, 0);
      const d = b.vertex(rx1, CEIL, rz1, 0, -1, 0, 1, 1);
      const e = b.vertex(lx1, CEIL, lz1, 0, -1, 0, 0, 1);
      b.quad(a, c, d, e);
    } else if (covered(y0) !== covered(y1)) {
      // 터널 입구 상인방: 천장 높이에서 지면 위 0.5m 까지 가로막
      const k = covered(y1) ? i + 1 : i;
      const [lx, lz, rx, rz] = corners(k, wo);
      const a = b.vertex(lx, CEIL, lz, 0, 0, 1, 0, 0);
      const c = b.vertex(rx, CEIL, rz, 0, 0, 1, 1, 0);
      const d = b.vertex(rx, 0.5, rz, 0, 0, 1, 1, 1);
      const e = b.vertex(lx, 0.5, lz, 0, 0, 1, 0, 1);
      b.quad(a, c, d, e);
    }
    if (!covered(y0) || !covered(y1)) {
      // 트인 구간: 바닥 평면 구멍
      const [mlx0, mlz0, mrx0, mrz0] = corners(i, mo);
      const [mlx1, mlz1, mrx1, mrz1] = corners(i + 1, mo);
      const a = mask.vertex(mlx0, 0, mlz0, 0, 1, 0);
      const c = mask.vertex(mrx0, 0, mrz0, 0, 1, 0);
      const d = mask.vertex(mrx1, 0, mrz1, 0, 1, 0);
      const e = mask.vertex(mlx1, 0, mlz1, 0, 1, 0);
      mask.quad(a, c, d, e);
    }
  }
}

function ringCentroid(ring: number[]): [number, number] {
  let x = 0;
  let z = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i];
    z += ring[i + 1];
  }
  return [x / (ring.length / 2), z / (ring.length / 2)];
}
function ringBounds(ring: number[]): [number, number, number, number] {
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
  return [minX, maxX, minZ, maxZ];
}
function ringAreaAbs(ring: number[]): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return Math.abs(a / 2);
}

/** 점에서 폴리라인까지의 거리 */
function distToPolyline(pts: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 2; i += 2) {
    const x0 = pts[i];
    const z0 = pts[i + 1];
    const dx = pts[i + 2] - x0;
    const dz = pts[i + 3] - z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
    best = Math.min(best, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
  }
  return best;
}

/** 바깥 고리와 안쪽 고리 사이의 평면 띠 (경기장 지붕 링). 두 고리는 같은 꼭짓점 수여야 한다 */
/** 고리를 안쪽으로 d 만큼 민 고리 (파라펫 윗면 띠용). 꺾임이 심한 꼭짓점은 마이터를 3d 로 제한 */
function insetRing(ring: number[], d: number): number[] | null {
  const n = ring.length / 2;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  // 넓이가 양수(반시계)면 안쪽은 변의 왼쪽
  const sgn = area > 0 ? 1 : -1;
  const edgeN = (i: number): [number, number] | null => {
    const j = (i + 1) % n;
    const dx = ring[j * 2] - ring[i * 2];
    const dz = ring[j * 2 + 1] - ring[i * 2 + 1];
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return null;
    return [(-dz / len) * sgn, (dx / len) * sgn];
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = edgeN((i - 1 + n) % n);
    const b = edgeN(i);
    const na = a ?? b;
    const nb = b ?? a;
    if (!na || !nb) return null;
    let mx = na[0] + nb[0];
    let mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) {
      mx = na[0];
      mz = na[1];
    } else {
      mx /= ml;
      mz /= ml;
    }
    const cosHalf = Math.max(1 / 3, mx * na[0] + mz * na[1]);
    out.push(ring[i * 2] + (mx * d) / cosHalf, ring[i * 2 + 1] + (mz * d) / cosHalf);
  }
  return out;
}

function ringBand(b: GeoBuilder, outer: number[], inner: number[], y: number, uvScale = 6): void {
  const n = outer.length / 2;
  const o: number[] = [];
  const i2: number[] = [];
  for (let i = 0; i < n; i++) {
    o.push(b.vertex(outer[i * 2], y, outer[i * 2 + 1], 0, 1, 0, outer[i * 2] / uvScale, outer[i * 2 + 1] / uvScale));
    i2.push(b.vertex(inner[i * 2], y, inner[i * 2 + 1], 0, 1, 0, inner[i * 2] / uvScale, inner[i * 2 + 1] / uvScale));
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += outer[i * 2] * outer[j * 2 + 1] - outer[j * 2] * outer[i * 2 + 1];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (area < 0) b.quad(o[i], o[j], i2[j], i2[i]);
    else b.quad(o[j], o[i], i2[i], i2[j]);
  }
}

/** 평면 폴리곤 (지붕, 물, 공원). 고리 방향이 어느 쪽이든 윗면이 위를 보게 맞춘다 (뒤집히면 양면 재질이라도 법선이 아래를 봐 검게 나온다) */
function flatPolygon(b: GeoBuilder, ring: number[], y: number, uvScale = 20, groundAt?: (x: number, z: number) => number): void {
  let area = 0;
  const m = ring.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  const contour: THREE.Vector2[] = [];
  if (area > 0) for (let i = m - 1; i >= 0; i--) contour.push(new THREE.Vector2(ring[i * 2], ring[i * 2 + 1]));
  else for (let i = 0; i < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return;
  }
  const base = b.pos.length / 3;
  for (const p of contour) b.vertex(p.x, y + (groundAt ? groundAt(p.x, p.y) : 0), p.y, 0, 1, 0, p.x / uvScale, p.y / uvScale);
  // earcut 은 입력 방향과 상관없이 한 방향으로 삼각형을 낸다. (x,z) 기준 시계 방향이어야 위를 보니 아니면 뒤집는다
  for (const f of faces) {
    const a = contour[f[0]];
    const c = contour[f[1]];
    const d = contour[f[2]];
    const up = (c.x - a.x) * (d.y - a.y) - (d.x - a.x) * (c.y - a.y) < 0;
    if (up) b.idx.push(base + f[0], base + f[1], base + f[2]);
    else b.idx.push(base + f[0], base + f[2], base + f[1]);
  }
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  w: number;
  h: number;
  d?: number;
}
function placeInstances(mesh: THREE.InstancedMesh, list: Placement[], dummy: THREE.Object3D): void {
  list.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.yaw, 0);
    dummy.scale.set(p.w, p.h, p.d ?? 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
}

export function createCity(scene: THREE.Scene, index: MapIndex, renderer?: THREE.WebGLRenderer, terrain?: Terrain): City {
  /** 지형 높이 (한강 수면 0). 지형이 없으면 0 */
  const terrainAt = (x: number, z: number): number => (terrain ? terrain.at(x, z) : 0);
  const dummy = new THREE.Object3D();
  const { minX, maxX, minZ, maxZ } = index.bbox;
  const spanX = maxX - minX + 2400;
  const spanZ = maxZ - minZ + 2400;

  // ----- 전체 공유: 바닥, 재질 -----
  // 바닥은 스텐실 1 인 곳(지하차도 트인 구간, maskMat 이 먼저 찍는다)을 비워 둔다
  // polygonOffset: 도로(2cm 위)·차선·언더글로우가 지면에 묻히지 않게 지면을 깊이에서 살짝 뒤로.
  // 지면은 250m 격자로 잘게 나눈다 — 20km 짜리 삼각형 두 장이면 카메라 근처에서 깊이 보간 오차가 2cm 를 넘어 도로를 덮는다
  // 지형 재질: 콘크리트 질감 + 월드 얼룩, 공원 꼭짓점(park 속성)은 잔디. 타일마다 terrain.geometry 로 메시를 만든다 (uv 는 월드 /10)
  const groundMat = withParkMask(
    withGrime(new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 1, 1), roughness: 0.95, color: 0x85878b, stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), { scale: 90, strength: 0.4, detail: 11 }),
    loadTex('Grass004_Color.jpg', true, 1, 1),
    4,
  );
  // 맵 밖·타일 없는 곳의 배경 바닥 (지형 아래 3m)
  const backdropMat = new THREE.MeshStandardMaterial({ color: 0x66686c, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(spanX, spanZ, Math.ceil(spanX / 250), Math.ceil(spanZ / 250)), backdropMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((minX + maxX) / 2, -3, (minZ + maxZ) / 2);
  ground.receiveShadow = true;
  ground.renderOrder = -1;
  scene.add(ground);
  const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });

  const ripple = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(256, 256);
    const r = mulberry32(99);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + r() * 60;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(60, 60);
    return t;
  })();
  const waterMat = new THREE.MeshPhongMaterial({ color: 0x1a3a66, emissive: 0x0f2a52, shininess: 90, specular: 0x8aa8d8, bumpMap: ripple, bumpScale: 0.6, side: THREE.DoubleSide });
  // 잔디: 공원 바닥, 중앙분리대, 경기장 필드. 사진 질감 + 월드 얼룩으로 단색 느낌을 없앤다
  const grassSet = () => ({ map: loadTex('Grass004_Color.jpg', true, 1, 1), normalMap: loadTex('Grass004_NormalGL.jpg', false, 1, 1), roughnessMap: loadTex('Grass004_Roughness.jpg', false, 1, 1), roughness: 1, metalness: 0 });
  const parkMat = withGrime(new THREE.MeshStandardMaterial({ ...grassSet(), color: 0x8f9a7e, side: THREE.DoubleSide }), { scale: 50, strength: 0.4, detail: 6 });
  const grassMat = withGrime(new THREE.MeshStandardMaterial({ ...grassSet(), color: 0x9aa684 }), { scale: 30, strength: 0.35, detail: 5 });
  const fieldMat = withGrime(new THREE.MeshStandardMaterial({ ...grassSet(), color: 0xa6bb8e }), { scale: 20, strength: 0.15, detail: 0 });
  const railMat = new THREE.MeshLambertMaterial({ color: 0x23262e, side: THREE.DoubleSide });
  const roadMat = withGrime(new THREE.MeshStandardMaterial({ map: loadTex('Asphalt033_Color.jpg', true, 1, 1), normalMap: loadTex('Asphalt033_NormalGL.jpg', false, 1, 1), roughnessMap: loadTex('Asphalt033_Roughness.jpg', false, 1, 1), roughness: 1, color: 0x8e9095 }), { scale: 45, strength: 0.38, detail: 6 });
  // 인도 보도블록 uv 는 m 단위(2m 마다 한 장). 연석은 화강석, 띠녹지는 회양목 울타리
  // 인도·연석도 스텐실 1(지하철 출입구 계단 구멍)인 곳은 비운다
  const walkMat = withGrime(new THREE.MeshStandardMaterial({ map: loadTex('PavingStones136_Color.jpg', true, 2.5, 2.5), normalMap: loadTex('PavingStones136_NormalGL.jpg', false, 2.5, 2.5), roughnessMap: loadTex('PavingStones136_Roughness.jpg', false, 2.5, 2.5), roughness: 1, color: 0x9f9e98, stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: 1 }), { scale: 28, strength: 0.32, detail: 4.5 });
  const curbMat = withGrime(new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 1, 1), color: 0xa9aaa6, roughness: 0.85, side: THREE.DoubleSide, stencilWrite: true, stencilFunc: THREE.NotEqualStencilFunc, stencilRef: 1 }), { scale: 25, strength: 0.35, detail: 3 });
  const hedgeMat = new THREE.MeshStandardMaterial({ map: hedgeTexture(), roughness: 0.92, color: 0xb0b8a2 });
  const grateMat = new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.6, metalness: 0.5 });
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.35, metalness: 0.7 });
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  // 고가 상판·교각 콘크리트, 지하차도 옹벽·천장
  const deckMat = new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 1, 1), roughness: 0.95, color: 0x9a9ca2, side: THREE.DoubleSide });
  const tunnelMat = new THREE.MeshStandardMaterial({ color: 0x61646c, roughness: 0.95, side: THREE.DoubleSide });
  const bridgeRailMat = new THREE.MeshLambertMaterial({ color: 0x8b93a3 });
  // 차선 페인트: 얼룩을 세게 줘 군데군데 닳은 느낌
  const paintGrime = { scale: 18, strength: 0.55, detail: 2.5 };
  const yellowMat = withGrime(new THREE.MeshStandardMaterial({ color: 0xc9a63d, roughness: 0.75 }), paintGrime);
  const whiteMat = withGrime(new THREE.MeshStandardMaterial({ color: 0xd6d8d4, roughness: 0.75 }), paintGrime);
  const barMat = withGrime(new THREE.MeshStandardMaterial({ color: 0xdfe1dd, roughness: 0.75 }), paintGrime);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4f5a });
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTexture('rgba(255,170,80,0.42)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const haloMat = new THREE.PointsMaterial({ size: 7, map: glowTexture('rgba(255,190,110,1)'), color: 0xffb35c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3040 });
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x3a3f4a });
  const hvacMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.7 });
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xc9b98a, roughness: 0.8 });
  const shelterMat = new THREE.MeshStandardMaterial({ color: 0x3b4451, roughness: 0.5, metalness: 0.3 });
  const shelterGlassMat = new THREE.MeshPhongMaterial({ color: 0x9fc0e0, transparent: true, opacity: 0.45, shininess: 120 });
  const shelterSignMat = new THREE.MeshBasicMaterial({ color: 0x1f6fd1 });
  const manholeMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.6, metalness: 0.5 });
  const arrowKinds: ArrowKind[] = ['straight', 'left', 'right', 'straightRight', 'straightLeft', 'leftRight'];
  const arrowMats = Object.fromEntries(arrowKinds.map((k) => [k, withGrime(new THREE.MeshBasicMaterial({ map: arrowTexture(k), transparent: true, depthWrite: false, color: 0xd9dbd8 }), paintGrime)])) as Record<ArrowKind, THREE.MeshBasicMaterial>;
  // 버스전용차로 도색(파랑)과 글씨
  const busLaneMat = withGrime(new THREE.MeshBasicMaterial({ color: 0x3a62a3, transparent: true, opacity: 0.42, depthWrite: false }), { scale: 22, strength: 0.6, detail: 3.5 });
  const busTextMat = withGrime(new THREE.MeshBasicMaterial({ map: busLaneTexture(), transparent: true, depthWrite: false, color: 0xd9dbd8 }), paintGrime);
  // 거리 소품: 쓰레기통, 변압기함. 경기장 필드, 돔, 첨탑
  const trashMat = new THREE.MeshStandardMaterial({ color: 0x2f5a3a, roughness: 0.7 });
  const utilityBoxMat = new THREE.MeshStandardMaterial({ color: 0x7c8a80, roughness: 0.6, metalness: 0.2 });
  const standMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a8, side: THREE.DoubleSide });
  const domeMat = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.5, metalness: 0.2 });
  const spireMat = new THREE.MeshStandardMaterial({ color: 0x3b4f7a, roughness: 0.6 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xe8ecf4, roughness: 0.3, metalness: 0.4 });
  /** 상호 간판 아틀라스 재질 (타일마다 하나). 밤낮 밝기 조절을 위해 모아 둔다 */
  const shopMats = new Set<THREE.MeshBasicMaterial>();
  /** 캔버스 텍스처를 미리 GPU 에 올려 첫 렌더링 프레임이 멈칫하지 않게 */
  const prewarm = (t: THREE.Texture) => renderer?.initTexture(t);
  /** 지하철·도로명 표지 텍스처는 이름마다 하나 (타일을 넘어 공유, 너무 많아지면 비운다) */
  const cachedSignMat = (cache: Map<string, THREE.MeshBasicMaterial>, name: string, draw: (name: string) => THREE.Texture) => {
    let m = cache.get(name);
    if (!m) {
      if (cache.size > 400) {
        for (const old of cache.values()) {
          old.map?.dispose();
          old.dispose();
        }
        cache.clear();
      }
      const map = draw(name);
      prewarm(map);
      m = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
      cache.set(name, m);
    }
    return m;
  };
  const subwayMats = new Map<string, THREE.MeshBasicMaterial>();
  const subwayMat = (name: string) => cachedSignMat(subwayMats, name, subwaySignTexture);
  const streetSignMats = new Map<string, THREE.MeshBasicMaterial>();
  const streetSignMat = (name: string) => cachedSignMat(streetSignMats, name, streetSignTexture);

  const windows = (seed: number) => {
    const t = windowTexture(seed);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const wallGrime = { scale: 35, strength: 0.14, detail: 0, baseHeight: 4.5, baseStrength: 0.32 };
  const stdWall = (set: ReturnType<typeof facadeSet>, seed: number, roughness = 0.75, metalness = 0) =>
    withGrime(new THREE.MeshStandardMaterial({ map: set.map, normalMap: set.normalMap, normalScale: new THREE.Vector2(1.4, 1.4), emissive: 0xffffff, emissiveMap: set.emissiveMap ?? windows(seed), emissiveIntensity: 0, roughness, metalness, vertexColors: true }), wallGrime);
  const glass1 = stdWall(facadeSet('Facade001', 16, 16, false), 11, 0.28, 0.25);
  const glass2 = stdWall(facadeSet('Facade005', 12, 12, false), 12, 0.3, 0.2);
  const office = stdWall(facadeSet('Facade006', 14, 16, false), 13, 0.6);
  const brick1 = stdWall(facadeSet('Facade018A', 12, 14, true), 14);
  const brick2 = stdWall(facadeSet('Facade019A', 12, 14, true), 15);
  const brick3 = stdWall(facadeSet('Facade020A', 12, 14, true), 16);
  const nightOffice = stdWall(facadeSet('Facade013', 16, 18, true), 17, 0.45, 0.1);
  const aptWalls = [1, 2, 3].map((s) => {
    const t = aptTextures(s);
    t.map.repeat.set(1, 1);
    t.emissive.repeat.set(1, 1);
    return withGrime(new THREE.MeshStandardMaterial({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.85, vertexColors: true }), wallGrime);
  });
  const storeWalls = [1, 2, 3, 4].map((s) => {
    const t = storefrontTextures(s);
    return withGrime(new THREE.MeshStandardMaterial({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.38, metalness: 0.08, vertexColors: true }), { scale: 20, strength: 0.1, detail: 0, baseHeight: 1.2, baseStrength: 0.3 });
  });
  const towerSet = [glass1, glass2, office, nightOffice];
  const blockSet = [office, brick1, brick2, brick3];
  const lowSet = [brick1, brick2, brick3, office];
  const allWalls = [glass1, glass2, office, brick1, brick2, brick3, nightOffice, ...aptWalls, ...storeWalls];
  const roofMat = withGrime(new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 3.3, 3.3), roughness: 0.95, color: 0x87898d, side: THREE.DoubleSide }), { scale: 18, strength: 0.4, detail: 4 });
  // 옥상 가장자리 파라펫(낮은 난간벽)과 상가 차양
  const parapetMat = withGrime(new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 1, 1), roughness: 0.9, color: 0x9a9b9e, side: THREE.DoubleSide }), { scale: 12, strength: 0.35, detail: 2 });
  const awningMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
  const AWNING_COLORS = [0x8c1d1d, 0x1f3a6b, 0x2f5a3a, 0xb8872c, 0x3a3a3a, 0x9b2d4a, 0xe8e2d4, 0x1d4e8c];
  /** 건물 종류별 외벽 틴트 후보 (같은 질감 텍스처라도 동마다 톤이 다르게) */
  const TINTS: Record<string, Array<[number, number, number]>> = {
    tower: [[1, 1, 1], [0.86, 0.9, 0.96], [0.9, 0.95, 0.92], [0.97, 0.95, 0.9], [0.78, 0.8, 0.84], [0.68, 0.72, 0.78]],
    block: [[1, 1, 1], [0.95, 0.92, 0.86], [0.86, 0.88, 0.9], [0.9, 0.86, 0.8], [0.8, 0.8, 0.8], [1, 0.97, 0.92], [0.74, 0.72, 0.7]],
    low: [[1, 1, 1], [0.95, 0.92, 0.86], [0.88, 0.88, 0.88], [0.9, 0.86, 0.8], [0.78, 0.76, 0.74], [1, 0.97, 0.92], [0.7, 0.68, 0.66]],
    apt: [[1, 1, 1], [1, 0.98, 0.93], [0.92, 0.93, 0.95], [0.93, 0.99, 0.94], [0.92, 0.95, 1], [0.97, 0.94, 0.9]],
  };
  const tempColor = new THREE.Color();
  const SIGN_VARIANTS = 12;
  const signMats = Array.from({ length: SIGN_VARIANTS }, (_, v) => new THREE.MeshBasicMaterial({ map: signTexture(v + 1), side: THREE.DoubleSide }));
  const BILL_VARIANTS = 5;
  const billMats = Array.from({ length: BILL_VARIANTS }, (_, v) => new THREE.MeshBasicMaterial({ map: billboardTexture(v + 1), side: THREE.DoubleSide }));
  const dongMats = Array.from({ length: 12 }, (_, v) => new THREE.MeshBasicMaterial({ map: dongTexture(101 + v), transparent: true, side: THREE.DoubleSide }));
  const allSignMats = [...signMats, ...billMats];

  const unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const plane = new THREE.PlaneGeometry(1, 1);
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const beaconGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  // 차양: 벽(z=0)에서 바깥(+z)으로 1m 뻗으며 끝이 처진다. 인스턴스 scale 로 폭·깊이를 맞춘다
  const awningGeo = new THREE.BoxGeometry(1, 0.05, 1).translate(0, 0, 0.5).rotateX(0.32);
  const railGeo = new THREE.BoxGeometry(0.25, 1.0, 3);
  // 가로등: 8m 기둥 + 차도 쪽(+Z)으로 뻗은 팔 + 등갓. 등갓 아래 렌즈는 따로 밤에 밝힌다
  const lampGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.08, 0.14, 8, 7).translate(0, 4, 0),
    new THREE.BoxGeometry(0.1, 0.1, 2.6).translate(0, 0, 1.3).rotateX(-0.16).translate(0, 7.75, 0),
    new THREE.BoxGeometry(0.46, 0.16, 0.95).translate(0, 8.12, 2.5),
  ])!;
  const lensGeo = new THREE.BoxGeometry(0.34, 0.05, 0.7).translate(0, 8.03, 2.5);
  const bollardGeo = mergeGeometries([new THREE.CylinderGeometry(0.07, 0.075, 0.85, 8).translate(0, 0.425, 0), new THREE.SphereGeometry(0.075, 8, 6).translate(0, 0.85, 0)])!;
  const grateGeo = new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);
  const trashGeo = new THREE.CylinderGeometry(0.26, 0.24, 0.84, 10);
  const domeGeo = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const coneGeo = new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0);
  const poolGeo = new THREE.PlaneGeometry(17, 17).rotateX(-Math.PI / 2);
  const tankGeo = new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10);
  const manholeGeo = new THREE.CircleGeometry(0.4, 12).rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);

  // ----- 나무 모델 (절차 생성, 한 번만) -----
  const treeSet = buildTreeSet();

  // ----- 길가 주차 차량 모델 (Kenney 승용차 몇 종, 한 번만 로드) -----
  let carModels: Array<{ m: MergedModel; scale: number; yOff: number }> | null = null;
  const carWaiters: Array<() => void> = [];
  void (async () => {
    const base = `${import.meta.env.BASE_URL}models/kenney/`;
    const defs: Array<[string, number]> = [
      ['sedan', 4.2],
      ['suv', 4.4],
      ['hatchback-sports', 3.9],
      ['van', 4.6],
      ['sedan-sports', 4.3],
    ];
    const loaded = await Promise.all(defs.map(async ([name, len]) => {
      const m = await loadMerged(`${base}${name}.glb`, (mat) => {
        mat.roughness = 0.42;
        mat.metalness = 0.2;
        mat.envMapIntensity = 1.1;
      });
      if (!m) return null;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      const scale = len / (bb.max.z - bb.min.z || 1);
      return { m, scale, yOff: -bb.min.y * scale };
    }));
    carModels = loaded.filter((c): c is NonNullable<typeof c> => !!c);
    for (const w of carWaiters) w();
    carWaiters.length = 0;
  })();

  const tiles = new Map<string, TileScene>();
  /** 타일마다 나중에 더 넣은 메시의 정리 목록 (미뤄 둔 교차로 모서리) */
  const tileDisposables = new Map<string, Array<{ dispose(): void }>>();
  /** 이웃 타일이 아직 없어 미뤄 둔 교차로 모서리 노드들 */
  const pendingCorners = new Map<string, Node[]>();
  const tileKeys = new Set(index.tiles.map((t) => `${t.i}_${t.j}`));
  const T = index.tile;
  const tileAtPos = (x: number, z: number): [number, number] => [Math.floor((x - minX) / T), Math.floor((z - minZ) / T)];
  /** (x,z) 주변 45m 안에 걸치는 타일이 (지도에 있다면) 모두 로드됐는지 */
  const neighborsLoaded = (x: number, z: number, self: string): boolean => {
    for (const dx of [-45, 0, 45]) {
      for (const dz of [-45, 0, 45]) {
        const [i, j] = tileAtPos(x + dx, z + dz);
        const k = `${i}_${j}`;
        if (k !== self && tileKeys.has(k) && !tiles.has(k)) return false;
      }
    }
    return true;
  };
  /** 마지막으로 타일을 만든 그래프 (미뤄 둔 모서리를 나중에 그릴 때 노드 위치를 찾는다) */
  let lastGraph: RoadGraph | null = null;

  function* buildTile(key: string, tile: TileData, g: RoadGraph, isSignal: (n: Node) => boolean): Generator<string, TileScene> {
    const rand = mulberry32(20261021 + tile.i * 7919 + tile.j * 104729);
    const group = new THREE.Group();
    group.name = `tile:${key}`;
    const obstacles: Obstacle[] = [];
    const walks: TileScene['walks'] = [];
    const busStops: BusStop[] = [];
    const counts: Record<string, number> = {};
    const count = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
    const disposables: Array<{ dispose(): void }> = [];
    const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], shadow = false): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.castShadow = shadow;
      group.add(m);
      disposables.push(geo);
      return m;
    };
    const addInstanced = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], list: Placement[], y: (p: Placement) => number = (p) => p.y, shadow = false): THREE.InstancedMesh | null => {
      if (!list.length) return null;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      placeInstances(
        mesh,
        list.map((p) => ({ ...p, y: y(p) })),
        dummy,
      );
      mesh.castShadow = shadow;
      group.add(mesh);
      return mesh;
    };
    const edges = tile.edges.map((d) => g.edge(d.id)).filter((e): e is NonNullable<typeof e> => !!e);

    // ----- 지형, 물, 공원, 철도 -----
    {
      const tg = terrain?.geometry(tile, true);
      if (tg) {
        const tm = addMesh(tg, groundMat);
        tm.renderOrder = -1;
        tm.name = 'terrain';
      }
      const wb = new GeoBuilder();
      for (const ring of tile.water) flatPolygon(wb, ring, 0.04);
      if (!wb.empty) addMesh(wb.build(), waterMat).name = 'water';
      // 큰 공원은 지형 메시의 잔디 마스크로 그린다. 격자(25m)보다 작은 공원만 폴리곤으로
      const pb = new GeoBuilder();
      for (const ring of tile.parks) if (!tg || ringAreaAbs(ring) < 15000) flatPolygon(pb, ring, 0.05, 2.5, terrainAt);
      if (!pb.empty) addMesh(pb.build(), parkMat);
      const rb = new GeoBuilder();
      for (const pts of tile.rails) {
        const dp = densify(pts, 10);
        const ys: number[] = [];
        for (let i = 0; i < dp.length; i += 2) ys.push(terrainAt(dp[i], dp[i + 1]));
        ribbon(rb, dp, 2.4, 0.012, 8, ys);
      }
      if (!rb.empty) addMesh(rb.build(), railMat);
    }
    yield 'water';

    // 건물 AABB 격자: 가로수·간판이 건물 안에 들어가지 않게
    const bGrid = new Map<string, number[][]>();
    for (const bd of tile.buildings) {
      const [x0, x1, z0, z1] = ringBounds(bd.ring);
      for (let i = Math.floor(x0 / 40); i <= Math.floor(x1 / 40); i++) {
        for (let j = Math.floor(z0 / 40); j <= Math.floor(z1 / 40); j++) {
          const k = `${i},${j}`;
          const l = bGrid.get(k) ?? [];
          l.push(bd.ring);
          bGrid.set(k, l);
        }
      }
    }
    const inBuilding = (x: number, z: number): boolean => {
      for (const ring of bGrid.get(`${Math.floor(x / 40)},${Math.floor(z / 40)}`) ?? []) if (pointInRing(ring, x, z)) return true;
      return false;
    };
    /** 점에서 가장 가까운 건물 벽: 벽 위 점, 바깥 법선, 벽 길이 */
    const nearestWall = (x: number, z: number, maxD: number): { px: number; pz: number; nx: number; nz: number; len: number } | null => {
      let best: { px: number; pz: number; nx: number; nz: number; len: number; d: number } | null = null;
      const cx = Math.floor(x / 40);
      const cz = Math.floor(z / 40);
      const seen = new Set<number[]>();
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const ring of bGrid.get(`${cx + i},${cz + j}`) ?? []) {
            if (seen.has(ring)) continue;
            seen.add(ring);
            const [ccx, ccz] = ringCentroid(ring);
            const n = ring.length / 2;
            for (let k = 0; k < n; k++) {
              const m = (k + 1) % n;
              const x0 = ring[k * 2];
              const z0 = ring[k * 2 + 1];
              const dx = ring[m * 2] - x0;
              const dz = ring[m * 2 + 1] - z0;
              const l2 = dx * dx + dz * dz;
              if (l2 < 2.25) continue;
              const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
              const px = x0 + dx * t;
              const pz = z0 + dz * t;
              const d = Math.hypot(x - px, z - pz);
              if (d > maxD || (best && d >= best.d)) continue;
              const l = Math.sqrt(l2);
              let nx = dz / l;
              let nz = -dx / l;
              if (nx * (px - ccx) + nz * (pz - ccz) < 0) {
                nx = -nx;
                nz = -nz;
              }
              best = { px, pz, nx, nz, len: l, d };
            }
          }
        }
      }
      return best;
    };

    /** 간선을 8m 간격으로 촘촘히 잘라 노면 높이(지형·고가·지하)를 따라간다 */
    const pathCache = new Map<number, { pts: number[]; ys: number[] }>();
    const pathOf = (e: Edge): { pts: number[]; ys: number[] } => {
      let p = pathCache.get(e.id);
      if (p) return p;
      const ss = new Set<number>(e.cum);
      for (let s = 0; s < e.len; s += 3) ss.add(s);
      ss.add(e.len);
      const pts: number[] = [];
      const ys: number[] = [];
      for (const s of [...ss].sort((a, b) => a - b)) {
        const q = g.pointAt(e, 1, s);
        pts.push(q.x, q.z);
        ys.push(q.y);
      }
      p = { pts, ys };
      pathCache.set(e.id, p);
      return p;
    };

    /** 지상 간선의 노면 높이는 그 자리 지형(도로 띠가 지형을 따른다), 고가·지하는 중심선 높이 */
    const roadY = (e: Edge, py: number, x: number, z: number): number => (isFlat(e) ? terrainAt(x, z) : py);
    /** 인도 위 높이. 지상 큰길·동네길은 연석만큼, 골목·고가·지하는 노면 */
    const walkY = (e: Edge) => (isFlat(e) && hasCurb(e.rank) ? CURB_H : 0);
    /** 버스 정류장이 선 자리(간선 id → 호 길이). 띠녹지를 여기선 끊는다 */
    const hedgeGaps = new Map<number, number[]>();
    /** 교차로 원판 반지름 */
    const discR = (n: Node): number => {
      let r = 0;
      let cut = 0;
      for (const e of g.edgesAt(n)) {
        r = Math.max(r, e.half);
        cut = Math.max(cut, g.cut(e, n));
      }
      return r + cut * 0.5 + 0.6;
    };
    /** 간선 e 가 노드 n 에서 벗어나는 방향 */
    const awayDir = (e: Edge, n: Node): [number, number] => {
      const p = g.pointAt(e, e.a === n ? 1 : -1, Math.min(3, e.len * 0.5));
      return [p.hx, p.hz];
    };
    /**
     * 노드 n 에서 간선 e 의 인도가 시작되는 거리. 교차하는 다른 길의 인도 바깥까지 물러나(겹치지 않게)
     * 교차로 원판 밖에서 시작한다. 거의 나란한 길(직진 연속·타일 경계)만 있으면 0
     */
    const trimAt = (n: Node, e: Edge): number => {
      const [hx, hz] = awayDir(e, n);
      const [rx, rz] = rightOf(hx, hz);
      const half = e.half;
      let t = 0;
      let crossing = false;
      for (const o of g.edgesAt(n)) {
        if (o.id === e.id) continue;
        const [ox, oz] = awayDir(o, n);
        const [onx, onz] = rightOf(ox, oz);
        const dn = hx * onx + hz * onz;
        if (Math.abs(dn) < 0.35) continue;
        crossing = true;
        const nn = rx * onx + rz * onz;
        const oW = o.half + (isFlat(o) ? walkWidth(o.rank) : 0.3) + 0.3;
        for (const sd of [-1, 1]) for (const w of [half + 0.3, half + walkWidth(e.rank)]) t = Math.max(t, (oW * Math.sign(dn) - sd * w * nn) / dn);
      }
      if (!crossing) return 0;
      const rd = discR(n);
      t = Math.max(t, Math.sqrt(Math.max(0, rd * rd - (half + 0.3) ** 2)) + 0.2);
      return Math.min(t, 40, e.len * 0.45);
    };

    // ----- 인도 체인: 2갈래 노드로 이어지는 같은 종류(등급 묶음·폭·연결로 여부)의 지상 길을 하나의 폴리라인으로 -----
    interface Chain {
      pts: number[];
      len: number;
      half: number;
      rank: number;
      maxRank: number;
      link: boolean;
      parts: Array<{ e: Edge; dir: 1 | -1; s0: number }>;
      nStart: Node;
      nEnd: Node;
      /** 양끝에서 인도가 시작되는 거리 */
      ta: number;
      tb: number;
    }
    const chains: Chain[] = [];
    /** 체인마다 중앙분리대 쪽(반대편 차도가 나란히 있는 쪽). 인도·보행로·띠녹지를 두지 않는다 */
    const medianSides = new Map<Chain, Set<number>>();
    {
      const cand = new Map<number, Edge>();
      for (const e of edges) if (isFlat(e) && hasCurb(e.rank)) cand.set(e.id, e);
      const cls = (e: Edge) => `${e.rank <= 3 ? 'big' : e.rank}|${Math.round(e.half * 10)}|${e.link ? 1 : 0}`;
      const used = new Set<number>();
      const nextAt = (e: Edge, n: Node): Edge | null => {
        const es = g.edgesAt(n);
        if (es.length !== 2) return null;
        const o = es[0].id === e.id ? es[1] : es[0];
        const c = cand.get(o.id);
        return c && !used.has(c.id) && cls(c) === cls(e) ? c : null;
      };
      for (const e0 of cand.values()) {
        if (used.has(e0.id)) continue;
        used.add(e0.id);
        const fwd: Array<{ e: Edge; dir: 1 | -1 }> = [{ e: e0, dir: 1 }];
        let n = e0.b;
        let cur = e0;
        for (let guard = 0; guard < 300; guard++) {
          const o = nextAt(cur, n);
          if (!o) break;
          used.add(o.id);
          const dir: 1 | -1 = o.a === n ? 1 : -1;
          fwd.push({ e: o, dir });
          n = dir === 1 ? o.b : o.a;
          cur = o;
          if (n === e0.a) break;
        }
        const nEnd = n;
        const back: Array<{ e: Edge; dir: 1 | -1 }> = [];
        n = e0.a;
        cur = e0;
        for (let guard = 0; guard < 300 && n !== nEnd; guard++) {
          const o = nextAt(cur, n);
          if (!o) break;
          used.add(o.id);
          const dir: 1 | -1 = o.b === n ? 1 : -1;
          back.push({ e: o, dir });
          n = dir === 1 ? o.a : o.b;
          cur = o;
        }
        const nStart = n;
        const parts = [...back.reverse(), ...fwd];
        const pts: number[] = [];
        const partsOut: Chain['parts'] = [];
        let s = 0;
        for (const p of parts) {
          const ep = p.e.pts;
          const m = ep.length / 2;
          for (let i = 0; i < m; i++) {
            const k = p.dir === 1 ? i : m - 1 - i;
            if (i === 0 && pts.length) continue;
            pts.push(ep[k * 2], ep[k * 2 + 1]);
          }
          partsOut.push({ e: p.e, dir: p.dir, s0: s });
          s += p.e.len;
        }
        const ch: Chain = { pts, len: polylineLen(pts), half: e0.half, rank: Math.min(...parts.map((p) => p.e.rank)), maxRank: Math.max(...parts.map((p) => p.e.rank)), link: e0.link, parts: partsOut, nStart, nEnd, ta: 0, tb: 0 };
        ch.ta = trimAt(nStart, parts[0].e);
        ch.tb = trimAt(nEnd, parts[parts.length - 1].e);
        chains.push(ch);
      }
    }

    /**
     * 교차로 모서리 보도: 이웃한 두 길 A·B 사이 쐐기에서, 차도 띠(반폭+0.3)와 원판 바깥부터 인도 바깥(반폭+폭)까지를
     * 노드에서 쏜 광선으로 표본해 다각형으로 채운다. 안쪽 경계엔 연석을 세운다
     */
    const cornerPieces = (nodeList: Node[], walkB: GeoBuilder, curbBld: GeoBuilder): void => {
      const norm2pi = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      for (const n of nodeList) {
        const es = g.edgesAt(n);
        if (es.length < 3 || es.some((e) => !isFlat(e)) || !es.some((e) => hasCurb(e.rank))) continue;
        const [cx, cz] = g.pos(n);
        const rd = discR(n);
        const arms = es
          .map((e) => {
            const [hx, hz] = awayDir(e, n);
            return { e, hx, hz, ang: Math.atan2(hz, hx), ta: trimAt(n, e), half: e.half, W: hasCurb(e.rank) ? walkWidth(e.rank) : 0.9 };
          })
          .sort((a, b) => a.ang - b.ang);
        for (let k = 0; k < arms.length; k++) {
          const A = arms[k];
          const B = arms[(k + 1) % arms.length];
          const wedge = k === arms.length - 1 ? norm2pi(B.ang - A.ang) || Math.PI * 2 : B.ang - A.ang;
          if (wedge < 0.12 || wedge > Math.PI * 1.92) continue;
          const nAx = -A.hz;
          const nAz = A.hx;
          const nBx = B.hz;
          const nBz = -B.hx;
          const pA = [cx + A.hx * A.ta + nAx * (A.half + 0.3), cz + A.hz * A.ta + nAz * (A.half + 0.3)];
          const pB = [cx + A.hx * A.ta + nAx * (A.half + A.W), cz + A.hz * A.ta + nAz * (A.half + A.W)];
          const pE = [cx + B.hx * B.ta + nBx * (B.half + 0.3), cz + B.hz * B.ta + nBz * (B.half + 0.3)];
          const pD = [cx + B.hx * B.ta + nBx * (B.half + B.W), cz + B.hz * B.ta + nBz * (B.half + B.W)];
          const rel = (p: number[]) => norm2pi(Math.atan2(p[1] - cz, p[0] - cx) - A.ang);
          const fA = rel(pA);
          const fB = rel(pB);
          const fD = rel(pD);
          const fE = rel(pE);
          // 예각 교차로에선 두 인도의 바깥 모서리(pB, pD)가 각도상 엇갈릴 수 있다. 그땐 바깥 경계를 표본하지 않고 바로 잇는다
          if (!(fA < fE && fA <= fB && fD <= fE && fE < wedge + 0.02)) continue;
          const band = (phi: number, hA: number, hB: number): number => {
            const ux = Math.cos(A.ang + phi);
            const uz = Math.sin(A.ang + phi);
            let r = 0;
            if (ux * A.hx + uz * A.hz > 0) r = Math.max(r, hA / Math.max(0.02, Math.abs(ux * nAx + uz * nAz)));
            if (ux * B.hx + uz * B.hz > 0) r = Math.max(r, hB / Math.max(0.02, Math.abs(ux * nBx + uz * nBz)));
            return r;
          };
          const rIn = (phi: number) => Math.min(60, Math.max(rd, band(phi, A.half + 0.3, B.half + 0.3)));
          const rOut = (phi: number, ri: number) => Math.min(ri + 2 * Math.max(A.W, B.W) + 2, Math.max(ri + 0.8, band(phi, A.half + A.W, B.half + B.W)));
          const at = (phi: number, r: number) => [cx + Math.cos(A.ang + phi) * r, cz + Math.sin(A.ang + phi) * r];
          const ring: number[] = [...pA, ...pB];
          const kOut = fD > fB ? Math.max(2, Math.ceil((fD - fB) / 0.14)) : 0;
          for (let i = 1; i < kOut; i++) {
            const phi = fB + ((fD - fB) * i) / kOut;
            ring.push(...at(phi, rOut(phi, rIn(phi))));
          }
          ring.push(...pD, ...pE);
          const inner: number[][] = [pE];
          const kIn = Math.max(2, Math.ceil((fE - fA) / 0.14));
          for (let i = kIn - 1; i >= 1; i--) {
            const phi = fA + ((fE - fA) * i) / kIn;
            const q = at(phi, rIn(phi));
            ring.push(...q);
            inner.push(q);
          }
          inner.push(pA);
          // 윗면은 (x,z) 기준 시계 방향이어야 위를 본다 (ribbon 과 같은 방향)
          let area = 0;
          const m = ring.length / 2;
          for (let i = 0; i < m; i++) {
            const j = (i + 1) % m;
            area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
          }
          let oriented = ring;
          if (area > 0) {
            oriented = [];
            for (let i = m - 1; i >= 0; i--) oriented.push(ring[i * 2], ring[i * 2 + 1]);
          }
          flatPolygon(walkB, oriented, CURB_H, 3, terrainAt);
          // 연석: 안쪽 경계(차도 쪽)에 수직면
          for (let i = 0; i < inner.length - 1; i++) {
            const [x0, z0] = inner[i];
            const [x1, z1] = inner[i + 1];
            const l = Math.hypot(x1 - x0, z1 - z0) || 1;
            const nx = (z1 - z0) / l;
            const nz = -(x1 - x0) / l;
            const g0 = terrainAt(x0, z0);
            const g1 = terrainAt(x1, z1);
            const a = curbBld.vertex(x0, g0 + 0.015, z0, nx, 0, nz, 0, 0);
            const c = curbBld.vertex(x1, g1 + 0.015, z1, nx, 0, nz, l / 1.5, 0);
            const d = curbBld.vertex(x1, g1 + CURB_H, z1, nx, 0, nz, l / 1.5, 1);
            const e = curbBld.vertex(x0, g0 + CURB_H, z0, nx, 0, nz, 0, 1);
            curbBld.quad(a, c, d, e);
          }
        }
      }
    };

    // ----- 도로, 인도, 고가·다리, 지하차도 -----
    {
      const rb = new GeoBuilder();
      const sb = new GeoBuilder();
      const curbB = new GeoBuilder();
      const deckB = new GeoBuilder();
      const tunnelB = new GeoBuilder();
      const maskB = new GeoBuilder();
      const piers: Placement[] = [];
      const rails: Placement[] = [];
      for (const e of edges) {
        const path = pathOf(e);
        ribbon(rb, path.pts, e.half + (e.yt < 0 ? 0.7 : 0.3), 0.02, 8, path.ys, isFlat(e) ? terrainAt : undefined);
        if (isFlat(e)) {
          // 연석 없는 골목은 좁은 띠만 (연석 있는 길의 인도는 아래에서 체인 단위로)
          if (!hasCurb(e.rank)) ribbon(sb, path.pts, e.half + walkWidth(e.rank), 0.012, 2, path.ys, terrainAt);
        } else if (e.yt > 0 || Math.max(e.ya, e.yb) > 0) {
          // 고가·다리·올라가는 램프
          deckBody(deckB, path.pts, path.ys, e.half + 0.6);
          for (let s = 1.5; s < e.len; s += 3) {
            const p = g.pointAt(e, 1, s);
            const [rx, rz] = rightOf(p.hx, p.hz);
            for (const side of [-1, 1]) rails.push({ x: p.x + rx * side * (e.half + 0.9), y: p.y + 0.8, z: p.z + rz * side * (e.half + 0.9), yaw: Math.atan2(p.hx, p.hz), w: 1, h: 1 });
          }
          // 교각: 22m 마다, 상판이 2.5m 이상 떠 있고 아래가 건물·일방통행 차로가 아닐 때
          for (let s = 11; s < e.len - 6; s += 22) {
            const p = g.pointAt(e, 1, s);
            if (p.y < 2.5 || inBuilding(p.x, p.z)) continue;
            const below = g.nearestEdge(p.x, p.z, 20);
            if (below && isFlat(below.e) && below.d < below.e.half && below.e.lb === 0) continue;
            const h = p.y - 1.2;
            piers.push({ x: p.x, y: h / 2, z: p.z, yaw: Math.atan2(p.hx, p.hz), w: e.half > 7 ? 2.4 : 1.6, h, d: 1.6 });
            obstacles.push({ x: p.x, z: p.z, r: e.half > 7 ? 1.3 : 0.9 });
          }
        } else trench(tunnelB, maskB, path.pts, path.ys, e.half);
      }
      // 인도: 체인마다 연석(0.12m) 위 보도블록, 교차로에서는 물러난다
      const medianB = new GeoBuilder();
      const medianGrassB = new GeoBuilder();
      const medianHedgeB = new GeoBuilder();
      for (const ch of chains) {
        const pts = densify(slicePolyline(ch.pts, ch.ta, ch.len - ch.tb), 5);
        if (pts.length < 4) continue;
        // 상·하행이 따로 그려진 대로: 같은 방향으로 나란한 반대편 차도가 16m 안에 있으면 그 쪽은 '중앙분리대 쪽'이다.
        // 인도·보행로·띠녹지를 빼고, 틈을 연석 위 잔디·화단의 중앙분리대로 채운다 (한 쪽 체인에서만)
        const W = walkWidth(ch.rank);
        const cum = cumOf(pts);
        const sides: number[] = [];
        const medSides = new Set<number>();
        for (const side of [-1, 1]) {
          let twin: { e: Edge; gap: number } | null = null;
          for (const t of [0.2, 0.5, 0.8]) {
            const [cx, cz] = ptAt(pts, cum, cum[cum.length - 1] * t);
            const q = g.nearestEdge(cx, cz, 8);
            if (!q) continue;
            const p = g.pointAt(q.e, 1, q.s);
            const [rx, rz] = rightOf(p.hx, p.hz);
            for (const probe of [ch.half + 2.5, ch.half + 7, ch.half + 13]) {
              const near = g.nearestEdge(cx + rx * side * probe, cz + rz * side * probe, 9);
              if (!near || ch.parts.some((pp) => pp.e.id === near.e.id) || !isFlat(near.e) || near.e.rank > 4) continue;
              const np = g.pointAt(near.e, 1, near.s);
              if (Math.abs(np.hx * p.hx + np.hz * p.hz) < 0.8) continue; // 나란하지 않은 길(교차하는 길)은 아니다
              const D = distToPolyline(near.e.pts, cx, cz);
              const gap = D - ch.half - near.e.half - 0.6;
              if (gap < -1 || gap > 16) continue;
              twin = { e: near.e, gap };
              break;
            }
            if (twin) break;
          }
          if (!twin) {
            sides.push(side);
            continue;
          }
          medSides.add(side);
          const gap = twin.gap;
          if (gap >= 0.9 && ch.rank <= 4 && ch.parts[0].e.id < twin.e.id) {
            const mw = Math.min(gap - 0.4, 14);
            const centreOff = offsetPolyline(slicePolyline(ch.pts, ch.ta + 6, ch.len - ch.tb - 6), side * (ch.half + 0.3 + gap / 2));
            if (centreOff.pts.length >= 4) {
              const cpts = densify(centreOff.pts, 6);
              extrudeStrip(medianB, cpts, mw / 2, 0, 0.18, false, terrainAt);
              if (mw >= 1.4) {
                extrudeStrip(medianGrassB, cpts, mw / 2 - 0.25, 0.18, 0.21, true, terrainAt);
                extrudeStrip(medianHedgeB, cpts, Math.min(0.6, mw / 2 - 0.4), 0.2, 0.8, true, terrainAt);
              }
              count('median');
            }
          } else count('medianSkipped');
        }
        if (medSides.size) medianSides.set(ch, medSides);
        if (sides.length) sidewalk(sb, curbB, pts, ch.half + 0.3, ch.half + W, terrainAt, CURB_H, sides);
      }
      if (!medianB.empty) addMesh(medianB.build(), curbMat);
      if (!medianGrassB.empty) addMesh(medianGrassB.build(), grassMat);
      if (!medianHedgeB.empty) addMesh(medianHedgeB.build(), hedgeMat, true);
      // 교차로 모서리: 이 타일이 가진 노드만. 이웃 타일이 아직 없어 길이 빠져 있을 수 있는 경계 노드는 미룬다
      {
        const own: Node[] = [];
        const later: Node[] = [];
        for (const [n, x, z] of tile.nodes) {
          const [ti, tj] = tileAtPos(x, z);
          if (ti !== tile.i || tj !== tile.j || g.edgesAt(n).length < 3) continue;
          (neighborsLoaded(x, z, key) ? own : later).push(n);
        }
        cornerPieces(own, sb, curbB);
        if (later.length) pendingCorners.set(key, later);
      }
      if (!sb.empty) addMesh(sb.build(), walkMat);
      if (!curbB.empty) addMesh(curbB.build(), curbMat);
      if (!rb.empty) addMesh(rb.build(), roadMat);
      if (!deckB.empty) addMesh(deckB.build(), deckMat, true);
      if (!tunnelB.empty) addMesh(tunnelB.build(), tunnelMat);
      if (!maskB.empty) {
        const m = addMesh(maskB.build(), maskMat);
        m.renderOrder = -2;
        m.receiveShadow = false;
      }
      addInstanced(unitBox, deckMat, piers, undefined, true);
      // 교차로 안쪽: 도로 띠가 cut 만큼 비워 두는 자리를 원판으로 덮는다 (노드 높이에서)
      const discs: Placement[] = [];
      const maskDiscs: Placement[] = [];
      const fanB = new GeoBuilder();
      for (const [n] of tile.nodes) {
        const es = g.edgesAt(n);
        if (es.length < 2) continue;
        let r = 0;
        for (const e of es) r = Math.max(r, e.half);
        const [x, z] = g.pos(n);
        const y = g.posY(n);
        const lvY = y - terrainAt(x, z);
        const cut = Math.max(...es.map((e) => g.cut(e, n)));
        const size = r + cut * 0.5 + 0.6;
        // 지상 교차로는 지형을 따르는 부채꼴로 도로 띠에 합친다, 고가·지하는 평평한 원판
        if (es.every((e) => isFlat(e))) discFan(fanB, x, z, size, 0.021, terrainAt);
        else discs.push({ x, y: y + 0.021, z, yaw: 0, w: size, h: 1, d: size });
        if (lvY < -0.25 && lvY > -4.5) maskDiscs.push({ x, y: y - lvY, z, yaw: 0, w: size + 0.3, h: 1, d: size + 0.3 });
      }
      addInstanced(discGeo, roadMat, discs);
      if (!fanB.empty) addMesh(fanB.build(), roadMat);
      const md = addInstanced(discGeo, maskMat, maskDiscs);
      if (md) md.renderOrder = -2;
      addInstanced(railGeo, bridgeRailMat, rails);
    }
    yield 'roads';

    // ----- 보행 네트워크: 체인 양쪽 인도 폴리라인(건물 쪽), 교차로 횡단보도, 모서리 연결 -----
    {
      const ends: Array<{ x: number; z: number; path: number }> = [];
      const addPath = (pts: number[], nrm: number[], y: number, crowd: number, cross?: WalkPath['cross']): number => {
        const cum = cumOf(pts);
        walks.push({ pts, nrm, cum, len: cum[cum.length - 1], y, crowd, cross });
        const idx = walks.length - 1;
        ends.push({ x: pts[0], z: pts[1], path: idx }, { x: pts[pts.length - 2], z: pts[pts.length - 1], path: idx });
        return idx;
      };
      for (const ch of chains) {
        if (ch.rank < 2 || ch.maxRank > 4 || ch.link) continue;
        const base = slicePolyline(ch.pts, ch.ta, ch.len - ch.tb);
        if (base.length < 4) continue;
        for (const side of [-1, 1]) {
          if (medianSides.get(ch)?.has(side)) continue;
          // 가로수·가로등은 연석 쪽, 사람은 건물 쪽으로 걷는다
          const off = offsetPolyline(base, side * (ch.half + 3.2));
          const cum = cumOf(off.pts);
          const len = cum[cum.length - 1];
          // 상·하행이 따로 그려진 대로는 이 자리가 옆 차로 위일 수 있다. 세 지점이 다른 길의 노면 안이면 뺀다
          let onRoad = false;
          for (const t of [0.1, 0.5, 0.9]) {
            const [px, pz] = ptAt(off.pts, cum, len * t);
            const near = g.nearestEdge(px, pz, 16);
            if (near && !ch.parts.some((p) => p.e.id === near.e.id) && near.d < near.e.half + 0.6) {
              onRoad = true;
              break;
            }
          }
          if (!onRoad) addPath(off.pts, off.nrm, CURB_H, ch.rank <= 3 ? 2 : 1.2);
        }
      }
      // 노드에서 예상한 인도 끝 자리와 가장 가까운 실제 끝점 (2.5m 안)
      const endNear = (x: number, z: number): { x: number; z: number } | null => {
        let best: { x: number; z: number } | null = null;
        let bd = 2.5;
        for (const p of ends) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return best;
      };
      const walkEdge = (e: Edge) => isFlat(e) && hasCurb(e.rank) && e.rank >= 2 && e.rank <= 4 && !e.link;
      for (const [n, x, z] of tile.nodes) {
        const [ti, tj] = tileAtPos(x, z);
        if (ti !== tile.i || tj !== tile.j) continue;
        const es = g.edgesAt(n);
        if (es.length < 3 || es.some((e) => !isFlat(e))) continue;
        const arms = es
          .map((e) => {
            const [hx, hz] = awayDir(e, n);
            return { e, hx, hz, ang: Math.atan2(hz, hx), ta: trimAt(n, e) };
          })
          .sort((a, b) => a.ang - b.ang);
        // 팔마다 양쪽 인도 끝 (side = 진행 방향 기준 오른쪽 +1)
        const endOf = (a: (typeof arms)[number], side: 1 | -1) => {
          const [rx, rz] = rightOf(a.hx, a.hz);
          return endNear(x + a.hx * a.ta + rx * side * (a.e.half + 3.2), z + a.hz * a.ta + rz * side * (a.e.half + 3.2));
        };
        for (const a of arms) {
          if (!walkEdge(a.e)) continue;
          const c = g.cut(a.e, n) - 0.6;
          if (c < 1.5) continue;
          const L = endOf(a, -1);
          const R = endOf(a, 1);
          if (!L || !R) continue;
          const [rx, rz] = rightOf(a.hx, a.hz);
          const h = a.e.half + 1.6;
          const pts = [L.x, L.z, x + a.hx * c - rx * h, z + a.hz * c - rz * h, x + a.hx * c + rx * h, z + a.hz * c + rz * h, R.x, R.z];
          const cum = cumOf(pts);
          addPath(pts, [0, 0, 0, 0, 0, 0, 0, 0], CURB_H, 0, { s0: cum[1], s1: cum[2], node: n, edge: a.e.id });
        }
        // 모서리 연결: 이웃한 두 팔의 쐐기 쪽 인도 끝끼리. 각도 증가 방향으로 A 의 왼쪽(-오른쪽)이 쐐기 쪽인지는 좌표계에 따라 다르니 둘 다 재서 가까운 쌍을 쓴다
        for (let k = 0; k < arms.length; k++) {
          const A = arms[k];
          const B = arms[(k + 1) % arms.length];
          if (!walkEdge(A.e) || !walkEdge(B.e)) continue;
          let best: [{ x: number; z: number }, { x: number; z: number }] | null = null;
          let bd = Infinity;
          for (const sa of [-1, 1] as const) {
            for (const sb of [-1, 1] as const) {
              const pa = endOf(A, sa);
              const pb = endOf(B, sb);
              if (!pa || !pb) continue;
              const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
              if (d < bd) {
                bd = d;
                best = [pa, pb];
              }
            }
          }
          if (!best || bd < 0.5 || bd > 30) continue;
          addPath([best[0].x, best[0].z, best[1].x, best[1].z], [0, 0, 0, 0], CURB_H, 0);
        }
      }
    }

    // ----- 차선 표시, 정지선, 횡단보도, 볼라드 -----
    {
      const yellow: Placement[] = [];
      const white: Placement[] = [];
      const bars: Placement[] = [];
      const bollards: Placement[] = [];
      for (const e of edges) {
        if (e.rank > 6 && e.lf + e.lb < 2) continue;
        const twoWay = e.lb > 0;
        if (twoWay) {
          for (let s = 3; s < e.len - 1; s += 6) {
            const p = g.pointAt(e, 1, s);
            yellow.push({ x: p.x, y: p.y + 0.035, z: p.z, yaw: Math.atan2(p.hx, p.hz), w: 0.16, h: 1, d: Math.min(6, e.len - s + 2) });
          }
        }
        const offs: number[] = [];
        if (twoWay) {
          for (let i = 1; i < e.lf; i++) offs.push(i * e.laneW);
          for (let i = 1; i < e.lb; i++) offs.push(-i * e.laneW);
        } else for (let i = 1; i < e.lf; i++) offs.push((i - e.lf / 2) * e.laneW);
        if (offs.length) {
          for (let s = 2; s < e.len - 2; s += 7) {
            const p = g.pointAt(e, 1, s);
            const [rx, rz] = rightOf(p.hx, p.hz);
            for (const o of offs) white.push({ x: p.x + rx * o, y: roadY(e, p.y, p.x + rx * o, p.z + rz * o) + 0.035, z: p.z + rz * o, yaw: Math.atan2(p.hx, p.hz), w: 0.15, h: 1, d: 3 });
          }
        }
      }
      for (const [n] of tile.nodes) {
        if (!isSignal(n)) continue;
        for (const e of g.edgesAt(n)) {
          const dir = g.dirInto(e, n);
          if (!g.canTravel(e, dir)) continue;
          const cut = g.cut(e, n);
          const lanes = g.lanes(e, dir);
          const laneSpan = lanes * e.laneW;
          const p = g.pointAt(e, dir, Math.max(0, e.len - cut - 1.2));
          const [rx, rz] = rightOf(p.hx, p.hz);
          const yaw = Math.atan2(p.hx, p.hz);
          const center = e.lb === 0 ? 0 : laneSpan / 2;
          bars.push({ x: p.x + rx * center, y: roadY(e, p.y, p.x + rx * center, p.z + rz * center) + 0.036, z: p.z + rz * center, yaw, w: laneSpan - 0.5, h: 1, d: 0.4 });
          const q = g.pointAt(e, dir, Math.max(0, e.len - cut + 0.6));
          for (let o = -e.half + 0.9; o < e.half - 0.3; o += 2.1) bars.push({ x: q.x + rx * o, y: roadY(e, q.y, q.x + rx * o, q.z + rz * o) + 0.036, z: q.z + rz * o, yaw, w: 1.2, h: 1, d: 2.4 });
          // 횡단보도 양끝 인도에 볼라드 두 개씩
          if (isFlat(e) && hasCurb(e.rank)) {
            for (const side of [-1, 1]) {
              const lat = side * (e.half + 1.0);
              for (const along of [-1.1, 1.1]) {
                const bx = q.x + rx * lat + p.hx * along;
                const bz = q.z + rz * lat + p.hz * along;
                if (inBuilding(bx, bz)) continue;
                bollards.push({ x: bx, y: CURB_H + terrainAt(bx, bz), z: bz, yaw: 0, w: 1, h: 1 });
                obstacles.push({ x: bx, z: bz, r: 0.1 });
              }
            }
          }
        }
      }
      addInstanced(unitPlane, yellowMat, yellow);
      addInstanced(unitPlane, whiteMat, white);
      addInstanced(unitPlane, barMat, bars);
      addInstanced(bollardGeo, bollardMat, bollards, undefined, true);

      // 신호 교차로 진입 차선마다 바닥 화살표: 그 교차로에서 실제로 갈 수 있는 방향(laneRoles)대로. 교통 AI 도 같은 규칙으로 차선을 고른다
      const arrows = Object.fromEntries(arrowKinds.map((k) => [k, [] as Placement[]])) as Record<ArrowKind, Placement[]>;
      for (const [n] of tile.nodes) {
        if (!isSignal(n)) continue;
        for (const e of g.edgesAt(n)) {
          const dir = g.dirInto(e, n);
          if (!g.canTravel(e, dir) || e.rank > 4) continue;
          const lanes = g.lanes(e, dir);
          const cut = g.cut(e, n);
          const roles = laneRoles(g, e, dir).roles;
          const [rx, rz] = rightOf(g.pointAt(e, dir, Math.max(0, e.len - cut - 9)).hx, g.pointAt(e, dir, Math.max(0, e.len - cut - 9)).hz);
          // 교차로 앞 9m 와 24m 두 곳 (간선이 길면)
          for (const back of e.len - cut > 40 ? [9, 24] : [9]) {
            const p = g.pointAt(e, dir, Math.max(0, e.len - cut - back));
            const yaw = Math.atan2(p.hx, p.hz);
            for (let lane = 0; lane < lanes; lane++) {
              const lat = g.laneOffset(e, dir, lane);
              arrows[roles[lane] ?? 'straight'].push({ x: p.x + rx * lat, y: roadY(e, p.y, p.x + rx * lat, p.z + rz * lat) + 0.037, z: p.z + rz * lat, yaw, w: 1.0, h: 1, d: 2.5 });
            }
          }
        }
      }
      for (const k of arrowKinds) addInstanced(unitPlane, arrowMats[k], arrows[k]);

      // 버스전용차로: 중앙(1차로) 또는 가로변(바깥 차로)을 파랗게 칠하고 60m 마다 '버스전용'
      {
        const bb = new GeoBuilder();
        const texts: Placement[] = [];
        for (const e of edges) {
          if (!e.busLane || !isFlat(e)) continue;
          for (const dir of (e.lb > 0 ? [1, -1] : [1]) as Array<1 | -1>) {
            const lanes = g.lanes(e, dir);
            if (lanes < 2) continue;
            const lane = e.busLane === 'median' ? 0 : lanes - 1;
            const lat = g.laneOffset(e, dir, lane);
            const s0 = g.cut(e, dir === 1 ? e.a : e.b) + 1;
            const s1 = e.len - g.cut(e, dir === 1 ? e.b : e.a) - 1;
            if (s1 - s0 < 8) continue;
            const pts: number[] = [];
            const ys: number[] = [];
            for (let s = s0; s <= s1 + 0.01; s += Math.min(8, s1 - s0)) {
              const p = g.pointAt(e, dir, Math.min(s, s1));
              const [rx, rz] = rightOf(p.hx, p.hz);
              pts.push(p.x + rx * lat, p.z + rz * lat);
              ys.push(p.y);
            }
            ribbon(bb, pts, e.laneW / 2 - 0.22, 0.028, 8, ys, terrainAt);
            for (let s = s0 + 14; s < s1 - 6; s += 60) {
              const p = g.pointAt(e, dir, s);
              const [rx, rz] = rightOf(p.hx, p.hz);
              texts.push({ x: p.x + rx * lat, y: roadY(e, p.y, p.x + rx * lat, p.z + rz * lat) + 0.033, z: p.z + rz * lat, yaw: Math.atan2(p.hx, p.hz), w: 1.5, h: 1, d: 4.5 });
            }
          }
        }
        if (!bb.empty) addMesh(bb.build(), busLaneMat).receiveShadow = false;
        addInstanced(unitPlane, busTextMat, texts);
      }
      // 맨홀: 큰길 60m 마다 하나, 차선 하나에 무작위
      const manholes: Placement[] = [];
      for (const e of edges) {
        if (e.rank > 4 || !isFlat(e)) continue;
        for (let s = 25 + rand() * 20; s < e.len - 10; s += 60) {
          const p = g.pointAt(e, 1, s);
          const [rx, rz] = rightOf(p.hx, p.hz);
          const lat = (rand() - 0.5) * (e.width - 1.5);
          manholes.push({ x: p.x + rx * lat, y: roadY(e, p.y, p.x + rx * lat, p.z + rz * lat) + 0.034, z: p.z + rz * lat, yaw: 0, w: 1, h: 1 });
        }
      }
      addInstanced(manholeGeo, manholeMat, manholes);
    }
    yield 'marks';

    // ----- 건물 -----
    const wallBuilders = new Map<THREE.Material, GeoBuilder>();
    const builderFor = (m: THREE.Material) => {
      let b = wallBuilders.get(m);
      if (!b) {
        b = new GeoBuilder(true);
        wallBuilders.set(m, b);
      }
      return b;
    };
    /** 건물 종류에 맞는 틴트 하나 (밝기도 ±10% 흔든다) */
    const tintFor = (kind: string): [number, number, number] => {
      const list = TINTS[kind] ?? TINTS.block;
      const t = list[Math.floor(rand() * list.length)];
      const k = 0.88 + rand() * 0.2;
      return [t[0] * k, t[1] * k, t[2] * k];
    };
    const parapetB = new GeoBuilder();
    const awnings: Array<Placement & { c: number }> = [];
    const roofB = new GeoBuilder();
    const fieldB = new GeoBuilder();
    const standB = new GeoBuilder();
    const crownB = new GeoBuilder();
    const domes: Placement[] = [];
    const spires: Placement[] = [];
    const beacons: Placement[] = [];
    const signLists: Placement[][] = Array.from({ length: SIGN_VARIANTS }, () => []);
    const billLists: Placement[][] = Array.from({ length: BILL_VARIANTS }, () => []);
    const billFrames: Placement[] = [];
    const dongLists: Placement[][] = Array.from({ length: 12 }, () => []);
    const hvacs: Placement[] = [];
    const tanks: Placement[] = [];

    function wallQuad(b: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, nx: number, nz: number, u0: number, u1: number, v0: number, v1: number): void {
      const cross = (x1 - x0) * nz - (z1 - z0) * nx;
      const ua = cross > 0 ? u0 : u1;
      const ub = cross > 0 ? u1 : u0;
      const a = b.vertex(x0, y0, z0, nx, 0, nz, ua, v0);
      const c = b.vertex(x1, y0, z1, nx, 0, nz, ub, v0);
      const d = b.vertex(x1, y1, z1, nx, 0, nz, ub, v1);
      const e = b.vertex(x0, y1, z0, nx, 0, nz, ua, v1);
      if (cross > 0) b.quad(a, c, d, e);
      else b.quad(c, a, e, d);
    }

    function buildBuilding(bd: BuildingData): void {
      const ring = bd.ring;
      const n = ring.length / 2;
      const [ccx, ccz] = ringCentroid(ring);
      // 지형: 바닥은 고리 꼭짓점 중 가장 높은 지형에 두고, 낮은 쪽은 콘크리트 기초로 메운다
      let gmin = Infinity;
      let gmax = -Infinity;
      for (let i = 0; i < n; i++) {
        const gh = terrainAt(ring[i * 2], ring[i * 2 + 1]);
        if (gh < gmin) gmin = gh;
        if (gh > gmax) gmax = gh;
      }
      const g0 = gmax;
      const isApt = bd.kind === 'apt';
      const commercial = bd.kind === 'low' || bd.kind === 'block';
      const set = isApt ? aptWalls : bd.kind === 'tower' ? towerSet : bd.kind === 'block' ? blockSet : lowSet;
      const wall = set[Math.floor(rand() * set.length)];
      const store = storeWalls[Math.floor(rand() * storeWalls.length)];
      const ou = Math.floor(rand() * 8) / 8;
      const ov = isApt ? 0 : Math.floor(rand() * 4) / 4;
      const uScale = isApt ? 16 : 32;
      const vScale = isApt ? 24 : 48;
      let cum = 0;
      let longest = -1;
      let longestLen = 0;
      const nearBig = commercial && (g.nearestEdge(ccx, ccz, 60)?.e.rank ?? 9) <= 3;
      const scaled = (s: number) => ring.map((v, i) => (i % 2 === 0 ? ccx + (v - ccx) * s : ccz + (v - ccz) * s));
      /** 고리 두 개 사이 벽 (r0 가 y0, r1 이 y1). 바깥을 향한 법선 */
      const wallBetween = (b: GeoBuilder, r0: number[], y0: number, r1: number[], y1: number, uScale = 32, vScale = 48) => {
        let c2 = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const len = Math.hypot(r0[j * 2] - r0[i * 2], r0[j * 2 + 1] - r0[i * 2 + 1]);
          if (len < 0.2) continue;
          let nx = (r0[j * 2 + 1] - r0[i * 2 + 1]) / len;
          let nz = -(r0[j * 2] - r0[i * 2]) / len;
          if (nx * ((r0[i * 2] + r0[j * 2]) / 2 - ccx) + nz * ((r0[i * 2 + 1] + r0[j * 2 + 1]) / 2 - ccz) < 0) {
            nx = -nx;
            nz = -nz;
          }
          const cross = (r0[j * 2] - r0[i * 2]) * nz - (r0[j * 2 + 1] - r0[i * 2 + 1]) * nx;
          const ua = c2 / uScale;
          const ub = (c2 + len) / uScale;
          const a = b.vertex(r0[i * 2], y0, r0[i * 2 + 1], nx, 0, nz, cross > 0 ? ua : ub, y0 / vScale);
          const c = b.vertex(r0[j * 2], y0, r0[j * 2 + 1], nx, 0, nz, cross > 0 ? ub : ua, y0 / vScale);
          const d = b.vertex(r1[j * 2], y1, r1[j * 2 + 1], nx, 0, nz, cross > 0 ? ub : ua, y1 / vScale);
          const e = b.vertex(r1[i * 2], y1, r1[i * 2 + 1], nx, 0, nz, cross > 0 ? ua : ub, y1 / vScale);
          if (cross > 0) b.quad(a, c, d, e);
          else b.quad(c, a, e, d);
          c2 += len;
        }
      };
      // ----- 랜드마크 전용 모델 (이름으로 알아본다) -----
      // 경기장(잠실주경기장·야구장): 바깥 스탠드 벽 + 안쪽으로 기운 지붕 링 + 푸른 필드
      for (const b of wallBuilders.values()) b.tint = [1, 1, 1];
      if (gmax - gmin > 0.05) wallBetween(parapetB, ring, gmin - 0.4, ring, g0 + 0.02, 8, 8);
      if (/주경기장|야구장/.test(bd.name) && n >= 60) {
        const H = /야구장/.test(bd.name) ? 22 : 30;
        const inner = scaled(0.62);
        const mid = scaled(0.82);
        wallBetween(builderFor(office), ring, g0, ring, g0 + H * 0.85);
        wallBetween(builderFor(office), ring, g0 + H * 0.85, mid, g0 + H);
        ringBand(roofB, mid, inner, g0 + H);
        // 스탠드 안쪽 경사면 (지붕 안쪽 가장자리에서 필드로). 안쪽을 보니 양면 재질
        wallBetween(standB, inner, g0 + H, scaled(0.5), g0 + 2.5);
        flatPolygon(fieldB, scaled(0.5), g0 + 0.3, 2.5);
        beacons.push({ x: ccx, y: g0 + H + 0.6, z: ccz, yaw: 0, w: 1, h: 1 });
        return;
      }
      // 실내체육관: 낮은 벽 위에 돔
      if (/실내체육관/.test(bd.name) && n >= 12) {
        const [bx0, bx1, bz0, bz1] = ringBounds(ring);
        wallBetween(builderFor(office), ring, g0, ring, g0 + 10);
        flatPolygon(roofB, ring, g0 + 10, 6);
        domes.push({ x: ccx, y: g0 + 10, z: ccz, yaw: 0, w: (bx1 - bx0) * 0.46, h: 14, d: (bz1 - bz0) * 0.46 });
        return;
      }
      // 롯데월드 매직아일랜드 성: 작은 성채 건물이면 꼭짓점마다 뾰족탑
      if (bd.name === '롯데월드' && n <= 20 && ringAreaAbs(ring) < 2500) {
        const wb0 = builderFor(brick1);
        wallBetween(wb0, ring, g0, ring, g0 + bd.h + 4, 16, 16);
        flatPolygon(roofB, ring, g0 + bd.h + 4, 6);
        for (let i = 0; i < n; i += 2) spires.push({ x: ring[i * 2], y: g0 + bd.h + 4, z: ring[i * 2 + 1], yaw: 0, w: 2.6, h: 9, d: 2.6 });
        spires.push({ x: ccx, y: g0 + bd.h + 4, z: ccz, yaw: 0, w: 5, h: 22, d: 5 });
        return;
      }
      // 랜드마크급 초고층(180m 이상): 위로 갈수록 좁아지는 유리 타워 + 첨탑. 롯데월드타워처럼 400m 넘으면 더 가늘고 매끈하게, 꼭대기엔 크라운
      if (bd.h > 180 && n <= 30 && (bd.kind === 'tower' || bd.h > 300)) {
        const K = bd.h > 350 ? 16 : 5;
        const topScale = bd.h > 350 ? 0.3 : 0.68;
        const scaleAt = (t: number) => 1 - (1 - topScale) * Math.pow(t, bd.h > 350 ? 1.08 : 1.3);
        const tb = builderFor(glass1);
        for (let k = 0; k < K; k++) {
          const y0 = g0 + (bd.h * k) / K;
          const y1 = g0 + (bd.h * (k + 1)) / K;
          const r0 = scaled(scaleAt(k / K));
          const r1 = scaled(scaleAt((k + 1) / K));
          let c2 = 0;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const len = Math.hypot(r0[j * 2] - r0[i * 2], r0[j * 2 + 1] - r0[i * 2 + 1]);
            if (len < 0.2) continue;
            let nx = (r0[j * 2 + 1] - r0[i * 2 + 1]) / len;
            let nz = -(r0[j * 2] - r0[i * 2]) / len;
            if (nx * ((r0[i * 2] + r0[j * 2]) / 2 - ccx) + nz * ((r0[i * 2 + 1] + r0[j * 2 + 1]) / 2 - ccz) < 0) {
              nx = -nx;
              nz = -nz;
            }
            const cross = (r0[j * 2] - r0[i * 2]) * nz - (r0[j * 2 + 1] - r0[i * 2 + 1]) * nx;
            const ua = c2 / 32;
            const ub = (c2 + len) / 32;
            const a = tb.vertex(r0[i * 2], y0, r0[i * 2 + 1], nx, 0, nz, cross > 0 ? ua : ub, y0 / 48);
            const c = tb.vertex(r0[j * 2], y0, r0[j * 2 + 1], nx, 0, nz, cross > 0 ? ub : ua, y0 / 48);
            const d = tb.vertex(r1[j * 2], y1, r1[j * 2 + 1], nx, 0, nz, cross > 0 ? ub : ua, y1 / 48);
            const e = tb.vertex(r1[i * 2], y1, r1[i * 2 + 1], nx, 0, nz, cross > 0 ? ua : ub, y1 / 48);
            if (cross > 0) tb.quad(a, c, d, e);
            else tb.quad(c, a, e, d);
            c2 += len;
          }
        }
        flatPolygon(roofB, scaled(topScale), g0 + bd.h, 6);
        const spire = bd.h * (bd.h > 350 ? 0.1 : 0.07);
        if (bd.h > 350) {
          // 크라운: 꼭대기 위에 조금 더 좁아지는 밝은 띠 (랜턴) 와 가는 첨탑
          wallBetween(crownB, scaled(topScale), g0 + bd.h, scaled(topScale * 0.72), g0 + bd.h + 14, 32, 48);
          flatPolygon(crownB, scaled(topScale * 0.72), g0 + bd.h + 14, 6);
          billFrames.push({ x: ccx, y: g0 + bd.h + 14 + spire / 2, z: ccz, yaw: 0, w: 1.6, h: spire, d: 1.6 });
          beacons.push({ x: ccx, y: g0 + bd.h + 14 + spire + 0.6, z: ccz, yaw: 0, w: 1, h: 1 });
        } else {
          billFrames.push({ x: ccx, y: g0 + bd.h + spire / 2, z: ccz, yaw: 0, w: 1.2, h: spire, d: 1.2 });
          beacons.push({ x: ccx, y: g0 + bd.h + spire + 0.6, z: ccz, yaw: 0, w: 1, h: 1 });
        }
        return;
      }
      const wb = builderFor(wall);
      wb.tint = tintFor(bd.kind);
      const sb = builderFor(store);
      const sk = 0.9 + rand() * 0.15;
      sb.tint = [sk, sk, sk];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = ring[i * 2];
        const z0 = ring[i * 2 + 1];
        const x1 = ring[j * 2];
        const z1 = ring[j * 2 + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.2) continue;
        let nx = (z1 - z0) / len;
        let nz = -(x1 - x0) / len;
        if (nx * ((x0 + x1) / 2 - ccx) + nz * ((z0 + z1) / 2 - ccz) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        const streetFace = !!g.nearestEdge(mx + nx * 4, mz + nz * 4, 16);
        const u0 = cum / uScale + ou;
        const u1 = (cum + len) / uScale + ou;
        const hasStore = commercial && streetFace && bd.h > STORE_H + 1.5;
        if (hasStore) {
          wallQuad(sb, x0, z0, x1, z1, g0, g0 + STORE_H, nx, nz, cum / 12, (cum + len) / 12, 0, 1);
          wallQuad(wb, x0, z0, x1, z1, g0 + STORE_H, g0 + bd.h, nx, nz, u0, u1, STORE_H / vScale + ov, bd.h / vScale + ov);
        } else wallQuad(wb, x0, z0, x1, z1, g0, g0 + bd.h, nx, nz, u0, u1, ov, bd.h / vScale + ov);
        cum += len;
        if (len > longestLen) {
          longestLen = len;
          longest = i;
        }
        if (hasStore && len >= 5 && rand() < 0.35) {
          const w = Math.min(len - 1.2, 2.6 + rand() * 3);
          const along = (rand() - 0.5) * (len - w - 0.6);
          const [rx, rz] = rightOf(nx, nz);
          awnings.push({ x: mx + nx * 0.05 + rx * along, y: g0 + STORE_H - 0.55, z: mz + nz * 0.05 + rz * along, yaw: Math.atan2(nx, nz), w, h: 1, d: 1.1 + rand() * 0.5, c: AWNING_COLORS[Math.floor(rand() * AWNING_COLORS.length)] });
        }
        if (commercial && streetFace && len >= 3.5) {
          const floors = Math.min(4, Math.floor((bd.h - 1) / STORE_H));
          for (let f = 1; f < floors; f++) {
            if (rand() > 0.75) continue;
            const w = Math.min(len - 0.8, 2.6 + rand() * 3.4);
            const along = (rand() - 0.5) * (len - w - 0.4);
            const [rx, rz] = rightOf(nx, nz);
            signLists[Math.floor(rand() * SIGN_VARIANTS)].push({ x: mx + nx * 0.12 + rx * along, y: g0 + STORE_H * f + 1.9, z: mz + nz * 0.12 + rz * along, yaw: Math.atan2(nx, nz), w, h: w / 4 });
          }
        }
      }
      flatPolygon(roofB, ring, g0 + bd.h, 6);
      // 옥상 파라펫: 바깥 면 0.7m + 윗면 띠 0.35m. 실루엣이 상자처럼 밋밋하지 않게
      if (bd.h > 5 && n <= 40) {
        wallBetween(parapetB, ring, g0 + bd.h, ring, g0 + bd.h + 0.7, 8, 8);
        const inner = insetRing(ring, 0.35);
        if (inner) ringBand(parapetB, ring, inner, g0 + bd.h + 0.7, 6);
      }
      if (bd.h > 55) beacons.push({ x: ccx, y: g0 + bd.h + 0.6, z: ccz, yaw: 0, w: 1, h: 1 });
      // 옥상 설비: 실외기·물탱크 (평평한 지붕 위, 테두리 안쪽)
      const area = ringAreaAbs(ring);
      if (bd.h > 7 && area > 60 && n <= 12) {
        const [bx0, bx1, bz0, bz1] = ringBounds(ring);
        const count = Math.min(5, Math.floor(area / 120));
        for (let k = 0; k < count; k++) {
          const x = bx0 + 2 + rand() * Math.max(0.1, bx1 - bx0 - 4);
          const z = bz0 + 2 + rand() * Math.max(0.1, bz1 - bz0 - 4);
          if (!pointInRing(ring, x, z)) continue;
          if (isApt || (rand() < 0.3 && bd.h < 30)) tanks.push({ x, y: g0 + bd.h + 0.8, z, yaw: 0, w: 1, h: 1 });
          else hvacs.push({ x, y: g0 + bd.h + 0.45, z, yaw: rand() * Math.PI, w: 1.2 + rand() * 0.8, h: 0.9, d: 0.7 });
        }
      }
      if ((bd.kind === 'block' || bd.kind === 'tower') && nearBig && rand() < 0.3 && longest >= 0) {
        const i = longest;
        const j = (i + 1) % n;
        const x0 = ring[i * 2];
        const z0 = ring[i * 2 + 1];
        const x1 = ring[j * 2];
        const z1 = ring[j * 2 + 1];
        let nx = (z1 - z0) / longestLen;
        let nz = -(x1 - x0) / longestLen;
        if (nx * ((x0 + x1) / 2 - ccx) + nz * ((z0 + z1) / 2 - ccz) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const w = Math.min(longestLen - 1, 8 + rand() * 6);
        const p: Placement = { x: (x0 + x1) / 2 - nx * 1.2, y: g0 + bd.h + 2.2 + w / 5, z: (z0 + z1) / 2 - nz * 1.2, yaw: Math.atan2(nx, nz), w, h: w / 2.5 };
        billLists[Math.floor(rand() * BILL_VARIANTS)].push(p);
        billFrames.push({ x: p.x - nx * 0.4, y: g0 + bd.h + 1.1 + w / 5, z: p.z - nz * 0.4, yaw: p.yaw, w: w * 0.9, h: w / 2.5 + 2.2, d: 0.3 });
      }
      if (isApt && longest >= 0 && bd.h > 12) {
        const i = longest;
        const j = (i + 1) % n;
        const x0 = ring[i * 2];
        const z0 = ring[i * 2 + 1];
        const x1 = ring[j * 2];
        const z1 = ring[j * 2 + 1];
        let nx = (z1 - z0) / longestLen;
        let nz = -(x1 - x0) / longestLen;
        if (nx * ((x0 + x1) / 2 - ccx) + nz * ((z0 + z1) / 2 - ccz) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const s = Math.min(4, bd.h * 0.22);
        dongLists[Math.floor(rand() * 12)].push({ x: (x0 + x1) / 2 + nx * 0.1, y: g0 + bd.h - s * 0.8, z: (z0 + z1) / 2 + nz * 0.1, yaw: Math.atan2(nx, nz), w: s, h: s });
      }
    }
    // 건물은 타일당 수백~수천 동. 40동마다 끊어 다른 프레임에 이어서 만든다
    for (let i = 0; i < tile.buildings.length; i++) {
      buildBuilding(tile.buildings[i]);
      if (i % 40 === 39) yield 'bld';
    }
    yield 'bld-end';
    // 벽 지오메트리는 재질마다 수만 꼭짓점이라 하나씩 다른 프레임에 올린다
    for (const [mat, b] of wallBuilders) {
      if (b.empty) continue;
      addMesh(b.build(), mat, true);
      yield 'walls';
    }
    if (!roofB.empty) addMesh(roofB.build(), roofMat);
    if (!parapetB.empty) addMesh(parapetB.build(), parapetMat, true);
    {
      const am = addInstanced(awningGeo, awningMat, awnings, undefined, true);
      counts.awning = awnings.length;
      if (am) {
        awnings.forEach((a, i) => am.setColorAt(i, tempColor.setHex(a.c)));
        am.instanceColor!.needsUpdate = true;
      }
    }
    if (!fieldB.empty) addMesh(fieldB.build(), fieldMat);
    if (!standB.empty) addMesh(standB.build(), standMat);
    if (!crownB.empty) addMesh(crownB.build(), crownMat, true);
    addInstanced(domeGeo, domeMat, domes, undefined, true);
    addInstanced(coneGeo, spireMat, spires, undefined, true);
    addInstanced(beaconGeo, beaconMat, beacons);
    signLists.forEach((list, v) => addInstanced(plane, signMats[v], list));
    billLists.forEach((list, v) => addInstanced(plane, billMats[v], list));
    addInstanced(unitBox, frameMat, billFrames);
    dongLists.forEach((list, v) => addInstanced(plane, dongMats[v], list));
    addInstanced(unitBox, hvacMat, hvacs);
    addInstanced(tankGeo, tankMat, tanks);
    yield 'instanced';

    // ----- 버스 정류장: OSM 정류장 위치가 있으면 그 자리에, 없으면 큰길 350m 마다 -----
    {
      const shelters: Placement[] = [];
      const glass: Placement[] = [];
      const signs: Placement[] = [];
      const placeShelter = (x: number, z: number, hx: number, hz: number, side: number, yRel: number) => {
        const y = yRel + terrainAt(x, z);
        const [rx, rz] = rightOf(hx, hz);
        const yaw = Math.atan2(hx, hz);
        shelters.push({ x, y: y + 2.6, z, yaw, w: 4.2, h: 0.12, d: 1.6 });
        // 정류장에서 기다리는 사람: 대기소 뒤 3m 짧은 길을 서성인다. 쓰레기통 하나
        const wx0 = x - hx * 1.5 + rx * side * 0.9;
        const wz0 = z - hz * 1.5 + rz * side * 0.9;
        const wpts = [wx0, wz0, wx0 + hx * 3, wz0 + hz * 3];
        walks.push({ pts: wpts, nrm: [rx * side, rz * side, rx * side, rz * side], cum: [0, 3], len: 3, y: yRel, crowd: 2.5 });
        trash.push({ x: x + hx * 2.7, y: y + 0.42, z: z + hz * 2.7, yaw, w: 1, h: 1 });
        glass.push({ x: x + rx * side * 0.7, y: y + 1.35, z: z + rz * side * 0.7, yaw, w: 4.0, h: 2.4, d: 0.06 });
        signs.push({ x: x - hx * 2.4, y: y + 2.2, z: z - hz * 2.4, yaw: yaw + Math.PI / 2, w: 0.9, h: 0.5, d: 0.08 });
        for (const dx of [-1.9, 1.9]) {
          const px = x + hx * dx;
          const pz = z + hz * dx;
          obstacles.push({ x: px, z: pz, r: 0.12 });
          shelters.push({ x: px, y: y + 1.3, z: pz, yaw, w: 0.1, h: 2.6, d: 0.1 });
        }
      };
      /** 정류장 기록: 띠녹지를 끊고, 버스가 설 자리를 교통 AI 에 알린다 */
      const gap = (e: Edge, s: number, side: 1 | -1, x: number, z: number) => {
        const l = hedgeGaps.get(e.id) ?? [];
        l.push(s);
        hedgeGaps.set(e.id, l);
        busStops.push({ key: `${e.id}:${Math.round(s)}:${side}`, edge: e.id, s, side, x, z });
      };
      const trash: Placement[] = [];
      const stops = (tile.pois ?? []).filter((p) => p.kind === 'bus_stop');
      if (stops.length) {
        for (const st of stops) {
          const hit = g.nearestEdge(st.x, st.z, 30);
          if (!hit || hit.e.bridge || hit.e.tunnel) continue;
          // 정류장은 도로 바깥 인도 위에. 길 어느 쪽인지는 POI 위치로
          const p = g.pointAt(hit.e, 1, hit.s);
          const side = hit.side >= 0 ? 1 : -1;
          const [rx, rz] = rightOf(p.hx, p.hz);
          const x = p.x + rx * side * (hit.e.half + 2.2);
          const z = p.z + rz * side * (hit.e.half + 2.2);
          if (inBuilding(x, z)) continue;
          placeShelter(x, z, p.hx * side, p.hz * side, side, walkY(hit.e));
          gap(hit.e, hit.s, side, x, z);
        }
      } else {
        for (const e of edges) {
          if (e.rank < 2 || e.rank > 3 || e.bridge || e.tunnel || e.link || e.len < 120) continue;
          for (let s = 90; s < e.len - 40; s += 350) {
            const p = g.pointAt(e, 1, s);
            const [rx, rz] = rightOf(p.hx, p.hz);
            for (const side of e.lb > 0 ? [1, -1] : [1]) {
              const x = p.x + rx * side * (e.half + 2.2);
              const z = p.z + rz * side * (e.half + 2.2);
              if (inBuilding(x, z)) continue;
              placeShelter(x, z, p.hx, p.hz, side, walkY(e));
              gap(e, s, side as 1 | -1, x, z);
            }
          }
        }
      }
      addInstanced(unitBox, shelterMat, shelters);
      addInstanced(unitBox, shelterGlassMat, glass);
      addInstanced(unitBox, shelterSignMat, signs);
      // 거리 소품: 큰길 인도에 90m 마다 쓰레기통(연석 쪽), 160m 마다 변압기함(건물 쪽)
      const boxes: Placement[] = [];
      for (const ch of chains) {
        if (ch.maxRank > 3 || ch.link) continue;
        for (let s = ch.ta + 30; s < ch.len - ch.tb - 10; s += 90) {
          const [px, pz] = ptAt(ch.pts, cumOf(ch.pts), s);
          const q = g.nearestEdge(px, pz, 8);
          if (!q) continue;
          const p = g.pointAt(q.e, 1, q.s);
          const [rx, rz] = rightOf(p.hx, p.hz);
          const side = rand() < 0.5 ? 1 : -1;
          const tx = p.x + rx * side * (ch.half + 1.9);
          const tz = p.z + rz * side * (ch.half + 1.9);
          if (!inBuilding(tx, tz)) trash.push({ x: tx, y: CURB_H + 0.42 + terrainAt(tx, tz), z: tz, yaw: 0, w: 1, h: 1 });
          if (Math.round(s / 90) % 2 === 0) {
            const bx = p.x + rx * side * (ch.half + 3.9);
            const bz = p.z + rz * side * (ch.half + 3.9);
            if (!inBuilding(bx, bz)) {
              boxes.push({ x: bx, y: CURB_H + 0.65 + terrainAt(bx, bz), z: bz, yaw: Math.atan2(p.hx, p.hz), w: 1.2, h: 1.3, d: 0.8 });
              obstacles.push({ x: bx, z: bz, r: 0.6 });
            }
          }
        }
      }
      addInstanced(trashGeo, trashMat, trash, undefined, true);
      addInstanced(unitBox, utilityBoxMat, boxes, undefined, true);
    }

    // ----- 띠녹지: 큰길 체인의 연석 안쪽을 따라가는 낮은 울타리 띠. 교차로·정류장·건물·다른 길 위는 비운다 -----
    {
      const hb = new GeoBuilder();
      let n = 0;
      for (const ch of chains) {
        if (ch.maxRank > 3 || ch.link) continue;
        const gaps: number[] = [];
        for (const p of ch.parts) for (const gs of hedgeGaps.get(p.e.id) ?? []) gaps.push(p.s0 + (p.dir === 1 ? gs : p.e.len - gs));
        const s0 = ch.ta + 6;
        const s1 = ch.len - ch.tb - 6;
        if (s1 - s0 < 6) continue;
        for (const side of [-1, 1]) {
          if (medianSides.get(ch)?.has(side)) continue;
          const off = offsetPolyline(ch.pts, side * (ch.half + 0.75));
          const cum = cumOf(off.pts);
          // 상·하행이 따로 그려진 대로의 안쪽은 옆 차로 위일 수 있다. 세 지점만 보고 그 쪽 전체를 뺀다
          let onRoad = false;
          for (const t of [0.1, 0.5, 0.9]) {
            const [px, pz] = ptAt(off.pts, cum, s0 + (s1 - s0) * t);
            const near = g.nearestEdge(px, pz, 16);
            if (near && !ch.parts.some((p) => p.e.id === near.e.id) && near.d < near.e.half + 0.6) {
              onRoad = true;
              break;
            }
          }
          if (onRoad) continue;
          // 3m 마다 막힌 곳(건물·정류장)을 보고, 트인 구간마다 띠 하나
          const flush = (a: number, b: number) => {
            if (b - a >= 4) extrudeStrip(hb, densify(slicePolyline(off.pts, a, b), 6), 0.3, CURB_H - 0.02, CURB_H + 0.5, true, terrainAt);
          };
          let run = -1;
          let s = s0;
          for (; s <= s1; s += 3) {
            const [px, pz] = ptAt(off.pts, cum, s);
            const blocked = inBuilding(px, pz) || gaps.some((gs) => Math.abs(gs - s) < 5);
            if (!blocked && run < 0) run = s;
            if (blocked && run >= 0) {
              flush(run, s - 3);
              run = -1;
            }
          }
          if (run >= 0) flush(run, s1);
        }
        if (++n % 40 === 0) yield 'hedges';
      }
      if (!hb.empty) addMesh(hb.build(), hedgeMat, true);
    }
    yield 'stops+hedges';

    // ----- 실제 상호 간판·지하철 표지 (OSM POI). 상호는 타일당 아틀라스 한 장에 모아 그린다 -----
    {
      const subwayByName = new Map<string, Placement[]>();
      const posts: Placement[] = [];
      const subwayPits: Array<{ x: number; z: number; hx: number; hz: number; side: number; y: number }> = [];
      let seen = 0;
      for (const poi of tile.pois ?? []) {
        // 가게 수백 곳의 벽 찾기도 한 프레임엔 길다
        if (++seen % 120 === 0) yield 'signs-place';
        if (poi.kind === 'station' || poi.kind === 'subway_entrance') {
          const hit = g.nearestEdge(poi.x, poi.z, 40);
          if (!hit) continue;
          const p = g.pointAt(hit.e, 1, hit.s);
          const side = hit.side >= 0 ? 1 : -1;
          const [rx, rz] = rightOf(p.hx, p.hz);
          const x = p.x + rx * side * (hit.e.half + 1.4);
          const z = p.z + rz * side * (hit.e.half + 1.4);
          const y = walkY(hit.e) + terrainAt(x, z);
          const name = poi.name.replace(/\s*\d+번\s*출구$/, '');
          const list = subwayByName.get(name) ?? [];
          list.push({ x, y: y + 3.4, z, yaw: Math.atan2(p.hx, p.hz) + Math.PI / 2, w: 2.0, h: 1.0 });
          subwayByName.set(name, list);
          posts.push({ x, y: y + 1.6, z, yaw: 0, w: 0.1, h: 3.2, d: 0.1 });
          obstacles.push({ x, z, r: 0.1 });
          // 출입구 구조물: 인도 위 계단 구멍(스텐실) + 옹벽·계단·난간 + 유리 캐노피. 큰길 인도에만 (폭 4.5m 안에 들어간다)
          if (poi.kind === 'subway_entrance' && isFlat(hit.e) && hasCurb(hit.e.rank) && walkWidth(hit.e.rank) >= 4 && !hit.e.link) {
            count('subwayCandidate');
            const hx = p.hx;
            const hz = p.hz;
            const cx = p.x + rx * side * (hit.e.half + 2.75) + hx * 3.5;
            const cz = p.z + rz * side * (hit.e.half + 2.75) + hz * 3.5;
            if (!inBuilding(cx, cz) && !inBuilding(cx + hx * 2.5, cz + hz * 2.5) && !inBuilding(cx - hx * 2.5, cz - hz * 2.5)) {
              subwayPits.push({ x: cx, z: cz, hx, hz, side, y: walkY(hit.e) + terrainAt(cx, cz) });
              count('subway');
            } else count('subwayBlocked');
          } else if (poi.kind === 'subway_entrance') count('subwaySkipped');
          continue;
        }
      }
      for (const [name, list] of subwayByName) addInstanced(plane, subwayMat(name), list);
      addInstanced(unitBox, poleMat, posts);
      // 지하철 출입구: 길 방향으로 긴 2.2×5m 계단 구멍. 계단은 길 뒤쪽(진행 반대)에서 앞으로 내려간다
      if (subwayPits.length) {
        const pitB = new GeoBuilder();
        const maskB2 = new GeoBuilder();
        const steps: Placement[] = [];
        const rails: Placement[] = [];
        const postsC: Placement[] = [];
        const roofs: Placement[] = [];
        const HW = 1.1;
        const HL = 2.5;
        const DEPTH = 3.4;
        for (const pit of subwayPits) {
          const { x, z, hx, hz, y } = pit;
          const [rx, rz] = rightOf(hx, hz);
          const yaw = Math.atan2(hx, hz);
          const floor = y - 0.12 - DEPTH;
          const corner = (a: number, s: number) => [x + hx * a + rx * s, z + hz * a + rz * s] as const;
          // 구멍 (스텐실) — 지면·인도·연석이 이 자리에서 비워진다
          const [ax, az] = corner(-HL, -HW);
          const [bx, bz] = corner(-HL, HW);
          const [cx2, cz2] = corner(HL, HW);
          const [dx2, dz2] = corner(HL, -HW);
          const m0 = maskB2.vertex(ax, 0, az, 0, 1, 0);
          const m1 = maskB2.vertex(bx, 0, bz, 0, 1, 0);
          const m2 = maskB2.vertex(cx2, 0, cz2, 0, 1, 0);
          const m3 = maskB2.vertex(dx2, 0, dz2, 0, 1, 0);
          maskB2.quad(m0, m1, m2, m3);
          maskB2.quad(m3, m2, m1, m0);
          // 옹벽 4면 (안쪽을 향한 법선) + 바닥
          const walls: Array<[readonly [number, number], readonly [number, number], number, number]> = [
            [corner(-HL, -HW), corner(HL, -HW), rx, rz],
            [corner(HL, HW), corner(-HL, HW), -rx, -rz],
            [corner(HL, -HW), corner(HL, HW), -hx, -hz],
            [corner(-HL, HW), corner(-HL, -HW), hx, hz],
          ];
          for (const [[x0, z0], [x1, z1], nx, nz] of walls) {
            const a = pitB.vertex(x0, y + 0.13, z0, nx, 0, nz, 0, 0);
            const b = pitB.vertex(x1, y + 0.13, z1, nx, 0, nz, 1, 0);
            const c = pitB.vertex(x1, floor, z1, nx, 0, nz, 1, 1);
            const d = pitB.vertex(x0, floor, z0, nx, 0, nz, 0, 1);
            pitB.quad(a, b, c, d);
            pitB.quad(d, c, b, a);
          }
          const f0 = pitB.vertex(ax, floor, az, 0, 1, 0, 0, 0);
          const f1 = pitB.vertex(bx, floor, bz, 0, 1, 0, 1, 0);
          const f2 = pitB.vertex(cx2, floor, cz2, 0, 1, 0, 1, 1);
          const f3 = pitB.vertex(dx2, floor, dz2, 0, 1, 0, 0, 1);
          pitB.quad(f0, f1, f2, f3);
          pitB.quad(f3, f2, f1, f0);
          // 계단 9단: 뒤쪽 입구(a=-HL)에서 앞으로 내려간다
          const N = 9;
          for (let k = 0; k < N; k++) {
            const a = -HL + (k + 0.5) * ((2 * HL) / N);
            const top = y + 0.12 - ((k + 1) * (y + 0.12 - floor)) / N;
            steps.push({ x: x + hx * a, y: (top + floor) / 2, z: z + hz * a, yaw, w: HW * 2 - 0.1, h: Math.max(0.05, top - floor), d: (2 * HL) / N });
          }
          // 난간 (양쪽 0.95m), 캐노피 기둥 4개와 유리 지붕
          for (const s of [-HW - 0.08, HW + 0.08]) rails.push({ x: x + rx * s, y: y + 0.95, z: z + rz * s, yaw, w: 0.08, h: 0.06, d: HL * 2 + 0.3 });
          for (const s of [-HW - 0.08, HW + 0.08]) for (const a of [-HL + 0.15, 0, HL - 0.15]) rails.push({ x: x + hx * a + rx * s, y: y + 0.5, z: z + hz * a + rz * s, yaw, w: 0.06, h: 1.0, d: 0.06 });
          for (const s of [-HW - 0.5, HW + 0.5]) for (const a of [-HL - 0.3, HL + 0.3]) postsC.push({ x: x + hx * a + rx * s, y: y + 1.35, z: z + hz * a + rz * s, yaw, w: 0.12, h: 2.7, d: 0.12 });
          roofs.push({ x, y: y + 2.75, z, yaw, w: HW * 2 + 1.4, h: 0.1, d: HL * 2 + 1.0 });
          for (const s of [-HW - 0.4, HW + 0.4]) for (const a of [-HL - 0.3, HL + 0.3]) obstacles.push({ x: x + hx * a + rx * s, z: z + hz * a + rz * s, r: 0.25 });
          obstacles.push({ x, z, r: 1.2 }, { x: x + hx * 1.6, z: z + hz * 1.6, r: 1.1 }, { x: x - hx * 1.6, z: z - hz * 1.6, r: 1.1 });
        }
        const mm = addMesh(maskB2.build(), maskMat);
        mm.renderOrder = -2;
        mm.receiveShadow = false;
        addMesh(pitB.build(), tunnelMat);
        addInstanced(unitBox, deckMat, steps);
        addInstanced(unitBox, bollardMat, rails);
        addInstanced(unitBox, poleMat, postsC);
        addInstanced(unitBox, shelterGlassMat, roofs);
      }
    }
    yield 'signs';

    // ----- 교차로 도로명 표지판 (교차하는 길 이름을 글씨로) -----
    {
      const posts: Placement[] = [];
      const byName = new Map<string, Placement[]>();
      for (const [n] of tile.nodes) {
        if (!isSignal(n) || rand() > 0.6) continue;
        const es = g.edgesAt(n).filter((e) => e.name && e.rank <= 4);
        if (es.length < 1) continue;
        const e = es[0];
        const dir = g.dirInto(e, n);
        const p = g.pointAt(e, dir, Math.max(0, e.len - g.cut(e, n) - 2));
        const [rx, rz] = rightOf(p.hx, p.hz);
        const x = p.x + rx * (e.half + 1.6);
        const z = p.z + rz * (e.half + 1.6);
        const y = walkY(e) + terrainAt(x, z);
        posts.push({ x, y: y + 1.6, z, yaw: 0, w: 0.08, h: 3.2, d: 0.08 });
        obstacles.push({ x, z, r: 0.08 });
        // 내 길 이름은 진행 방향과 나란히, 교차하는 길 이름은 그 길 방향으로 위에
        const cross = g.edgesAt(n).find((o) => o.name && o.name !== e.name && o.rank <= 4);
        const names: Array<[string, number, number]> = [[e.name, Math.atan2(p.hx, p.hz) + Math.PI / 2, 2.75]];
        if (cross) {
          const q = g.pointAt(cross, 1, Math.min(cross.len - 0.5, 3));
          names.push([cross.name, Math.atan2(q.hx, q.hz) + Math.PI / 2, 3.25]);
        }
        for (const [name, yaw, sy] of names) {
          const list = byName.get(name) ?? [];
          list.push({ x, y: y + sy, z, yaw, w: 1.8, h: 0.45 });
          byName.set(name, list);
        }
      }
      addInstanced(unitBox, poleMat, posts);
      for (const [name, list] of byName) addInstanced(plane, streetSignMat(name), list);
    }
    yield 'streetsigns';

    // ----- 나무: 가로수는 연석 쪽 인도에 보호덮개와 함께, 공원엔 흩어서 -----
    const trees: Array<{ x: number; z: number; y: number; s: number; park: boolean; wild?: boolean }> = [];
    const grates: Placement[] = [];
    for (const e of edges) {
      if (e.rank > 4 || e.rank < 2 || e.bridge || e.tunnel || e.link) continue;
      const y = walkY(e);
      for (let s = 9; s < e.len - 6; s += 16) {
        const p = g.pointAt(e, 1, s);
        const [rx, rz] = rightOf(p.hx, p.hz);
        for (const side of [1, -1]) {
          const x = p.x + rx * side * (e.half + 1.9);
          const z = p.z + rz * side * (e.half + 1.9);
          if (inBuilding(x, z)) continue;
          const near = g.nearestEdge(x, z, 14);
          if (near && near.d < near.e.half + 1.2) continue;
          const ty = y + terrainAt(x, z);
          trees.push({ x, z, y: ty, s: 0.85 + rand() * 0.3, park: false });
          grates.push({ x, y: ty + 0.006, z, yaw: Math.atan2(p.hx, p.hz), w: 1, h: 1 });
        }
      }
    }
    addInstanced(grateGeo, grateMat, grates);
    yield 'trees';
    for (const ring of tile.parks) {
      const [bx0, bx1, bz0, bz1] = ringBounds(ring);
      const count = Math.min(300, Math.round(ringAreaAbs(ring) / 380));
      if (!count) continue;
      let tries = 0;
      let placed = 0;
      while (placed < count && tries++ < count * 8) {
        const x = bx0 + rand() * (bx1 - bx0);
        const z = bz0 + rand() * (bz1 - bz0);
        if (!pointInRing(ring, x, z) || g.nearestEdge(x, z, 9)) continue;
        trees.push({ x, z, y: terrainAt(x, z), s: 0.8 + rand() * 0.7, park: true });
        placed++;
      }
      if (count > 40) yield 'parktrees';
    }
    // 숲 마스크(도로·건물에서 먼 땅, 산지): 격자점마다 나무 한 그루쯤 흩는다. 길 밖이라 충돌체는 두지 않는다
    if (tile.gm && terrain) {
      const n = terrain.n;
      const st = terrain.step;
      const tx0 = index.bbox.minX + tile.i * index.tile;
      const tz0 = index.bbox.minZ + tile.j * index.tile;
      let placed = 0;
      for (let k = 0; k < tile.gm.length; k++) {
        if (!tile.gm[k] || rand() > 0.75) continue;
        const x = tx0 + (k % n) * st + (rand() - 0.5) * 22;
        const z = tz0 + Math.floor(k / n) * st + (rand() - 0.5) * 22;
        if (inBuilding(x, z) || g.nearestEdge(x, z, 12)) continue;
        trees.push({ x, z, y: terrainAt(x, z), s: 0.9 + rand() * 0.7, park: true, wild: true });
        if (++placed % 400 === 0) yield 'wildtrees';
      }
    }
    for (const t of trees) if (!t.wild) obstacles.push({ x: t.x, z: t.z, r: 0.45 * t.s });
    // 가로수는 가로수 수종, 공원은 전 수종. 모델은 실제 크기라 s 만 곱한다
    for (const [models, park] of [
      [treeSet.street, false],
      [treeSet.park, true],
    ] as const) {
      const buckets = models.map(() => [] as Array<{ x: number; z: number; y: number; s: number }>);
      trees.forEach((t, i) => {
        if (t.park === park) buckets[(park ? i * 7 : i) % models.length].push(t);
      });
      models.forEach((m, k) => {
        const list = buckets[k];
        if (!list.length) return;
        const mesh = new THREE.InstancedMesh(m.geometry, m.materials, list.length);
        list.forEach((t, i) => {
          dummy.position.set(t.x, t.y, t.z);
          dummy.rotation.set(0, rand() * Math.PI * 2, 0);
          dummy.scale.setScalar(t.s);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        mesh.castShadow = true;
        group.add(mesh);
      });
    }
    yield 'placetrees';


    // ----- 가로등: 큰길(1~3등급)은 양쪽 45m, 동네 간선(4등급)은 한쪽 55m. 골목엔 없다 -----
    {
      const lamps: Array<{ x: number; y: number; z: number; dx: number; dz: number }> = [];
      for (const e of edges) {
        if (e.rank > 4 || e.tunnel || e.len < 20) continue;
        const spacing = e.rank <= 3 ? 45 : 55;
        const n = Math.max(1, Math.round(e.len / spacing));
        const y = walkY(e);
        for (let k = 0; k < n; k++) {
          const p = g.pointAt(e, 1, (e.len * (k + 0.5)) / n);
          const [rx, rz] = rightOf(p.hx, p.hz);
          const sides = e.rank <= 3 ? [1, -1] : [k % 2 ? -1 : 1];
          for (const side of sides) {
            const x = p.x + rx * side * (e.half + 1.3);
            const z = p.z + rz * side * (e.half + 1.3);
            if (inBuilding(x, z)) continue;
            // 상·하행이 따로 그려진 대로의 안쪽은 옆 차로 위일 수 있다
            const near = g.nearestEdge(x, z, 16);
            if (near && near.e.id !== e.id && near.d < near.e.half + 0.6) continue;
            lamps.push({ x, y: p.y + y, z, dx: -rx * side, dz: -rz * side });
          }
        }
      }
      for (const l of lamps) obstacles.push({ x: l.x, z: l.z, r: 0.16, y: l.y });
      // 팔이 차도(dx,dz)를 향하게 yaw 를 준다 (+Z 가 팔 방향)
      const list = lamps.map((l) => ({ x: l.x, y: l.y, z: l.z, yaw: Math.atan2(l.dx, l.dz), w: 1, h: 1 }));
      addInstanced(lampGeo, poleMat, list, undefined, true);
      addInstanced(lensGeo, lensMat, list);
      addInstanced(poolGeo, poolMat, lamps.map((l) => ({ x: l.x + l.dx * 3.2, y: l.y + 0.05, z: l.z + l.dz * 3.2, yaw: 0, w: 1, h: 1 })));
      if (lamps.length) {
        const haloPos = new Float32Array(lamps.length * 3);
        lamps.forEach((l, i) => haloPos.set([l.x + l.dx * 2.5, l.y + 7.9, l.z + l.dz * 2.5], i * 3));
        const haloGeo = new THREE.BufferGeometry();
        haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
        group.add(new THREE.Points(haloGeo, haloMat));
        disposables.push(haloGeo);
      }
    }

    scene.add(group);
    const ts: TileScene = {
      group,
      obstacles,
      walks,
      stops: busStops,
      counts,
      ctx: { tile, g, edges, inBuilding, nearestWall },
      extras: null,
      dispose() {
        scene.remove(group);
        group.traverse((o) => {
          const m = o as THREE.InstancedMesh;
          if (m.isInstancedMesh) m.dispose();
        });
        for (const d of disposables) d.dispose();
      },
    };
    tiles.set(key, ts);
    tileDisposables.set(key, disposables);
    lastGraph = g;
    flushPendingCorners(cornerPieces);
    return ts;
  }

  /** 이웃 타일이 들어와 길이 다 갖춰진 경계 노드의 교차로 모서리를 그 타일 그룹에 더한다 */
  function flushPendingCorners(cornerPieces: (nodeList: Node[], walkB: GeoBuilder, curbBld: GeoBuilder) => void): void {
    const g = lastGraph;
    if (!g) return;
    for (const [k, nodesLeft] of pendingCorners) {
      const ts = tiles.get(k);
      if (!ts) {
        pendingCorners.delete(k);
        continue;
      }
      const ready: Node[] = [];
      const rest: Node[] = [];
      for (const n of nodesLeft) {
        if (!g.has(n)) continue;
        const [x, z] = g.pos(n);
        (neighborsLoaded(x, z, k) ? ready : rest).push(n);
      }
      if (ready.length) {
        const wb = new GeoBuilder();
        const cb = new GeoBuilder();
        cornerPieces(ready, wb, cb);
        for (const [b, mat] of [
          [wb, walkMat],
          [cb, curbMat],
        ] as const) {
          if (b.empty) continue;
          const m = new THREE.Mesh(b.build(), mat);
          m.receiveShadow = true;
          ts.group.add(m);
          tileDisposables.get(k)?.push(m.geometry);
        }
      }
      if (rest.length) pendingCorners.set(k, rest);
      else pendingCorners.delete(k);
    }
  }

  /** 가까운 타일에만 더하는 상세: 상호 간판 아틀라스, 길가 주차 차량. 멀어지면 removeExtras 로 치운다 */
  function* buildExtras(key: string): Generator<string, Obstacle[] | null> {
    const ts = tiles.get(key);
    if (!ts || ts.extras) return null;
    const { tile, g, edges, inBuilding, nearestWall } = ts.ctx;
    let hsh = 7;
    for (const ch of key) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    const rand = mulberry32(hsh + 77);
    const group = new THREE.Group();
    group.name = `extras:${key}`;
    const obstacles: Obstacle[] = [];
    const disposables: Array<{ dispose(): void }> = [];
    const count = (k: string, n = 1) => (ts.counts[k] = (ts.counts[k] ?? 0) + n);
    const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], shadow = false): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.castShadow = shadow;
      group.add(m);
      disposables.push(geo);
      return m;
    };
    const ex = {
      group,
      obstacles,
      dispose() {
        scene.remove(group);
        group.traverse((o) => {
          const m = o as THREE.InstancedMesh;
          if (m.isInstancedMesh) m.dispose();
        });
        for (const d of disposables) d.dispose();
      },
    };
    ts.extras = ex;
    scene.add(group);

    // ----- 실제 상호 간판 (OSM POI): 가장 가까운 건물 벽에, 타일당 아틀라스에 모아 그린다 -----
    {
      const signIndex = new Map<string, number>();
      const entries: Array<[string, string]> = [];
      const signPlacements: Array<Placement & { cell: number }> = [];
      let seen = 0;
      for (const poi of tile.pois ?? []) {
        if (++seen % 120 === 0) yield 'x-signs-place';
        if ((poi.kind !== 'shop' && poi.kind !== 'amenity' && poi.kind !== 'tourism') || !poi.name || signPlacements.length >= 420) continue;
        // 가게 위치에서 가장 가까운 건물 벽을 찾아 그 벽에 간판을 붙인다 (상가 띠 높이). 벽이 없으면 길가에 세운다
        const wall = nearestWall(poi.x, poi.z, 12);
        let x: number;
        let z: number;
        let yaw: number;
        let w = 3.2;
        if (wall) {
          x = wall.px + wall.nx * 0.12;
          z = wall.pz + wall.nz * 0.12;
          yaw = Math.atan2(wall.nx, wall.nz);
          w = Math.min(3.2, Math.max(1.6, wall.len - 0.4));
        } else {
          const hit = g.nearestEdge(poi.x, poi.z, 45);
          if (!hit) continue;
          const p = g.pointAt(hit.e, 1, hit.s);
          const side = hit.side >= 0 ? 1 : -1;
          const [rx, rz] = rightOf(p.hx, p.hz);
          const edgeD = hit.e.half + walkWidth(hit.e.rank);
          x = p.x + rx * side * (edgeD + 0.3);
          z = p.z + rz * side * (edgeD + 0.3);
          yaw = Math.atan2(-rx * side, -rz * side);
        }
        const sub = SUB_KO[poi.sub] ?? '';
        const key = `${poi.name}|${sub}`;
        let cell = signIndex.get(key);
        if (cell === undefined) {
          if (entries.length >= 256) continue;
          cell = entries.length;
          entries.push([poi.name, sub]);
          signIndex.set(key, cell);
        }
        signPlacements.push({ x, y: 3.15 + terrainAt(x, z), z, yaw, w, h: w / 4, cell });
      }
      // 아틀라스는 128칸씩 나눠 GPU 업로드 한 번이 길지 않게 한다 (각각 다른 프레임에)
      const PER = 128;
      for (let g0 = 0; g0 < entries.length; g0 += PER) {
        const part = entries.slice(g0, g0 + PER);
        const atlas = shopNameAtlas(part.length);
        // 글씨 그리기는 칸당 0.1~0.2ms. 32칸씩 끊는다
        for (let i = 0; i < part.length; i++) {
          atlas.draw(i, part[i][0], part[i][1]);
          if (i % 32 === 31) yield 'signs-draw';
        }
        yield 'signs-draw';
        const texture = atlas.finish();
        prewarm(texture);
        yield 'signs-upload';
        const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, color: 0xffffff });
        mat.color.setScalar(0.85 + 0.15 * night);
        shopMats.add(mat);
        disposables.push({
          dispose() {
            shopMats.delete(mat);
            texture.dispose();
            mat.dispose();
          },
        });
        const sb = new GeoBuilder();
        for (const p of signPlacements) if (p.cell >= g0 && p.cell < g0 + PER) signQuad(sb, p.x, p.y, p.z, p.yaw, p.w, p.h, atlas.uv(p.cell - g0));
        if (!sb.empty) addMesh(sb.build(), mat).receiveShadow = false;
      }
    }
    // ----- 길가 주차 차량: 동네길·골목(5~6등급) 한쪽 가장자리에 9m 마다 절반 확률 -----
    const parked: Array<{ x: number; z: number; yaw: number; y: number }> = [];
    for (const e of edges) {
      if (e.rank < 5 || !isFlat(e) || e.link || e.len < 30 || e.lf + e.lb > 2) continue;
      const side = rand() < 0.5 ? 1 : -1;
      const flip = rand() < 0.5;
      for (let s = 12 + rand() * 6; s < e.len - 12; s += 9) {
        if (rand() > 0.5) continue;
        const p = g.pointAt(e, 1, s);
        const [rx, rz] = rightOf(p.hx, p.hz);
        const x = p.x + rx * side * (e.half + 0.55);
        const z = p.z + rz * side * (e.half + 0.55);
        if (inBuilding(x, z) || inBuilding(x + rx * side * 1.2, z + rz * side * 1.2)) continue;
        const near = g.nearestEdge(x, z, 10);
        if (near && near.e.id !== e.id && near.d < near.e.half + 1.5) continue;
        parked.push({ x, z, yaw: Math.atan2(p.hx, p.hz) + (flip ? Math.PI : 0), y: 0.012 + terrainAt(x, z) });
        count('parked');
        obstacles.push({ x: x + p.hx * 1.1, z: z + p.hz * 1.1, r: 0.95 }, { x: x - p.hx * 1.1, z: z - p.hz * 1.1, r: 0.95 });
      }
    }
    const placeCars = () => {
      if (!carModels?.length || !parked.length) return;
      const buckets = carModels.map(() => [] as typeof parked);
      parked.forEach((c, i) => buckets[Math.abs(i * 7 + Math.floor(c.x)) % carModels!.length].push(c));
      carModels.forEach((cm, k) => {
        const list = buckets[k];
        if (!list.length) return;
        const mesh = new THREE.InstancedMesh(cm.m.geometry, cm.m.materials, list.length);
        list.forEach((c, i) => {
          dummy.position.set(c.x, c.y + cm.yOff, c.z);
          dummy.rotation.set(0, c.yaw, 0);
          dummy.scale.setScalar(cm.scale);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        mesh.castShadow = true;
        group.add(mesh);
      });
    };
    if (carModels) placeCars();
    else carWaiters.push(() => tiles.get(key)?.extras === ex && placeCars());
    yield 'x-parked';
    return obstacles;
  }

  let wet = false;
  let night = 1;
  const applyLook = () => {
    const k = night;
    const wetK = wet ? 0.7 : 1;
    mixHex(groundMat, 0x85878b, 0x2a2d36, k).multiplyScalar(wetK);
    mixHex(backdropMat, 0x66686c, 0x1e2028, k);
    groundMat.roughness = wet ? 0.35 : 0.95;
    mixHex(roadMat, 0x8e9095, 0x2c2f38, k).multiplyScalar(wetK);
    roadMat.roughness = wet ? 0.35 : 1;
    mixHex(walkMat, 0x9f9e98, 0x3a3e48, k);
    walkMat.roughness = wet ? 0.5 : 1;
    mixHex(curbMat, 0xa9aaa6, 0x383b42, k);
    mixHex(grassMat, 0x9aa684, 0x1e271c, k);
    mixHex(fieldMat, 0xa6bb8e, 0x22301f, k);
    mixHex(hedgeMat, 0xb0b8a2, 0x2a3326, k);
    mixHex(bollardMat, 0xcfd3d8, 0x3a3f48, k);
    // 가로등 렌즈: 낮엔 흐린 유리, 밤엔 주황빛
    mixHex(lensMat, 0xb8bcc2, 0xffd9a0, k);
    mixHex(deckMat, 0x8a8d94, 0x2c2f38, k);
    mixHex(parkMat, 0x8f9a7e, 0x1a2419, k);
    mixHex(roofMat, 0x87898d, 0x23262e, k);
    mixHex(hvacMat, 0x9aa0a8, 0x2e323a, k);
    mixHex(tankMat, 0xc9b98a, 0x3a362a, k);
    for (const m of allWalls) {
      mixHex(m, 0xffffff, 0x4a4e5a, k);
      m.emissiveIntensity = k;
    }
    mixHex(waterMat, 0x3d7bb5, 0x1a3a66, k);
    waterMat.emissive.setHex(0x0f2a52).multiplyScalar(k);
    poolMat.opacity = k;
    haloMat.opacity = k;
    for (const m of allSignMats) m.color.setScalar(0.85 + 0.15 * k);
    for (const m of shopMats) m.color.setScalar(0.85 + 0.15 * k);
  };
  applyLook();

  return {
    buildTile,
    warmMaterials() {
      const both = (mat: THREE.Material): WarmMaterial[] => [{ mat }, { mat, inst: true }];
      return [
        { mat: groundMat }, { mat: backdropMat }, { mat: waterMat }, { mat: parkMat }, { mat: railMat }, { mat: grassMat }, { mat: fieldMat }, { mat: standMat },
        ...both(roadMat), { mat: walkMat }, { mat: curbMat }, { mat: hedgeMat }, { mat: deckMat, inst: true }, { mat: deckMat }, { mat: tunnelMat }, { mat: bridgeRailMat, inst: true },
        { mat: maskMat }, { mat: maskMat, inst: true }, { mat: yellowMat, inst: true }, { mat: whiteMat, inst: true }, { mat: barMat, inst: true },
        ...Object.values(arrowMats).map((m) => ({ mat: m, inst: true })), { mat: busLaneMat }, { mat: busTextMat, inst: true },
        { mat: grateMat, inst: true }, { mat: bollardMat, inst: true }, { mat: lensMat, inst: true }, { mat: poolMat, inst: true }, { mat: haloMat, points: true },
        { mat: poleMat, inst: true }, { mat: beaconMat, inst: true }, { mat: frameMat, inst: true }, { mat: hvacMat, inst: true }, { mat: tankMat, inst: true },
        { mat: shelterMat, inst: true }, { mat: shelterGlassMat, inst: true }, { mat: shelterSignMat, inst: true }, { mat: manholeMat, inst: true },
        { mat: trashMat, inst: true }, { mat: utilityBoxMat, inst: true }, { mat: domeMat, inst: true }, { mat: spireMat, inst: true }, { mat: crownMat },
        { mat: roofMat }, { mat: parapetMat }, { mat: awningMat, inst: true, instColor: true },
        ...allWalls.map((m) => ({ mat: m })), ...signMats.map((m) => ({ mat: m, inst: true })), ...billMats.map((m) => ({ mat: m, inst: true })),
        ...dongMats.map((m) => ({ mat: m, inst: true })), { mat: subwayMat('워밍업'), inst: true }, { mat: streetSignMat('워밍업'), inst: true },
        { mat: treeSet.barkMat, inst: true }, ...treeSet.leafMats.map((m) => ({ mat: m, inst: true })),
        ...(carModels ?? []).flatMap((c) => c.m.materials.map((m) => ({ mat: m, inst: true }))),
      ];
    },
    removeTile(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      pendingCorners.delete(key);
      tileDisposables.delete(key);
      t.extras?.dispose();
      t.extras = null;
      t.dispose();
    },
    buildExtras,
    removeExtras(key) {
      const t = tiles.get(key);
      if (!t?.extras) return;
      t.extras.dispose();
      t.extras = null;
    },
    update(t) {
      beaconMat.color.setHex(Math.sin(t * 3) > 0 ? 0xff3040 : 0x330408);
      ripple.offset.set(t * 0.012, t * 0.008);
    },
    setWet(w) {
      wet = w;
      applyLook();
    },
    setNight(n) {
      night = n;
      applyLook();
    },
  };
}
