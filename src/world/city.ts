import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import { aptTextures, billboardTexture, dongTexture, facadeSet, loadMerged, loadTex, signTexture, storefrontTextures, wallRepeat } from '../render/assets.ts';
import { glowTexture, windowTexture } from '../render/textures.ts';
import type { Node, RoadGraph } from './graph.ts';
import type { BuildingData, MapData } from './mapdata.ts';
import { pointInRing } from './collision.ts';
import { rightOf } from './roads.ts';

export interface City {
  /** 매 프레임 호출. 고층 빌딩 경고등 깜빡임, 물결 */
  update(t: number): void;
  /** 비가 올 때 노면을 젖은 느낌으로 */
  setWet(wet: boolean): void;
  /** 0 낮 .. 1 밤. 재질 색과 창문·가로등·네온 밝기를 바꾼다 */
  setNight(night: number): void;
}

const STORE_H = 3.6;
const mixHex = (mat: { color: THREE.Color }, day: number, night: number, k: number) => mat.color.setHex(day).lerp(new THREE.Color(night), k);

/** 삼각형을 모아 BufferGeometry 하나로 */
class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
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
    geo.setIndex(this.idx);
    return geo;
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
}

/** 폴리라인을 따라 폭 2*half 의 띠. u 는 0..1 가로, v 는 길이/vTile */
function ribbon(b: GeoBuilder, pts: number[], half: number, y: number, vTile = 8): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const left: number[] = [];
  const right: number[] = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2];
    const pz = pts[i * 2 + 1];
    if (i > 0) cum += Math.hypot(px - pts[i * 2 - 2], pz - pts[i * 2 - 1]);
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
    nx /= count;
    nz /= count;
    const l = Math.hypot(nx, nz) || 1;
    const scale = Math.min(1 / Math.max(l, 0.5), 1.6);
    nx = (nx / l) * scale;
    nz = (nz / l) * scale;
    left.push(b.vertex(px - nx * half, y, pz - nz * half, 0, 1, 0, 0, cum / vTile));
    right.push(b.vertex(px + nx * half, y, pz + nz * half, 0, 1, 0, 1, cum / vTile));
  }
  for (let i = 0; i < n - 1; i++) b.quad(left[i], right[i], right[i + 1], left[i + 1]);
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

/** 평면 폴리곤 (지붕, 물, 공원) */
function flatPolygon(b: GeoBuilder, ring: number[], y: number, uvScale = 20): void {
  const contour: THREE.Vector2[] = [];
  for (let i = 0; i < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return;
  }
  const base = b.pos.length / 3;
  for (const p of contour) b.vertex(p.x, y, p.y, 0, 1, 0, p.x / uvScale, p.y / uvScale);
  for (const f of faces) b.idx.push(base + f[0], base + f[1], base + f[2]);
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  w: number;
  h: number;
}
function placeInstances(mesh: THREE.InstancedMesh, list: Placement[], dummy: THREE.Object3D): void {
  list.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.yaw, 0);
    dummy.scale.set(p.w, p.h, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
}

