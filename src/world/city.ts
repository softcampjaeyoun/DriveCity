import * as THREE from 'three';
import { BLOCK, CELL, HALF, N, ROAD, roadAt } from '../config.ts';
import { mulberry32 } from '../util/math.ts';
import { glowTexture, windowTexture } from '../render/textures.ts';

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface City {
  colliders: Box[];
  parks: Array<{ x0: number; z0: number }>;
  /** 매 프레임 호출. 고층 빌딩 경고등 깜빡임 */
  update(t: number): void;
}

export function buildCity(scene: THREE.Scene): City {
  const rand = mulberry32(20261021);
  const colliders: Box[] = [];
  const parks: Array<{ x0: number; z0: number }> = [];
  const dummy = new THREE.Object3D();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(N * CELL + 600, N * CELL + 600),
    new THREE.MeshLambertMaterial({ color: 0x14161d }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // ----- 빌딩 -----
  const sideMats = [1, 2, 3].map(
    (s) => new THREE.MeshLambertMaterial({ color: 0x1b1f2b, emissive: 0xffffff, emissiveMap: windowTexture(s * 97) }),
  );
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x15171f });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3040 });
  const beaconGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);

  function addBuilding(cx: number, cz: number, w: number, d: number, h: number): void {
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const ou = Math.floor(rand() * 8) / 8;
    const ov = Math.floor(rand() * 16) / 16;
    for (let f = 0; f < 6; f++) {
      if (f === 2 || f === 3) continue; // 지붕, 바닥
      const fw = f < 2 ? d : w;
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, (uv.getX(i) * fw) / 32 + ou, (uv.getY(i) * h) / 48 + ov);
      }
    }
    const side = sideMats[Math.floor(rand() * sideMats.length)];
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

  // ----- 블록 (인도, 공원, 빌딩 배치) -----
  const walkMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(BLOCK, 0.25, BLOCK),
    new THREE.MeshLambertMaterial({ color: 0x252833 }),
    N * N,
  );
  const parkMat = new THREE.MeshLambertMaterial({ color: 0x15261c });
  const trees: Array<[number, number, number]> = [];

  let wi = 0;
  for (let bx = 0; bx < N; bx++) {
    for (let bz = 0; bz < N; bz++) {
      const x0 = roadAt(bx) + ROAD / 2;
      const z0 = roadAt(bz) + ROAD / 2;
      const cx = x0 + BLOCK / 2;
      const cz = z0 + BLOCK / 2;
      dummy.position.set(cx, 0.125, cz);
      dummy.updateMatrix();
      walkMesh.setMatrixAt(wi++, dummy.matrix);

      const roll = rand();
      if (roll < 0.1 && !(Math.abs(cx) < CELL && Math.abs(cz) < CELL)) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(BLOCK - 4, BLOCK - 4), parkMat);
        p.rotation.x = -Math.PI / 2;
        p.position.set(cx, 0.26, cz);
        scene.add(p);
        parks.push({ x0, z0 });
        for (let t = 0; t < 9; t++) {
          const tx = x0 + 6 + rand() * (BLOCK - 12);
          const tz = z0 + 6 + rand() * (BLOCK - 12);
          trees.push([tx, tz, 0.8 + rand() * 0.6]);
          colliders.push({ minX: tx - 0.4, maxX: tx + 0.4, minZ: tz - 0.4, maxZ: tz + 0.4 });
        }
      } else if (roll < 0.3) {
        addBuilding(cx, cz, BLOCK - 8 - rand() * 6, BLOCK - 8 - rand() * 6, 50 + rand() * 60);
      } else {
        const lot = (BLOCK - 6) / 2;
        for (let lx = 0; lx < 2; lx++) {
          for (let lz = 0; lz < 2; lz++) {
            if (rand() < 0.12) continue;
            const w = lot - 2 - rand() * 6;
            const d = lot - 2 - rand() * 6;
            const h = 10 + Math.pow(rand(), 2) * 62;
            addBuilding(x0 + 3 + lx * lot + lot / 2, z0 + 3 + lz * lot + lot / 2, w, d, h);
          }
        }
      }
    }
  }
  scene.add(walkMesh);

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

  // ----- 차선 점선 -----
  const dashes: Array<[number, number, boolean]> = [];
  for (let i = 0; i <= N; i++) {
    const c = roadAt(i);
    for (let t = -HALF - ROAD / 2; t < HALF + ROAD / 2; t += 6) {
      const local = (((t + HALF) % CELL) + CELL) % CELL;
      if (local < ROAD / 2 + 2 || local > CELL - ROAD / 2 - 2) continue;
      dashes.push([c, t, false], [t, c, true]);
    }
  }
  const dashMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.28, 3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x9c7f3c }),
    dashes.length,
  );
  dashes.forEach(([x, z, horiz], i) => {
    dummy.position.set(x, 0.015, z);
    dummy.rotation.set(0, horiz ? Math.PI / 2 : 0, 0);
    dummy.updateMatrix();
    dashMesh.setMatrixAt(i, dummy.matrix);
  });
  dummy.rotation.set(0, 0, 0);
  scene.add(dashMesh);

  // ----- 가로등: 기둥, 빛 번짐, 바닥 조명 -----
  const lamps: Array<{ x: number; z: number; dx: number; dz: number }> = [];
  for (let i = 0; i <= N; i++) {
    const c = roadAt(i);
    for (let j = 0; j < N; j++) {
      for (const [frac, side] of [
        [0.3, 1],
        [0.7, -1],
      ] as const) {
        const m = roadAt(j) + CELL * frac;
        lamps.push({ x: c + side * (ROAD / 2 + 0.6), z: m, dx: -side, dz: 0 });
        lamps.push({ x: m, z: c + side * (ROAD / 2 + 0.6), dx: 0, dz: -side });
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
    parks,
    update(t) {
      beaconMat.color.setHex(Math.sin(t * 3) > 0 ? 0xff3040 : 0x330408);
    },
  };
}
