import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import { aptTextures, arrowTexture, billboardTexture, dongTexture, facadeSet, loadMerged, loadTex, signTexture, storefrontTextures, streetSignTexture, type MergedModel } from '../render/assets.ts';
import { glowTexture, windowTexture } from '../render/textures.ts';
import type { Node, RoadGraph } from './graph.ts';
import type { BuildingData, MapIndex, TileData } from './mapdata.ts';
import { pointInRing, type Obstacle } from './collision.ts';
import { rightOf } from './roads.ts';

/** 타일 하나의 도시 메시. 타일이 내려가면 dispose */
export interface TileScene {
  group: THREE.Group;
  obstacles: Obstacle[];
  /** 보행자가 걷는 인도 선분 (큰길 양쪽) */
  walks: Array<{ x0: number; z0: number; x1: number; z1: number }>;
  dispose(): void;
}

export interface City {
  buildTile(key: string, tile: TileData, g: RoadGraph, isSignal: (n: Node) => boolean): TileScene;
  removeTile(key: string): void;
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

export function createCity(scene: THREE.Scene, index: MapIndex): City {
  const dummy = new THREE.Object3D();
  const { minX, maxX, minZ, maxZ } = index.bbox;
  const spanX = maxX - minX + 2400;
  const spanZ = maxZ - minZ + 2400;

  // ----- 전체 공유: 바닥, 재질 -----
  const groundMat = new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, spanX / 10, spanZ / 10), roughness: 0.95, color: 0x8d9097 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(spanX, spanZ), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
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
  const railMat = new THREE.MeshLambertMaterial({ color: 0x23262e, side: THREE.DoubleSide });
  const roadMat = new THREE.MeshStandardMaterial({ map: loadTex('Asphalt033_Color.jpg', true, 1, 1), normalMap: loadTex('Asphalt033_NormalGL.jpg', false, 1, 1), roughness: 0.9, color: 0x9a9ca3 });
  const walkMat = new THREE.MeshStandardMaterial({ map: loadTex('PavingStones151_Color.jpg', true, 4, 1), normalMap: loadTex('PavingStones151_NormalGL.jpg', false, 4, 1), roughness: 0.9, color: 0xb9bcc3 });
  const deckMat = new THREE.MeshStandardMaterial({ map: loadTex('Asphalt033_Color.jpg', true, 1, 1), roughness: 0.9, color: 0x8a8d94 });
  const bridgeRailMat = new THREE.MeshLambertMaterial({ color: 0x8b93a3 });
  const yellowMat = new THREE.MeshLambertMaterial({ color: 0xd9b24a });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xe8ebf2 });
  const barMat = new THREE.MeshLambertMaterial({ color: 0xf0f2f6 });
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
  const arrowMats = {
    straight: new THREE.MeshBasicMaterial({ map: arrowTexture('straight'), transparent: true, depthWrite: false }),
    left: new THREE.MeshBasicMaterial({ map: arrowTexture('left'), transparent: true, depthWrite: false }),
    right: new THREE.MeshBasicMaterial({ map: arrowTexture('right'), transparent: true, depthWrite: false }),
    straightRight: new THREE.MeshBasicMaterial({ map: arrowTexture('straightRight'), transparent: true, depthWrite: false }),
  };
  /** 도로명 표지판 텍스처는 이름마다 하나 (타일을 넘어 공유) */
  const streetSignMats = new Map<string, THREE.MeshBasicMaterial>();
  const streetSignMat = (name: string) => {
    let m = streetSignMats.get(name);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: streetSignTexture(name), side: THREE.DoubleSide });
      streetSignMats.set(name, m);
    }
    return m;
  };

  const windows = (seed: number) => {
    const t = windowTexture(seed);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const stdWall = (set: ReturnType<typeof facadeSet>, seed: number, roughness = 0.75) =>
    new THREE.MeshStandardMaterial({ map: set.map, normalMap: set.normalMap, emissive: 0xffffff, emissiveMap: set.emissiveMap ?? windows(seed), emissiveIntensity: 0, roughness, metalness: 0 });
  const glass1 = stdWall(facadeSet('Facade001', 16, 16, false), 11, 0.35);
  const glass2 = stdWall(facadeSet('Facade005', 12, 12, false), 12, 0.35);
  const office = stdWall(facadeSet('Facade006', 14, 16, false), 13, 0.6);
  const brick1 = stdWall(facadeSet('Facade018A', 12, 14, true), 14);
  const brick2 = stdWall(facadeSet('Facade019A', 12, 14, true), 15);
  const brick3 = stdWall(facadeSet('Facade020A', 12, 14, true), 16);
  const nightOffice = stdWall(facadeSet('Facade013', 16, 18, true), 17, 0.5);
  const aptWalls = [1, 2, 3].map((s) => {
    const t = aptTextures(s);
    t.map.repeat.set(1, 1);
    t.emissive.repeat.set(1, 1);
    return new THREE.MeshStandardMaterial({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.85 });
  });
  const storeWalls = [1, 2, 3, 4].map((s) => {
    const t = storefrontTextures(s);
    return new THREE.MeshStandardMaterial({ map: t.map, emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 0, roughness: 0.5 });
  });
  const towerSet = [glass1, glass2, office, nightOffice];
  const blockSet = [office, brick1, brick2, brick3];
  const lowSet = [brick1, brick2, brick3, office];
  const allWalls = [glass1, glass2, office, brick1, brick2, brick3, nightOffice, ...aptWalls, ...storeWalls];
  const roofMat = new THREE.MeshStandardMaterial({ map: loadTex('Concrete034_Color.jpg', true, 3.3, 3.3), roughness: 0.95, color: 0x8f9298, side: THREE.DoubleSide });
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
  const railGeo = new THREE.BoxGeometry(0.25, 1.0, 3);
  const lampGeo = new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6);
  const poolGeo = new THREE.PlaneGeometry(17, 17).rotateX(-Math.PI / 2);
  const tankGeo = new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10);
  const manholeGeo = new THREE.CircleGeometry(0.4, 12).rotateX(-Math.PI / 2);

  // ----- 나무 모델 (한 번만 로드) -----
  let treeModels: MergedModel[] | null = null;
  const treeWaiters: Array<() => void> = [];
  void (async () => {
    const base = `${import.meta.env.BASE_URL}models/kenney-nature/`;
    const r = mulberry32(5);
    const recolor = (m: THREE.MeshStandardMaterial) => {
      if (/leaf|grass/i.test(m.name)) m.color.setHex([0x4f8f3f, 0x3f7a35, 0x5c9a44][Math.floor(r() * 3)]);
      else if (/bark|wood/i.test(m.name)) m.color.setHex(0x5a4330);
      m.roughness = 0.9;
    };
    const kinds = await Promise.all(['tree_default', 'tree_oak', 'tree_tall', 'tree_simple', 'tree_fat'].map((n) => loadMerged(`${base}${n}.glb`, recolor)));
    treeModels = kinds.filter((k): k is MergedModel => !!k);
    for (const m of treeModels) m.geometry.computeBoundingBox();
    for (const w of treeWaiters) w();
    treeWaiters.length = 0;
  })();

  const tiles = new Map<string, TileScene>();

  function buildTile(key: string, tile: TileData, g: RoadGraph, isSignal: (n: Node) => boolean): TileScene {
    const rand = mulberry32(20261021 + tile.i * 7919 + tile.j * 104729);
    const group = new THREE.Group();
    group.name = `tile:${key}`;
    const obstacles: Obstacle[] = [];
    const walks: TileScene['walks'] = [];
    const disposables: Array<THREE.BufferGeometry> = [];
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

    // ----- 물, 공원, 철도 -----
    {
      const wb = new GeoBuilder();
      for (const ring of tile.water) flatPolygon(wb, ring, 0.04);
      if (!wb.empty) addMesh(wb.build(), waterMat).name = 'water';
      const pb = new GeoBuilder();
      for (const ring of tile.parks) flatPolygon(pb, ring, 0.03);
      if (!pb.empty) addMesh(pb.build(), parkMat);
      const rb = new GeoBuilder();
      for (const pts of tile.rails) ribbon(rb, pts, 2.4, 0.012);
      if (!rb.empty) addMesh(rb.build(), railMat);
    }

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

    // ----- 도로, 인도, 다리 -----
    {
      const rb = new GeoBuilder();
      const sb = new GeoBuilder();
      const bb = new GeoBuilder();
      for (const e of edges) {
        if (e.bridge) ribbon(bb, e.pts, e.half + 0.6, 0.3);
        else {
          ribbon(rb, e.pts, e.half + 0.3, 0.02);
          if (!e.tunnel) ribbon(sb, e.pts, e.half + (e.rank <= 4 ? 4.5 : 2.2), 0.012, 2);
        }
        if (e.rank >= 2 && e.rank <= 4 && !e.bridge && !e.tunnel && !e.link) {
          for (let i = 0; i < e.pts.length - 2; i += 2) {
            const x0 = e.pts[i];
            const z0 = e.pts[i + 1];
            const x1 = e.pts[i + 2];
            const z1 = e.pts[i + 3];
            const l = Math.hypot(x1 - x0, z1 - z0) || 1;
            const nx = -(z1 - z0) / l;
            const nz = (x1 - x0) / l;
            for (const side of [-1, 1]) {
              const off = side * (e.half + 2.4);
              walks.push({ x0: x0 + nx * off, z0: z0 + nz * off, x1: x1 + nx * off, z1: z1 + nz * off });
            }
          }
        }
      }
      if (!sb.empty) addMesh(sb.build(), walkMat);
      if (!rb.empty) addMesh(rb.build(), roadMat);
      if (!bb.empty) addMesh(bb.build(), deckMat);
      const rails: Placement[] = [];
      for (const e of edges) {
        if (!e.bridge) continue;
        for (let s = 1.5; s < e.len; s += 3) {
          const p = g.pointAt(e, 1, s);
          const [rx, rz] = rightOf(p.hx, p.hz);
          for (const side of [-1, 1]) rails.push({ x: p.x + rx * side * (e.half + 0.9), y: 0.8, z: p.z + rz * side * (e.half + 0.9), yaw: Math.atan2(p.hx, p.hz), w: 1, h: 1 });
        }
      }
      addInstanced(railGeo, bridgeRailMat, rails);
    }

    // ----- 차선 표시, 정지선, 횡단보도 -----
    {
      const yellow: Placement[] = [];
      const white: Placement[] = [];
      const bars: Placement[] = [];
      for (const e of edges) {
        if (e.rank > 6 && e.lf + e.lb < 2) continue;
        const twoWay = e.lb > 0;
        if (twoWay) {
          for (let s = 3; s < e.len - 1; s += 6) {
            const p = g.pointAt(e, 1, s);
            yellow.push({ x: p.x, y: 0.035, z: p.z, yaw: Math.atan2(p.hx, p.hz), w: 0.16, h: 1, d: Math.min(6, e.len - s + 2) });
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
            for (const o of offs) white.push({ x: p.x + rx * o, y: 0.035, z: p.z + rz * o, yaw: Math.atan2(p.hx, p.hz), w: 0.15, h: 1, d: 3 });
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
          bars.push({ x: p.x + rx * center, y: 0.036, z: p.z + rz * center, yaw, w: laneSpan - 0.5, h: 1, d: 0.4 });
          const q = g.pointAt(e, dir, Math.max(0, e.len - cut + 0.6));
          for (let o = -e.half + 0.9; o < e.half - 0.3; o += 2.1) bars.push({ x: q.x + rx * o, y: 0.036, z: q.z + rz * o, yaw, w: 1.2, h: 1, d: 2.4 });
        }
      }
      addInstanced(unitPlane, yellowMat, yellow);
      addInstanced(unitPlane, whiteMat, white);
      addInstanced(unitPlane, barMat, bars);

      // 신호 교차로 진입 차선마다 바닥 화살표: 맨 오른쪽 우회전, 맨 왼쪽 좌회전(또는 직진), 가운데 직진
      const arrows: Record<keyof typeof arrowMats, Placement[]> = { straight: [], left: [], right: [], straightRight: [] };
      for (const [n] of tile.nodes) {
        if (!isSignal(n)) continue;
        for (const e of g.edgesAt(n)) {
          const dir = g.dirInto(e, n);
          if (!g.canTravel(e, dir) || e.rank > 4) continue;
          const lanes = g.lanes(e, dir);
          const cut = g.cut(e, n);
          const p = g.pointAt(e, dir, Math.max(0, e.len - cut - 9));
          const [rx, rz] = rightOf(p.hx, p.hz);
          const yaw = Math.atan2(p.hx, p.hz);
          for (let lane = 0; lane < lanes; lane++) {
            const lat = g.laneOffset(e, dir, lane);
            const kind: keyof typeof arrowMats = lanes === 1 ? 'straight' : lane === lanes - 1 ? (lanes >= 3 ? 'right' : 'straightRight') : lane === 0 ? 'left' : 'straight';
            arrows[kind].push({ x: p.x + rx * lat, y: 0.037, z: p.z + rz * lat, yaw, w: 1.0, h: 1, d: 2.5 });
          }
        }
      }
      for (const k of Object.keys(arrows) as Array<keyof typeof arrowMats>) addInstanced(unitPlane, arrowMats[k], arrows[k]);
      // 맨홀: 큰길 60m 마다 하나, 차선 하나에 무작위
      const manholes: Placement[] = [];
      for (const e of edges) {
        if (e.rank > 4 || e.bridge) continue;
        for (let s = 25 + rand() * 20; s < e.len - 10; s += 60) {
          const p = g.pointAt(e, 1, s);
          const [rx, rz] = rightOf(p.hx, p.hz);
          const lat = (rand() - 0.5) * (e.width - 1.5);
          manholes.push({ x: p.x + rx * lat, y: 0.034, z: p.z + rz * lat, yaw: 0, w: 1, h: 1 });
        }
      }
      addInstanced(manholeGeo, manholeMat, manholes);
    }

    // ----- 건물 -----
    const wallBuilders = new Map<THREE.Material, GeoBuilder>();
    const builderFor = (m: THREE.Material) => {
      let b = wallBuilders.get(m);
      if (!b) {
        b = new GeoBuilder();
        wallBuilders.set(m, b);
      }
      return b;
    };
    const roofB = new GeoBuilder();
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
      const wb = builderFor(wall);
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
          wallQuad(builderFor(store), x0, z0, x1, z1, 0, STORE_H, nx, nz, cum / 12, (cum + len) / 12, 0, 1);
          wallQuad(wb, x0, z0, x1, z1, STORE_H, bd.h, nx, nz, u0, u1, STORE_H / vScale + ov, bd.h / vScale + ov);
        } else wallQuad(wb, x0, z0, x1, z1, 0, bd.h, nx, nz, u0, u1, ov, bd.h / vScale + ov);
        cum += len;
        if (len > longestLen) {
          longestLen = len;
          longest = i;
        }
        if (commercial && streetFace && len >= 3.5) {
          const floors = Math.min(4, Math.floor((bd.h - 1) / STORE_H));
          for (let f = 1; f < floors; f++) {
            if (rand() > 0.75) continue;
            const w = Math.min(len - 0.8, 2.6 + rand() * 3.4);
            const along = (rand() - 0.5) * (len - w - 0.4);
            const [rx, rz] = rightOf(nx, nz);
            signLists[Math.floor(rand() * SIGN_VARIANTS)].push({ x: mx + nx * 0.12 + rx * along, y: STORE_H * f + 1.9, z: mz + nz * 0.12 + rz * along, yaw: Math.atan2(nx, nz), w, h: w / 4 });
          }
        }
      }
      flatPolygon(roofB, ring, bd.h, 6);
      if (bd.h > 55) beacons.push({ x: ccx, y: bd.h + 0.6, z: ccz, yaw: 0, w: 1, h: 1 });
      // 옥상 설비: 실외기·물탱크 (평평한 지붕 위, 테두리 안쪽)
      const area = ringAreaAbs(ring);
      if (bd.h > 7 && area > 60 && n <= 12) {
        const [bx0, bx1, bz0, bz1] = ringBounds(ring);
        const count = Math.min(5, Math.floor(area / 120));
        for (let k = 0; k < count; k++) {
          const x = bx0 + 2 + rand() * Math.max(0.1, bx1 - bx0 - 4);
          const z = bz0 + 2 + rand() * Math.max(0.1, bz1 - bz0 - 4);
          if (!pointInRing(ring, x, z)) continue;
          if (isApt || (rand() < 0.3 && bd.h < 30)) tanks.push({ x, y: bd.h + 0.8, z, yaw: 0, w: 1, h: 1 });
          else hvacs.push({ x, y: bd.h + 0.45, z, yaw: rand() * Math.PI, w: 1.2 + rand() * 0.8, h: 0.9, d: 0.7 });
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
        const p: Placement = { x: (x0 + x1) / 2 - nx * 1.2, y: bd.h + 2.2 + w / 5, z: (z0 + z1) / 2 - nz * 1.2, yaw: Math.atan2(nx, nz), w, h: w / 2.5 };
        billLists[Math.floor(rand() * BILL_VARIANTS)].push(p);
        billFrames.push({ x: p.x - nx * 0.4, y: bd.h + 1.1 + w / 5, z: p.z - nz * 0.4, yaw: p.yaw, w: w * 0.9, h: w / 2.5 + 2.2, d: 0.3 });
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
        dongLists[Math.floor(rand() * 12)].push({ x: (x0 + x1) / 2 + nx * 0.1, y: bd.h - s * 0.8, z: (z0 + z1) / 2 + nz * 0.1, yaw: Math.atan2(nx, nz), w: s, h: s });
      }
    }
    for (const bd of tile.buildings) buildBuilding(bd);
    for (const [mat, b] of wallBuilders) if (!b.empty) addMesh(b.build(), mat, true);
    if (!roofB.empty) addMesh(roofB.build(), roofMat);
    addInstanced(beaconGeo, beaconMat, beacons);
    signLists.forEach((list, v) => addInstanced(plane, signMats[v], list));
    billLists.forEach((list, v) => addInstanced(plane, billMats[v], list));
    addInstanced(unitBox, frameMat, billFrames);
    dongLists.forEach((list, v) => addInstanced(plane, dongMats[v], list));
    addInstanced(unitBox, hvacMat, hvacs);
    addInstanced(tankGeo, tankMat, tanks);

    // ----- 버스 정류장 (큰길 인도, 350m 마다) -----
    {
      const shelters: Placement[] = [];
      const glass: Placement[] = [];
      const signs: Placement[] = [];
      for (const e of edges) {
        if (e.rank < 2 || e.rank > 3 || e.bridge || e.tunnel || e.link || e.len < 120) continue;
        for (let s = 90; s < e.len - 40; s += 350) {
          const p = g.pointAt(e, 1, s);
          const [rx, rz] = rightOf(p.hx, p.hz);
          for (const side of e.lb > 0 ? [1, -1] : [1]) {
            const x = p.x + rx * side * (e.half + 2.2);
            const z = p.z + rz * side * (e.half + 2.2);
            if (inBuilding(x, z)) continue;
            const yaw = Math.atan2(p.hx, p.hz);
            shelters.push({ x, y: 2.6, z, yaw, w: 4.2, h: 0.12, d: 1.6 });
            glass.push({ x: x + rx * side * 0.7, y: 1.35, z: z + rz * side * 0.7, yaw, w: 4.0, h: 2.4, d: 0.06 });
            signs.push({ x: x - p.hx * 2.4, y: 2.2, z: z - p.hz * 2.4, yaw: yaw + Math.PI / 2, w: 0.9, h: 0.5, d: 0.08 });
            for (const dx of [-1.9, 1.9]) {
              const px = x + p.hx * dx;
              const pz = z + p.hz * dx;
              obstacles.push({ x: px, z: pz, r: 0.12 });
              shelters.push({ x: px, y: 1.3, z: pz, yaw, w: 0.1, h: 2.6, d: 0.1 });
            }
          }
        }
      }
      addInstanced(unitBox, shelterMat, shelters);
      addInstanced(unitBox, shelterGlassMat, glass);
      addInstanced(unitBox, shelterSignMat, signs);
    }

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
        posts.push({ x, y: 1.6, z, yaw: 0, w: 0.08, h: 3.2, d: 0.08 });
        obstacles.push({ x, z, r: 0.08 });
        // 내 길 이름은 진행 방향과 나란히, 교차하는 길 이름은 그 길 방향으로 위에
        const cross = g.edgesAt(n).find((o) => o.name && o.name !== e.name && o.rank <= 4);
        const names: Array<[string, number, number]> = [[e.name, Math.atan2(p.hx, p.hz) + Math.PI / 2, 2.75]];
        if (cross) {
          const q = g.pointAt(cross, 1, Math.min(cross.len - 0.5, 3));
          names.push([cross.name, Math.atan2(q.hx, q.hz) + Math.PI / 2, 3.25]);
        }
        for (const [name, yaw, y] of names) {
          const list = byName.get(name) ?? [];
          list.push({ x, y, z, yaw, w: 1.8, h: 0.45 });
          byName.set(name, list);
        }
      }
      addInstanced(unitBox, poleMat, posts);
      for (const [name, list] of byName) addInstanced(plane, streetSignMat(name), list);
    }

    // ----- 나무 -----
    const trees: Array<{ x: number; z: number; s: number; park: boolean }> = [];
    for (const e of edges) {
      if (e.rank > 4 || e.rank < 2 || e.bridge || e.tunnel || e.link) continue;
      for (let s = 9; s < e.len - 6; s += 16) {
        const p = g.pointAt(e, 1, s);
        const [rx, rz] = rightOf(p.hx, p.hz);
        for (const side of [1, -1]) {
          const x = p.x + rx * side * (e.half + 2.6);
          const z = p.z + rz * side * (e.half + 2.6);
          if (inBuilding(x, z)) continue;
          const near = g.nearestEdge(x, z, 14);
          if (near && near.d < near.e.half + 1.2) continue;
          trees.push({ x, z, s: 0.85 + rand() * 0.3, park: false });
        }
      }
    }
    for (const ring of tile.parks) {
      const [bx0, bx1, bz0, bz1] = ringBounds(ring);
      const count = Math.min(300, Math.round(ringAreaAbs(ring) / 380));
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
    for (const t of trees) obstacles.push({ x: t.x, z: t.z, r: 0.45 * t.s });
    const placeTrees = () => {
      if (!treeModels?.length || !tiles.has(key)) return;
      const buckets = treeModels.map(() => [] as Array<{ x: number; z: number; s: number }>);
      trees.forEach((t, i) => buckets[(t.park ? i * 7 : i) % treeModels!.length].push(t));
      treeModels.forEach((m, k) => {
        const list = buckets[k];
        if (!list.length) return;
        const bb = m.geometry.boundingBox!;
        const base = 7.5 / (bb.max.y - bb.min.y || 1);
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
        group.add(mesh);
      });
    };
    if (treeModels) placeTrees();
    else treeWaiters.push(placeTrees);

    // ----- 가로등 -----
    {
      const lamps: Array<{ x: number; z: number; dx: number; dz: number }> = [];
      for (const e of edges) {
        if (e.rank > 6 || e.tunnel) continue;
        const n = Math.max(1, Math.round(e.len / 36));
        for (let k = 0; k < n; k++) {
          const p = g.pointAt(e, 1, (e.len * (k + 0.5)) / n);
          const [rx, rz] = rightOf(p.hx, p.hz);
          for (const side of e.rank <= 4 ? [1, -1] : [1]) lamps.push({ x: p.x + rx * side * (e.half + 1.0), z: p.z + rz * side * (e.half + 1.0), dx: -rx * side, dz: -rz * side });
        }
      }
      for (const l of lamps) obstacles.push({ x: l.x, z: l.z, r: 0.18 });
      addInstanced(lampGeo, poleMat, lamps.map((l) => ({ x: l.x, y: 3.75, z: l.z, yaw: 0, w: 1, h: 1 })), undefined, true);
      addInstanced(poolGeo, poolMat, lamps.map((l) => ({ x: l.x + l.dx * 3.5, y: 0.05, z: l.z + l.dz * 3.5, yaw: 0, w: 1, h: 1 })));
      if (lamps.length) {
        const haloPos = new Float32Array(lamps.length * 3);
        lamps.forEach((l, i) => haloPos.set([l.x + l.dx * 1.2, 7.4, l.z + l.dz * 1.2], i * 3));
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
      dispose() {
        scene.remove(group);
        group.traverse((o) => {
          const m = o as THREE.InstancedMesh;
          if (m.isInstancedMesh) m.dispose();
        });
        for (const geo of disposables) geo.dispose();
      },
    };
    tiles.set(key, ts);
    return ts;
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
  };
  applyLook();

  return {
    buildTile,
    removeTile(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      t.dispose();
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
