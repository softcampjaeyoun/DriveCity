import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import { glowTexture, windowTexture } from '../render/textures.ts';
import { LANE_W, type Node, type RoadGraph } from './graph.ts';
import type { MapData } from './mapdata.ts';
import { pointInRing } from './collision.ts';
import { rightOf } from './roads.ts';

export interface City {
  /** 매 프레임 호출. 고층 빌딩 경고등 깜빡임, 물결 */
  update(t: number): void;
  /** 비가 올 때 노면을 젖은 느낌으로 */
  setWet(wet: boolean): void;
}

const NEON = [0xff4fd8, 0x4fd1ff, 0xffe14f, 0x5ce09a, 0xff8a3c, 0xf4f6ff, 0xb45cff];

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

/** 폴리라인을 따라 폭 2*half 의 띠 */
function ribbon(b: GeoBuilder, pts: number[], half: number, y: number): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = pts[i * 2];
    const pz = pts[i * 2 + 1];
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
    const scale = Math.min(1 / Math.max(l, 0.5), 1.6); // 마이터 제한
    nx = (nx / l) * scale;
    nz = (nz / l) * scale;
    left.push(b.vertex(px - nx * half, y, pz - nz * half, 0, 1, 0, 0, i));
    right.push(b.vertex(px + nx * half, y, pz + nz * half, 0, 1, 0, 1, i));
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
function flatPolygon(b: GeoBuilder, ring: number[], y: number): void {
  const contour: THREE.Vector2[] = [];
  for (let i = 0; i < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return;
  }
  const base = b.pos.length / 3;
  for (const p of contour) b.vertex(p.x, y, p.y, 0, 1, 0, p.x / 20, p.y / 20);
  for (const f of faces) b.idx.push(base + f[0], base + f[1], base + f[2]);
}