export function buildCity(scene: THREE.Scene, map: MapData, g: RoadGraph, isSignal: (n: Node) => boolean): City {
  const rand = mulberry32(20261021);
  const dummy = new THREE.Object3D();
  const { minX, maxX, minZ, maxZ } = g.bbox;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const spanX = maxX - minX + 1200;
  const spanZ = maxZ - minZ + 1200;

  // ----- 바닥, 물, 공원, 철도 -----
  const groundMat = new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, spanX / 10, spanZ / 10), roughness: 0.95, color: 0x8d9097 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(spanX, spanZ), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 0, cz);
  ground.receiveShadow = true;
  scene.add(ground);

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
  const parkMat = new THREE.MeshLambertMaterial({ color: 0x15261c, side: THREE.DoubleSide });
  {
    const wb = new GeoBuilder();
    for (const ring of map.water) flatPolygon(wb, ring, 0.04);
    if (!wb.empty) {
      const water = new THREE.Mesh(wb.build(), waterMat);
      water.name = 'water';
      scene.add(water);
    }
    const pb = new GeoBuilder();
    for (const ring of map.parks) flatPolygon(pb, ring, 0.03);
    if (!pb.empty) {
      const park = new THREE.Mesh(pb.build(), parkMat);
      park.receiveShadow = true;
      scene.add(park);
    }
    const rb = new GeoBuilder();
    for (const pts of map.rails) ribbon(rb, pts, 2.4, 0.012);
    if (!rb.empty) scene.add(new THREE.Mesh(rb.build(), new THREE.MeshLambertMaterial({ color: 0x23262e, side: THREE.DoubleSide })));
  }

  // 건물 AABB 격자: 가로수·간판이 건물 안에 들어가지 않게
  const bGrid = new Map<string, number[][]>();
  for (const bd of map.buildings) {
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

  // ----- 도로 띠(아스팔트), 인도(보도블록), 다리 -----
  const roadMat = new THREE.MeshStandardMaterial({ map: loadTex('Asphalt033_Color.jpg', true, 1, 1), normalMap: loadTex('Asphalt033_NormalGL.jpg', false, 1, 1), roughness: 0.9, color: 0x9a9ca3 });
  const walkMat = new THREE.MeshStandardMaterial({ map: loadTex('PavingStones151_Color.jpg', true, 4, 1), normalMap: loadTex('PavingStones151_NormalGL.jpg', false, 4, 1), roughness: 0.9, color: 0xb9bcc3 });
  const deckMat = new THREE.MeshStandardMaterial({ map: loadTex('Asphalt033_Color.jpg', true, 1, 1), roughness: 0.9, color: 0x8a8d94 });
  {
    const rb = new GeoBuilder();
    const sb = new GeoBuilder();
    const bb = new GeoBuilder();
    for (const e of g.edges) {
      if (e.bridge) ribbon(bb, e.pts, e.half + 0.6, 0.3);
      else {
        ribbon(rb, e.pts, e.half + 0.3, 0.02);
        if (!e.tunnel) ribbon(sb, e.pts, e.half + (e.rank <= 4 ? 4.5 : 2.2), 0.012, 2);
      }
    }
    const walk = new THREE.Mesh(sb.build(), walkMat);
    const road = new THREE.Mesh(rb.build(), roadMat);
    walk.receiveShadow = road.receiveShadow = true;
    scene.add(walk, road);
    if (!bb.empty) {
      const deck = new THREE.Mesh(bb.build(), deckMat);
      deck.receiveShadow = true;
      scene.add(deck);
    }
    const rails: Array<[number, number, number]> = [];
    for (const e of g.edges) {
      if (!e.bridge) continue;
      for (let s = 1.5; s < e.len; s += 3) {
        const p = g.pointAt(e, 1, s);
        const [rx, rz] = rightOf(p.hx, p.hz);
        for (const side of [-1, 1]) rails.push([p.x + rx * side * (e.half + 0.9), p.z + rz * side * (e.half + 0.9), Math.atan2(p.hx, p.hz)]);
      }
    }
    if (rails.length) {
      const rm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 1.0, 3), new THREE.MeshLambertMaterial({ color: 0x8b93a3 }), rails.length);
      rails.forEach(([x, z, yaw], i) => {
        dummy.position.set(x, 0.8, z);
        dummy.rotation.set(0, yaw, 0);
        dummy.updateMatrix();
        rm.setMatrixAt(i, dummy.matrix);
      });
      scene.add(rm);
    }
  }

  // ----- 차선 표시 -----
  {
    const yellow: Array<[number, number, number, number]> = [];
    const white: Array<[number, number, number]> = [];
    const bars: Array<[number, number, number, number, number]> = [];
    for (const e of g.edges) {
      if (e.rank > 6 && e.lf + e.lb < 2) continue;
      const twoWay = e.lb > 0;
      if (twoWay) {
        for (let s = 3; s < e.len - 1; s += 6) {
          const p = g.pointAt(e, 1, s);
          yellow.push([p.x, p.z, Math.atan2(p.hx, p.hz), Math.min(6, e.len - s + 2)]);
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
          for (const o of offs) white.push([p.x + rx * o, p.z + rz * o, Math.atan2(p.hx, p.hz)]);
        }
      }
    }
    for (let n = 0; n < g.nodes.length; n++) {
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
        bars.push([p.x + rx * center, p.z + rz * center, yaw, laneSpan - 0.5, 0.4]);
        const q = g.pointAt(e, dir, Math.max(0, e.len - cut + 0.6));
        for (let o = -e.half + 0.9; o < e.half - 0.3; o += 2.1) bars.push([q.x + rx * o, q.z + rz * o, yaw, 1.2, 2.4]);
      }
    }
    const unit = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const place = (mesh: THREE.InstancedMesh, i: number, x: number, z: number, yaw: number, w: number, d: number, y: number) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(w, 1, d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    };
    const ym = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial({ color: 0xd9b24a }), yellow.length);
    yellow.forEach(([x, z, yaw, len], i) => place(ym, i, x, z, yaw, 0.16, len, 0.035));
    const wm = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial({ color: 0xe8ebf2 }), white.length);
    white.forEach(([x, z, yaw], i) => place(wm, i, x, z, yaw, 0.15, 3, 0.035));
    const bm = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial({ color: 0xf0f2f6 }), bars.length);
    bars.forEach(([x, z, yaw, w, d], i) => place(bm, i, x, z, yaw, w, d, 0.036));
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    scene.add(ym, wm, bm);
  }

  // ----- 건물 재질 -----
  // 벽 지오메트리는 재질별·구역별(CHUNK m)로 나눠 시야 밖 구역은 그리지 않게 한다
  const CHUNK = 640;
  interface Wall {
    mat: THREE.MeshStandardMaterial;
    chunks: Map<string, GeoBuilder>;
  }
  const chunkOf = (chunks: Map<string, GeoBuilder>, x: number, z: number): GeoBuilder => {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let b = chunks.get(k);
    if (!b) {
      b = new GeoBuilder();
      chunks.set(k, b);
    }
    return b;
  };
  const windows = (seed: number) => {
    const t = windowTexture(seed);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const stdWall = (set: ReturnType<typeof facadeSet>, seed: number, roughness = 0.75): Wall => ({
    mat: new THREE.MeshStandardMaterial({ map: set.map, normalMap: set.normalMap, emissive: 0xffffff, emissiveMap: set.emissiveMap ?? windows(seed), emissiveIntensity: 0, roughness, metalness: 0 }),
    chunks: new Map(),
  });
  const glass1 = stdWall(facadeSet('Facade001', 16, 16, false), 11, 0.35);
  const glass2 = stdWall(facadeSet('Facade005', 12, 12, false), 12, 0.35);
  const office = stdWall(facadeSet('Facade006', 14, 16, false), 13, 0.6);
  const brick1 = stdWall(facadeSet('Facade018A', 12, 14, true), 14);
  const brick2 = stdWall(facadeSet('Facade019A', 12, 14, true), 15);
  const brick3 = stdWall(facadeSet('Facade020A', 12, 14, true), 16);
  const nightOffice = stdWall(facadeSet('Facade013', 16, 18, true), 17, 0.5);
  const aptWalls: Wall[] = [1, 2, 3].map((s) => {
    const t = aptTextures(s);
    t.map.repeat.set(1, 1);
    t.emissive.repeat.set(1, 1);
    return { mat: new THREE.MeshStandardMaterial({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.85 }), chunks: new Map() };
  });
  const storeWalls: Wall[] = [1, 2, 3, 4].map((s) => {
    const t = storefrontTextures(s);
    return { mat: new THREE.MeshStandardMaterial({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.5 }), chunks: new Map() };
  });
  const towerSet = [glass1, glass2, office, nightOffice];
  const blockSet = [office, brick1, brick2, brick3];
  const lowSet = [brick1, brick2, brick3, office];
  const allWalls = [glass1, glass2, office, brick1, brick2, brick3, nightOffice, ...aptWalls, ...storeWalls];
  const roofMat = new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 3.3, 3.3), roughness: 0.95, color: 0x8f9298, side: THREE.DoubleSide });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3040 });
  const roofChunks = new Map<string, GeoBuilder>();
  const beacons: Array<[number, number, number]> = [];

  // 간판·광고판·동번호 배치
  const SIGN_VARIANTS = 12;
  const signLists: Placement[][] = Array.from({ length: SIGN_VARIANTS }, () => []);
  const BILL_VARIANTS = 5;
  const billLists: Placement[][] = Array.from({ length: BILL_VARIANTS }, () => []);
  const billFrames: Placement[] = [];
  const dongLists: Placement[][] = Array.from({ length: 12 }, () => []);
  let signCount = 0;

  /** 벽 사각형 하나 (y0..y1). uv 는 (u0..u1, v0..v1) */
  function wallQuad(b: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, nx: number, nz: number, u0: number, u1: number, v0: number, v1: number): void {
    // 바깥에서 봤을 때 글씨가 왼→오 로 읽히도록, 면 방향에 따라 u 를 뒤집는다
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
    const nearBig = commercial && !!g.nearestEdge(ccx, ccz, 40 + Math.sqrt(ringAreaAbs(ring)))?.e && (g.nearestEdge(ccx, ccz, 60)?.e.rank ?? 9) <= 3;
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
      // 길을 향한 면인지 (벽 앞 4m 지점이 도로에서 16m 안)
      const streetFace = !!g.nearestEdge(mx + nx * 4, mz + nz * 4, 16);
      const u0 = cum / uScale + ou;
      const u1 = (cum + len) / uScale + ou;
      const hasStore = commercial && streetFace && bd.h > STORE_H + 1.5;
      const wb = chunkOf(wall.chunks, ccx, ccz);
      if (hasStore) {
        wallQuad(chunkOf(store.chunks, ccx, ccz), x0, z0, x1, z1, 0, STORE_H, nx, nz, cum / 12, (cum + len) / 12, 0, 1);
        wallQuad(wb, x0, z0, x1, z1, STORE_H, bd.h, nx, nz, u0, u1, STORE_H / vScale + ov, bd.h / vScale + ov);
      } else wallQuad(wb, x0, z0, x1, z1, 0, bd.h, nx, nz, u0, u1, ov, bd.h / vScale + ov);
      cum += len;
      if (len > longestLen) {
        longestLen = len;
        longest = i;
      }
      // 상가 위층 간판: 층마다 하나씩
      if (commercial && streetFace && len >= 3.5 && signCount < 14000) {
        const floors = Math.min(4, Math.floor((bd.h - 1) / STORE_H));
        for (let f = 1; f < floors; f++) {
          if (rand() > 0.75) continue;
          const w = Math.min(len - 0.8, 2.6 + rand() * 3.4);
          const along = (rand() - 0.5) * (len - w - 0.4);
          const [rx, rz] = rightOf(nx, nz);
          signLists[Math.floor(rand() * SIGN_VARIANTS)].push({
            x: mx + nx * 0.12 + rx * along,
            y: STORE_H * f + 1.9,
            z: mz + nz * 0.12 + rz * along,
            yaw: Math.atan2(nx, nz),
            w,
            h: w / 4,
          });
          signCount++;
        }
      }
    }
    flatPolygon(chunkOf(roofChunks, ccx, ccz), ring, bd.h, 6);
    if (bd.h > 55) beacons.push([ccx, bd.h + 0.6, ccz]);
    // 옥상 광고판: 큰길가 중·고층
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
      const p: Placement = { x: (x0 + x1) / 2 - nx * 1.2, y: bd.h + 2.2 + w / 5, z: (z0 + z1) / 2 - nz * 1.2, yaw: Math.atan2(nx, nz), w, h: w / 2.5 };
      billLists[Math.floor(rand() * BILL_VARIANTS)].push(p);
      billFrames.push({ x: p.x - nx * 0.4, y: bd.h + 1.1 + w / 5, z: p.z - nz * 0.4, yaw: p.yaw, w: w * 0.9, h: w / 2.5 + 2.2 });
    }
    // 아파트 동 번호
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
      dongLists[Math.floor(rand() * 12)].push({ x: (x0 + x1) / 2 + nx * 0.1, y: bd.h - s * 0.8, z: (z0 + z1) / 2 + nz * 0.1, yaw: Math.atan2(nx, nz), w: s, h: s });
    }
  }
  for (const bd of map.buildings) buildBuilding(bd);

  for (const w of allWalls) {
    for (const b of w.chunks.values()) {
      if (b.empty) continue;
      const mesh = new THREE.Mesh(b.build(), w.mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }
  for (const b of roofChunks.values()) {
    if (b.empty) continue;
    const roof = new THREE.Mesh(b.build(), roofMat);
    roof.receiveShadow = true;
    scene.add(roof);
  }
  if (beacons.length) {
    const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), beaconMat, beacons.length);
    beacons.forEach(([x, y, z], i) => {
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      bm.setMatrixAt(i, dummy.matrix);
    });
    scene.add(bm);
  }
  const plane = new THREE.PlaneGeometry(1, 1);
  const signMats: THREE.MeshBasicMaterial[] = [];
  signLists.forEach((list, v) => {
    if (!list.length) return;
    const mat = new THREE.MeshBasicMaterial({ map: signTexture(v + 1), side: THREE.DoubleSide });
    signMats.push(mat);
    const mesh = new THREE.InstancedMesh(plane, mat, list.length);
    placeInstances(mesh, list, dummy);
    scene.add(mesh);
  });
  billLists.forEach((list, v) => {
    if (!list.length) return;
    const mat = new THREE.MeshBasicMaterial({ map: billboardTexture(v + 1), side: THREE.DoubleSide });
    signMats.push(mat);
    const mesh = new THREE.InstancedMesh(plane, mat, list.length);
    placeInstances(mesh, list, dummy);
    scene.add(mesh);
  });
  if (billFrames.length) {
    const frame = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.3), new THREE.MeshLambertMaterial({ color: 0x3a3f4a }), billFrames.length);
    placeInstances(frame, billFrames, dummy);
    scene.add(frame);
  }
  dongLists.forEach((list, v) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ map: dongTexture(101 + v), transparent: true, side: THREE.DoubleSide }), list.length);
    placeInstances(mesh, list, dummy);
    scene.add(mesh);
  });

  // ----- 나무: 공원·가로수 자리를 먼저 정하고 Kenney 모델을 인스턴싱 -----
  const trees: Array<{ x: number; z: number; s: number; park: boolean }> = [];
  for (const e of g.edges) {
    if (e.rank > 4 || e.rank < 2 || e.bridge || e.tunnel || e.link) continue;
    for (let s = 9; s < e.len - 6; s += 16) {
      const p = g.pointAt(e, 1, s);
      const [rx, rz] = rightOf(p.hx, p.hz);
      for (const side of [1, -1]) {
        const x = p.x + rx * side * (e.half + 2.6);
        const z = p.z + rz * side * (e.half + 2.6);
        if (inBuilding(x, z) || g.nearestEdge(x, z, 2.2)) continue;
        trees.push({ x, z, s: 0.85 + rand() * 0.3, park: false });
      }
    }
  }
  for (const ring of map.parks) {
    const [bx0, bx1, bz0, bz1] = ringBounds(ring);
    const count = Math.min(500, Math.round(ringAreaAbs(ring) / 380));
    let tries = 0;
    let placed = 0;
    while (placed < count && tries++ < count * 8) {
      const x = bx0 + rand() * (bx1 - bx0);
      const z = bz0 + rand() * (bz1 - bz0);
      if (!pointInRing(ring, x, z) || g.nearestEdge(x, z, 9)) continue;
      trees.push({ x, z, s: 0.8 + rand() * 0.7, park: true });
      placed++;
    }
  }
  void (async () => {
    const base = `${import.meta.env.BASE_URL}models/kenney-nature/`;
    const recolor = (m: THREE.MeshStandardMaterial) => {
      if (/leaf|grass/i.test(m.name)) m.color.setHex([0x4f8f3f, 0x3f7a35, 0x5c9a44][Math.floor(rand() * 3)]);
      else if (/bark|wood/i.test(m.name)) m.color.setHex(0x5a4330);
      m.roughness = 0.9;
    };
    const kinds = await Promise.all(['tree_default', 'tree_oak', 'tree_tall', 'tree_simple', 'tree_fat'].map((n) => loadMerged(`${base}${n}.glb`, recolor)));
    const models = kinds.filter((k): k is NonNullable<typeof k> => !!k);
    if (!models.length) return;
    const buckets = models.map(() => [] as Array<{ x: number; z: number; s: number }>);
    trees.forEach((t, i) => buckets[(t.park ? i * 7 : i) % models.length].push(t));
    models.forEach((m, k) => {
      const list = buckets[k];
      if (!list.length) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      const height = bb.max.y - bb.min.y || 1;
      const base = 7.5 / height; // 모델을 약 7.5m 로
      const mesh = new THREE.InstancedMesh(m.geometry, m.materials, list.length);
      list.forEach((t, i) => {
        dummy.position.set(t.x, -bb.min.y * base * t.s, t.z);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.scale.setScalar(base * t.s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      mesh.castShadow = true;
      scene.add(mesh);
    });
  })();

  // ----- 가로등 -----
  let poolMat: THREE.MeshBasicMaterial;
  let haloMat: THREE.PointsMaterial;
  {
    const lamps: Array<{ x: number; z: number; dx: number; dz: number }> = [];
    for (const e of g.edges) {
      if (e.rank > 6 || e.tunnel) continue;
      const n = Math.max(1, Math.round(e.len / 36));
      for (let k = 0; k < n; k++) {
        const p = g.pointAt(e, 1, (e.len * (k + 0.5)) / n);
        const [rx, rz] = rightOf(p.hx, p.hz);
        for (const side of e.rank <= 4 ? [1, -1] : [1]) {
          lamps.push({ x: p.x + rx * side * (e.half + 1.0), z: p.z + rz * side * (e.half + 1.0), dx: -rx * side, dz: -rz * side });
        }
      }
    }
    const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6), new THREE.MeshLambertMaterial({ color: 0x4a4f5a }), lamps.length);
    poolMat = new THREE.MeshBasicMaterial({ map: glowTexture('rgba(255,170,80,0.42)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const poolMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(17, 17).rotateX(-Math.PI / 2), poolMat, lamps.length);
    const haloPos = new Float32Array(lamps.length * 3);
    lamps.forEach((l, i) => {
      dummy.position.set(l.x, 3.75, l.z);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(l.x + l.dx * 3.5, 0.05, l.z + l.dz * 3.5);
      dummy.updateMatrix();
      poolMesh.setMatrixAt(i, dummy.matrix);
      haloPos.set([l.x + l.dx * 1.2, 7.4, l.z + l.dz * 1.2], i * 3);
    });
    poleMesh.castShadow = true;
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
    haloMat = new THREE.PointsMaterial({ size: 7, map: glowTexture('rgba(255,190,110,1)'), color: 0xffb35c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const halos = new THREE.Points(haloGeo, haloMat);
    scene.add(poleMesh, poolMesh, halos);
  }

  let wet = false;
  let night = 1;
  const applyLook = () => {
    const k = night;
    const wetK = wet ? 0.7 : 1;
    mixHex(groundMat, 0x8d9097, 0x2a2d36, k).multiplyScalar(wetK);
    groundMat.roughness = wet ? 0.35 : 0.95;
    mixHex(roadMat, 0x9a9ca3, 0x2c2f38, k).multiplyScalar(wetK);
    roadMat.roughness = wet ? 0.3 : 0.9;
    mixHex(walkMat, 0xb9bcc3, 0x3a3e48, k);
    mixHex(deckMat, 0x8a8d94, 0x2c2f38, k);
    mixHex(parkMat, 0x4f8a4a, 0x15261c, k);
    mixHex(roofMat, 0x8f9298, 0x23262e, k);
    for (const w of allWalls) {
      mixHex(w.mat, 0xffffff, 0x4a4e5a, k);
      w.mat.emissiveIntensity = k;
    }
    mixHex(waterMat, 0x3d7bb5, 0x1a3a66, k);
    waterMat.emissive.setHex(0x0f2a52).multiplyScalar(k);
    poolMat.opacity = k;
    haloMat.opacity = k;
    for (const m of signMats) m.color.setScalar(0.85 + 0.15 * k);
  };
  applyLook();

  return {
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

export { wallRepeat };
