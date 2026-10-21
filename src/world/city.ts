import * as THREE from 'three';
import { DIRS, EDGE, LANES, ROAD, backOf } from '../config.ts';
import { mulberry32 } from '../util/math.ts';
import { glowTexture, windowTexture } from '../render/textures.ts';
import type { Block, RoadGraph } from './graph.ts';
import { rightOf } from './roads.ts';

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 물이면 빠졌을 때 리셋한다 */
  water?: boolean;
}

export interface City {
  colliders: Box[];
  /** 매 프레임 호출. 고층 빌딩 경고등 깜빡임, 물결 */
  update(t: number): void;
  /** 비가 올 때 노면을 젖은 느낌으로 */
  setWet(wet: boolean): void;
}

const NEON = [0xff4fd8, 0x4fd1ff, 0xffe14f, 0x5ce09a, 0xff8a3c, 0xf4f6ff, 0xb45cff];

export function buildCity(scene: THREE.Scene, g: RoadGraph): City {
  const rand = mulberry32(20261021);
  const colliders: Box[] = [];
  const dummy = new THREE.Object3D();
  const spanX = g.maxX - g.minX + 800;
  const spanZ = g.maxZ - g.minZ + 800;

  const groundMat = new THREE.MeshPhongMaterial({ color: 0x14161d, shininess: 8, specular: 0x111318 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(spanX, spanZ), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // ----- 한강과 다리 -----
  const river = g.river;
  const waterMat = new THREE.MeshPhongMaterial({ color: 0x0a1930, shininess: 120, specular: 0x3a5a8a });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(spanX, river.z1 - river.z0), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set((g.minX + g.maxX) / 2, 0.03, (river.z0 + river.z1) / 2);
  scene.add(water);
  const railMat = new THREE.MeshLambertMaterial({ color: 0x5b6475 });
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x1a1d26 });
  for (let i = 0; i < g.nx; i++) {
    const x = g.xs[i];
    if (g.bridges.includes(i)) {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(ROAD + 2, 0.5, river.z1 - river.z0 + 2), deckMat);
      deck.position.set(x, 0.3, (river.z0 + river.z1) / 2);
      scene.add(deck);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.1, river.z1 - river.z0 + 2), railMat);
        rail.position.set(x + side * (EDGE + 0.8), 1.05, (river.z0 + river.z1) / 2);
        scene.add(rail);
        colliders.push({ minX: rail.position.x - 0.2, maxX: rail.position.x + 0.2, minZ: river.z0 - 1, maxZ: river.z1 + 1 });
      }
    } else {
      // 다리가 없는 열의 도로 자리는 물
      colliders.push({ minX: x - EDGE, maxX: x + EDGE, minZ: river.z0, maxZ: river.z1, water: true });
    }
  }
  colliders.push({ minX: g.minX - 400, maxX: g.minX, minZ: river.z0, maxZ: river.z1, water: true });
  colliders.push({ minX: g.maxX, maxX: g.maxX + 400, minZ: river.z0, maxZ: river.z1, water: true });

  // ----- 빌딩 -----
  const warmMats = [1, 2, 3].map(
    (s) => new THREE.MeshLambertMaterial({ color: 0x1b1f2b, emissive: 0xffffff, emissiveMap: windowTexture(s * 97) }),
  );
  const coolMats = [4, 5].map(
    (s) => new THREE.MeshLambertMaterial({ color: 0x151a26, emissive: 0xffffff, emissiveMap: windowTexture(s * 131, 0.3) }),
  );
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x15171f });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3040 });
  const beaconGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const signs: Array<{ x: number; y: number; z: number; w: number; h: number; rot: number; color: number }> = [];

  function addBuilding(cx: number, cz: number, w: number, d: number, h: number, cool: boolean): void {
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const ou = Math.floor(rand() * 8) / 8;
    const ov = Math.floor(rand() * 16) / 16;
    for (let f = 0; f < 6; f++) {
      if (f === 2 || f === 3) continue;
      const fw = f < 2 ? d : w;
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, (uv.getX(i) * fw) / 32 + ou, (uv.getY(i) * h) / 48 + ov);
      }
    }
    const pool = cool ? coolMats : warmMats;
    const side = pool[Math.floor(rand() * pool.length)];
    const mesh = new THREE.Mesh(geo, [side, side, roofMat, roofMat, side, side]);
    mesh.position.set(cx, h / 2 + 0.25, cz);
    scene.add(mesh);
    colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
    if (h > 55) {
      const b = new THREE.Mesh(beaconGeo, beaconMat);
      b.position.set(cx, h + 0.65, cz);
      scene.add(b);
    }
  }

  /** 도로를 향한 면에 네온 간판 */
  function addSigns(cx: number, cz: number, w: number, d: number, h: number, faces: number[]): void {
    for (const f of faces) {
      const count = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < count; k++) {
        const sw = 1.5 + rand() * 3;
        const sh = 0.7 + rand() * 0.6;
        const y = 2.5 + rand() * Math.max(1, h - 5);
        const along = (rand() - 0.5) * ((f % 2 === 0 ? w : d) - sw - 1);
        const [dx, dz] = DIRS[f];
        const [rx, rz] = rightOf(f);
        signs.push({
          x: cx + dx * (f % 2 === 0 ? d / 2 + 0.06 : w / 2 + 0.06) + rx * along,
          y,
          z: cz + dz * (f % 2 === 0 ? d / 2 + 0.06 : w / 2 + 0.06) + rz * along,
          w: sw,
          h: sh,
          rot: Math.atan2(dx, dz),
          color: NEON[Math.floor(rand() * NEON.length)],
        });
      }
    }
  }

  const walkGeo = new THREE.BoxGeometry(1, 0.25, 1);
  const walkMat = new THREE.MeshLambertMaterial({ color: 0x252833 });
  const parkMat = new THREE.MeshLambertMaterial({ color: 0x15261c });
  const trees: Array<[number, number, number]> = [];
  const landBlocks = g.blocks.filter((b) => b.district !== 'water');
  const walkMesh = new THREE.InstancedMesh(walkGeo, walkMat, landBlocks.length);
  landBlocks.forEach((b, idx) => {
    dummy.position.set(b.x0 + b.w / 2, 0.125, b.z0 + b.d / 2);
    dummy.scale.set(b.w, 1, b.d);
    dummy.updateMatrix();
    walkMesh.setMatrixAt(idx, dummy.matrix);
  });
  dummy.scale.set(1, 1, 1);
  scene.add(walkMesh);

  function fillBlock(b: Block): void {
    const cx = b.x0 + b.w / 2;
    const cz = b.z0 + b.d / 2;
    if (b.district === 'park') {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(b.w - 4, b.d - 4), parkMat);
      p.rotation.x = -Math.PI / 2;
      p.position.set(cx, 0.26, cz);
      scene.add(p);
      const count = Math.round((b.w * b.d) / 320);
      for (let t = 0; t < count; t++) {
        const tx = b.x0 + 5 + rand() * (b.w - 10);
        const tz = b.z0 + 5 + rand() * (b.d - 10);
        trees.push([tx, tz, 0.8 + rand() * 0.6]);
        colliders.push({ minX: tx - 0.4, maxX: tx + 0.4, minZ: tz - 0.4, maxZ: tz + 0.4 });
      }
      return;
    }
    if (b.district === 'cbd') {
      // 고층 타워 1~2동, 넓은 블록은 둘로
      const towers = b.w > 62 && rand() < 0.6 ? 2 : 1;
      for (let k = 0; k < towers; k++) {
        const w = towers === 2 ? b.w / 2 - 8 : Math.min(b.w, b.d) * (0.55 + rand() * 0.2);
        const d = Math.min(b.d - 10, towers === 2 ? b.d * 0.7 : w);
        const x = towers === 2 ? b.x0 + 4 + w / 2 + k * (b.w / 2 + 2) : cx;
        addBuilding(x, cz, w, d, 60 + rand() * 70, true);
      }
      return;
    }
    if (b.district === 'old') {
      // 작은 건물이 빼곡한 구도심. 도로 쪽 면에 네온 간판
      const cols = Math.max(2, Math.floor(b.w / 13));
      const rows = Math.max(2, Math.floor(b.d / 13));
      const lw = (b.w - 3) / cols;
      const ld = (b.d - 3) / rows;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const edgeLot = c === 0 || c === cols - 1 || r === 0 || r === rows - 1;
          if (!edgeLot && rand() < 0.35) continue;
          const w = lw - 1.6 - rand() * 2;
          const d = ld - 1.6 - rand() * 2;
          const h = 7 + rand() * 16;
          const x = b.x0 + 1.5 + c * lw + lw / 2;
          const z = b.z0 + 1.5 + r * ld + ld / 2;
          addBuilding(x, z, w, d, h, false);
          const faces: number[] = [];
          if (r === 0) faces.push(2);
          if (r === rows - 1) faces.push(0);
          if (c === 0) faces.push(3);
          if (c === cols - 1) faces.push(1);
          if (faces.length) addSigns(x, z, w, d, h, faces);
        }
      }
      return;
    }
    // mixed: 2×2 필지
    const lotW = (b.w - 6) / 2;
    const lotD = (b.d - 6) / 2;
    for (let lx = 0; lx < 2; lx++) {
      for (let lz = 0; lz < 2; lz++) {
        if (rand() < 0.12) continue;
        const w = lotW - 2 - rand() * 6;
        const d = lotD - 2 - rand() * 6;
        const h = 10 + Math.pow(rand(), 2) * 62;
        addBuilding(b.x0 + 3 + lx * lotW + lotW / 2, b.z0 + 3 + lz * lotD + lotD / 2, w, d, h, rand() < 0.4);
      }
    }
  }
  for (const b of landBlocks) fillBlock(b);

  if (trees.length) {
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.25, 0.3, 2, 6),
      new THREE.MeshLambertMaterial({ color: 0x2b2018 }),
      trees.length,
    );
    const crown = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.9, 4.5, 7),
      new THREE.MeshLambertMaterial({ color: 0x1d3a26 }),
      trees.length,
    );
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

  if (signs.length) {
    const signMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), signs.length);
    const col = new THREE.Color();
    signs.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.w, s.h, 1);
      dummy.updateMatrix();
      signMesh.setMatrixAt(i, dummy.matrix);
      signMesh.setColorAt(i, col.setHex(s.color));
    });
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    scene.add(signMesh);
  }

  // ----- 차선 표시: 중앙 황색 실선 2줄, 차선 사이 백색 점선, 정지선·횡단보도 -----
  const yellowLines: Array<[number, number, number, number]> = []; // x, z, 길이, 방향
  const whiteDashes: Array<[number, number, number]> = [];
  const bars: Array<[number, number, number, number, number]> = []; // x, z, 폭, 깊이, 방향
  const laneDiv = (LANES[0] + LANES[1]) / 2;
  for (let i = 0; i < g.nx; i++) {
    for (let j = 0; j < g.nz; j++) {
      for (const d of [0, 1]) {
        if (!g.hasEdge(i, j, d)) continue;
        const seg = { from: [i, j] as const, d };
        const [ax, az] = g.pos([seg.from[0], seg.from[1]]);
        const [dx, dz] = DIRS[d];
        const [rx, rz] = rightOf(d);
        const len = g.edgeLen(i, j, d) - 2 * EDGE;
        const mx = ax + dx * (EDGE + len / 2);
        const mz = az + dz * (EDGE + len / 2);
        for (const o of [-0.22, 0.22]) yellowLines.push([mx + rx * o, mz + rz * o, len, d]);
        for (let s = 3; s < len - 1.5; s += 6) {
          for (const o of [laneDiv, -laneDiv]) whiteDashes.push([ax + dx * (EDGE + s) + rx * o, az + dz * (EDGE + s) + rz * o, d]);
        }
      }
      // 교차로 진입부 정지선과 횡단보도 (들어오는 방향 d 기준, 오른쪽 절반)
      if (g.degree(i, j) < 3) continue;
      const [nx, nz] = g.pos([i, j]);
      for (let d = 0; d < 4; d++) {
        if (!g.hasEdge(i, j, backOf(d))) continue;
        const [dx, dz] = DIRS[d];
        const [rx, rz] = rightOf(d);
        bars.push([nx - dx * (EDGE + 4.6) + rx * (EDGE / 2), nz - dz * (EDGE + 4.6) + rz * (EDGE / 2), EDGE - 0.6, 0.4, d]);
        for (let k = 0; k < 8; k++) {
          const o = -EDGE + 1.6 + k * 2.1;
          bars.push([nx - dx * (EDGE + 2.2) + rx * o, nz - dz * (EDGE + 2.2) + rz * o, 1.2, 2.6, d]);
        }
      }
    }
  }
  const unit = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const yellowMesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0x9c7f3c }), yellowLines.length);
  yellowLines.forEach(([x, z, len, d], i) => {
    dummy.position.set(x, 0.015, z);
    dummy.rotation.set(0, d % 2 ? Math.PI / 2 : 0, 0);
    dummy.scale.set(0.14, 1, len);
    dummy.updateMatrix();
    yellowMesh.setMatrixAt(i, dummy.matrix);
  });
  const whiteMesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0x8e95a8 }), whiteDashes.length);
  whiteDashes.forEach(([x, z, d], i) => {
    dummy.position.set(x, 0.015, z);
    dummy.rotation.set(0, d % 2 ? Math.PI / 2 : 0, 0);
    dummy.scale.set(0.16, 1, 3);
    dummy.updateMatrix();
    whiteMesh.setMatrixAt(i, dummy.matrix);
  });
  const barMesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0xb8bfd0 }), bars.length);
  bars.forEach(([x, z, w, dd, d], i) => {
    dummy.position.set(x, 0.016, z);
    dummy.rotation.set(0, d % 2 ? Math.PI / 2 : 0, 0);
    dummy.scale.set(w, 1, dd);
    dummy.updateMatrix();
    barMesh.setMatrixAt(i, dummy.matrix);
  });
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
  scene.add(yellowMesh, whiteMesh, barMesh);

  // ----- 가로등: 도로 양쪽 35m 마다 -----
  const lamps: Array<{ x: number; z: number; dx: number; dz: number }> = [];
  for (let i = 0; i < g.nx; i++) {
    for (let j = 0; j < g.nz; j++) {
      for (const d of [0, 1]) {
        if (!g.hasEdge(i, j, d)) continue;
        const [ax, az] = g.pos([i, j]);
        const [dx, dz] = DIRS[d];
        const [rx, rz] = rightOf(d);
        const len = g.edgeLen(i, j, d) - 2 * EDGE;
        const n = Math.max(1, Math.round(len / 35));
        for (let k = 0; k < n; k++) {
          const s = EDGE + (len * (k + 0.5)) / n;
          for (const side of [1, -1]) {
            lamps.push({ x: ax + dx * s + rx * side * (EDGE + 0.6), z: az + dz * s + rz * side * (EDGE + 0.6), dx: -rx * side, dz: -rz * side });
          }
        }
      }
    }
  }
  const poleMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6),
    new THREE.MeshLambertMaterial({ color: 0x30343f }),
    lamps.length,
  );
  const poolMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(17, 17).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: glowTexture('rgba(255,170,80,0.42)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    lamps.length,
  );
  const haloPos = new Float32Array(lamps.length * 3);
  lamps.forEach((l, i) => {
    dummy.position.set(l.x, 3.75, l.z);
    dummy.updateMatrix();
    poleMesh.setMatrixAt(i, dummy.matrix);
    dummy.position.set(l.x + l.dx * 3.5, 0.03, l.z + l.dz * 3.5);
    dummy.updateMatrix();
    poolMesh.setMatrixAt(i, dummy.matrix);
    haloPos.set([l.x + l.dx * 1.2, 7.4, l.z + l.dz * 1.2], i * 3);
  });
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
  const halos = new THREE.Points(
    haloGeo,
    new THREE.PointsMaterial({
      size: 7,
      map: glowTexture('rgba(255,190,110,1)'),
      color: 0xffb35c,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(poleMesh, poolMesh, halos);

  return {
    colliders,
    update(t) {
      beaconMat.color.setHex(Math.sin(t * 3) > 0 ? 0xff3040 : 0x330408);
      waterMat.specular.setScalar(0.2 + Math.sin(t * 0.7) * 0.06);
    },
    setWet(wet) {
      groundMat.shininess = wet ? 70 : 8;
      groundMat.specular.setHex(wet ? 0x4a5670 : 0x111318);
      groundMat.color.setHex(wet ? 0x0f1118 : 0x14161d);
    },
  };
}