export function buildCity(scene: THREE.Scene, map: MapData, g: RoadGraph, isSignal: (n: Node) => boolean): City {
  const rand = mulberry32(20261021);
  const dummy = new THREE.Object3D();
  const { minX, maxX, minZ, maxZ } = g.bbox;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  const groundMat = new THREE.MeshPhongMaterial({ color: 0x1b1d24, shininess: 8, specular: 0x111318 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 1200, maxZ - minZ + 1200), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 0, cz);
  scene.add(ground);

  // ----- 물, 공원, 철도 -----
  // 물결: 노이즈 범프맵을 천천히 흘려 달빛·가로등 반사가 일렁이게
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
  const waterMat = new THREE.MeshPhongMaterial({ color: 0x1a3a66, emissive: 0x0f2a52, shininess: 90, specular: 0x8aa8d8, bumpMap: ripple, bumpScale: 0.6 });
  {
    const wb = new GeoBuilder();
    for (const ring of map.water) flatPolygon(wb, ring, 0.04);
    if (!wb.empty) {
      const water = new THREE.Mesh(wb.build(), waterMat);
      water.name = 'water';
      scene.add(water);
    } else console.warn('[city] 물 폴리곤을 삼각분할하지 못했어요');
    const pb = new GeoBuilder();
    for (const ring of map.parks) flatPolygon(pb, ring, 0.03);
    if (!pb.empty) scene.add(new THREE.Mesh(pb.build(), new THREE.MeshLambertMaterial({ color: 0x15261c })));
    const rb = new GeoBuilder();
    for (const pts of map.rails) ribbon(rb, pts, 2.4, 0.012);
    if (!rb.empty) scene.add(new THREE.Mesh(rb.build(), new THREE.MeshLambertMaterial({ color: 0x23262e })));
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

  // ----- 도로 띠, 인도, 다리 -----
  {
    const rb = new GeoBuilder();
    const sb = new GeoBuilder();
    const bb = new GeoBuilder();
    for (const e of g.edges) {
      if (e.bridge) ribbon(bb, e.pts, e.half + 0.6, 0.3);
      else {
        ribbon(rb, e.pts, e.half + 0.3, 0.02);
        if (!e.tunnel) ribbon(sb, e.pts, e.half + (e.rank <= 4 ? 4.5 : 2.2), 0.012);
      }
    }
    const roadMat = new THREE.MeshPhongMaterial({ color: 0x15171e, shininess: 10, specular: 0x14161c });
    scene.add(new THREE.Mesh(sb.build(), new THREE.MeshLambertMaterial({ color: 0x262a35 })));
    scene.add(new THREE.Mesh(rb.build(), roadMat));
    if (!bb.empty) scene.add(new THREE.Mesh(bb.build(), new THREE.MeshLambertMaterial({ color: 0x1c1f28 })));
    // 다리 난간
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
      const rm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 1.0, 3), new THREE.MeshLambertMaterial({ color: 0x5b6475 }), rails.length);
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
    const yellow: Array<[number, number, number, number]> = []; // x z yaw len
    const white: Array<[number, number, number]> = [];
    const bars: Array<[number, number, number, number, number]> = []; // x z yaw w d
    for (const e of g.edges) {
      if (e.rank > 6 && e.lf + e.lb < 2) continue;
      const twoWay = e.lb > 0;
      // 중앙선
      if (twoWay) {
        for (let s = 3; s < e.len - 1; s += 6) {
          const p = g.pointAt(e, 1, s);
          yellow.push([p.x, p.z, Math.atan2(p.hx, p.hz), Math.min(6, e.len - s + 2)]);
        }
      }
      // 차선 사이 점선
      const offs: number[] = [];
      if (twoWay) {
        for (let i = 1; i < e.lf; i++) offs.push(i * LANE_W);
        for (let i = 1; i < e.lb; i++) offs.push(-i * LANE_W);
      } else for (let i = 1; i < e.lf; i++) offs.push((i - e.lf / 2) * LANE_W);
      if (offs.length) {
        for (let s = 2; s < e.len - 2; s += 7) {
          const p = g.pointAt(e, 1, s);
          const [rx, rz] = rightOf(p.hx, p.hz);
          for (const o of offs) white.push([p.x + rx * o, p.z + rz * o, Math.atan2(p.hx, p.hz)]);
        }
      }
    }
    // 신호 교차로 진입부: 정지선과 횡단보도
    for (let n = 0; n < g.nodes.length; n++) {
      if (!isSignal(n)) continue;
      for (const e of g.edgesAt(n)) {
        const dir = g.dirInto(e, n);
        if (!g.canTravel(e, dir)) continue;
        const cut = g.cut(e, n);
        const lanes = g.lanes(e, dir);
        const laneSpan = lanes * LANE_W;
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
    const ym = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0x9c7f3c }), yellow.length);
    yellow.forEach(([x, z, yaw, len], i) => place(ym, i, x, z, yaw, 0.16, len, 0.035));
    const wm = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0x8e95a8 }), white.length);
    white.forEach(([x, z, yaw], i) => place(wm, i, x, z, yaw, 0.15, 3, 0.035));
    const bm = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0xb8bfd0 }), bars.length);
    bars.forEach(([x, z, yaw, w, d], i) => place(bm, i, x, z, yaw, w, d, 0.036));
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    scene.add(ym, wm, bm);
  }

  // ----- 건물 -----
  const warmMats = [1, 2, 3].map((s) => new THREE.MeshLambertMaterial({ color: 0x1b1f2b, emissive: 0xffffff, emissiveMap: windowTexture(s * 97) }));
  const coolMats = [4, 5].map((s) => new THREE.MeshLambertMaterial({ color: 0x151a26, emissive: 0xffffff, emissiveMap: windowTexture(s * 131, 0.3) }));
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x15171f, side: THREE.DoubleSide });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3040 });
  const signs: Array<{ x: number; y: number; z: number; w: number; h: number; rot: number; color: number }> = [];
  const beacons: Array<[number, number, number]> = [];
  {
    const wallB = [...warmMats, ...coolMats].map(() => new GeoBuilder());
    const roofB = new GeoBuilder();
    for (const bd of map.buildings) {
      const ring = bd.ring;
      const n = ring.length / 2;
      const [ccx, ccz] = ringCentroid(ring);
      const matIdx = bd.kind === 'tower' ? 3 + Math.floor(rand() * 2) : Math.floor(rand() * 3);
      const b = wallB[matIdx];
      const ou = Math.floor(rand() * 8) / 8;
      const ov = Math.floor(rand() * 16) / 16;
      let cum = 0;
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
        const u0 = cum / 32 + ou;
        const u1 = (cum + len) / 32 + ou;
        const v1 = bd.h / 48 + ov;
        const a = b.vertex(x0, 0, z0, nx, 0, nz, u0, ov);
        const c = b.vertex(x1, 0, z1, nx, 0, nz, u1, ov);
        const d = b.vertex(x1, bd.h, z1, nx, 0, nz, u1, v1);
        const e = b.vertex(x0, bd.h, z0, nx, 0, nz, u0, v1);
        // 바깥쪽 법선을 기준으로 앞면이 되도록 정점 순서를 맞춘다
        const cross = (x1 - x0) * nz - (z1 - z0) * nx;
        if (cross > 0) b.quad(a, c, d, e);
        else b.quad(c, a, e, d);
        cum += len;
        if (bd.kind !== 'tower' && bd.h < 24 && len >= 4 && rand() < 0.35 && signs.length < 5000 && g.nearestEdge((x0 + x1) / 2 + nx * 3, (z0 + z1) / 2 + nz * 3, 14)) {
          signs.push({
            x: (x0 + x1) / 2 + nx * 0.08,
            y: Math.min(bd.h - 0.8, 2.6 + rand() * 3),
            z: (z0 + z1) / 2 + nz * 0.08,
            w: Math.min(len - 1, 1.2 + rand() * 2.2),
            h: 0.55 + rand() * 0.4,
            rot: Math.atan2(nx, nz),
            color: NEON[Math.floor(rand() * NEON.length)],
          });
        }
      }
      flatPolygon(roofB, ring, bd.h);
      if (bd.h > 55) beacons.push([ccx, bd.h + 0.6, ccz]);
    }
    wallB.forEach((b, i) => {
      if (b.empty) return;
      scene.add(new THREE.Mesh(b.build(), i < 3 ? warmMats[i] : coolMats[i - 3]));
    });
    if (!roofB.empty) scene.add(new THREE.Mesh(roofB.build(), roofMat));
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
  if (signs.length) {
    const signMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), signs.length);
    const col = new THREE.Color();
    signs.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.w, s.h, 1);
      dummy.updateMatrix();
      signMesh.setMatrixAt(i, dummy.matrix);
      signMesh.setColorAt(i, col.setHex(s.color).multiplyScalar(0.72));
    });
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    scene.add(signMesh);
  }

  // ----- 공원 나무, 큰길 가로수 -----
  {
    const trees: Array<[number, number, number]> = [];
    for (const e of g.edges) {
      if (e.rank > 4 || e.rank < 2 || e.bridge || e.tunnel || e.link) continue;
      for (let s = 9; s < e.len - 6; s += 18) {
        const p = g.pointAt(e, 1, s);
        const [rx, rz] = rightOf(p.hx, p.hz);
        for (const side of [1, -1]) {
          const x = p.x + rx * side * (e.half + 2.6);
          const z = p.z + rz * side * (e.half + 2.6);
          if (inBuilding(x, z) || g.nearestEdge(x, z, 2.2)) continue;
          trees.push([x, z, 0.65 + rand() * 0.3]);
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
        if (!pointInRing(ring, x, z)) continue;
        if (g.nearestEdge(x, z, 9)) continue; // 길 위는 피한다
        trees.push([x, z, 0.8 + rand() * 0.7]);
        placed++;
      }
    }
    if (trees.length) {
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.3, 2, 6), new THREE.MeshLambertMaterial({ color: 0x2b2018 }), trees.length);
      const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.9, 4.5, 7), new THREE.MeshLambertMaterial({ color: 0x1d3a26 }), trees.length);
      trees.forEach(([x, z, s], i) => {
        dummy.scale.set(s, s, s);
        dummy.position.set(x, 1.25 * s, z);
        dummy.updateMatrix();
        trunk.setMatrixAt(i, dummy.matrix);
        dummy.position.set(x, 4 * s, z);
        dummy.updateMatrix();
        crown.setMatrixAt(i, dummy.matrix);
      });
      dummy.scale.set(1, 1, 1);
      scene.add(trunk, crown);
    }
  }

  // ----- 가로등 -----
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
    const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6), new THREE.MeshLambertMaterial({ color: 0x30343f }), lamps.length);
    const poolMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(17, 17).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowTexture('rgba(255,170,80,0.42)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      lamps.length,
    );
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
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
    const halos = new THREE.Points(
      haloGeo,
      new THREE.PointsMaterial({ size: 7, map: glowTexture('rgba(255,190,110,1)'), color: 0xffb35c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    scene.add(poleMesh, poolMesh, halos);
  }

  return {
    update(t) {
      beaconMat.color.setHex(Math.sin(t * 3) > 0 ? 0xff3040 : 0x330408);
      ripple.offset.set(t * 0.012, t * 0.008);
    },
    setWet(wet) {
      groundMat.shininess = wet ? 70 : 8;
      groundMat.specular.setHex(wet ? 0x4a5670 : 0x111318);
      groundMat.color.setHex(wet ? 0x13151b : 0x1b1d24);
    },
  };
}
