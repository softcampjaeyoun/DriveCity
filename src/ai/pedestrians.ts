import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import type { PlayerState } from '../vehicle/player.ts';
import type { TileScene } from '../world/city.ts';

/** 큰길 인도를 오가는 보행자. 타일마다 인스턴스 메시 하나 */
export interface Pedestrians {
  addTile(key: string, ts: TileScene): void;
  removeTile(key: string): void;
  update(dt: number, S: PlayerState): void;
  setNight(night: number): void;
}

interface Walker {
  seg: number;
  /** 0..1 선분 위 위치 */
  t: number;
  dir: 1 | -1;
  speed: number;
  phase: number;
  /** 옆으로 비킨 양 (m) */
  dodge: number;
}
interface TilePeds {
  mesh: THREE.InstancedMesh;
  walkers: Walker[];
  walks: TileScene['walks'];
}

const CLOTHES = [0x2b2f3a, 0x8c1d1d, 0x1d4e8c, 0xe8e2d4, 0x3b6b3b, 0x5a3a6b, 0xb8872c, 0x202020, 0xd9d9d9, 0x7a4a2a];

export function createPedestrians(scene: THREE.Scene, density = 1 / 45): Pedestrians {
  // 몸통(캡슐) + 머리. 단순하지만 멀리서 사람으로 읽힌다
  const body = new THREE.CapsuleGeometry(0.22, 0.9, 3, 8).translate(0, 0.95, 0);
  const head = new THREE.SphereGeometry(0.14, 8, 6).translate(0, 1.68, 0);
  const geo = mergeTwo(body, head);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const tiles = new Map<string, TilePeds>();
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
    const an = a.toNonIndexed();
    const bn = b.toNonIndexed();
    const pos = new Float32Array(an.attributes.position.count * 3 + bn.attributes.position.count * 3);
    const nrm = new Float32Array(pos.length);
    pos.set(an.attributes.position.array as Float32Array, 0);
    pos.set(bn.attributes.position.array as Float32Array, an.attributes.position.count * 3);
    nrm.set(an.attributes.normal.array as Float32Array, 0);
    nrm.set(bn.attributes.normal.array as Float32Array, an.attributes.normal.count * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return g;
  }

  return {
    addTile(key, ts) {
      if (tiles.has(key) || !ts.walks.length) return;
      const rand = mulberry32(key.length * 31 + key.charCodeAt(0) * 7 + 11);
      const walkers: Walker[] = [];
      ts.walks.forEach((w, seg) => {
        const len = Math.hypot(w.x1 - w.x0, w.z1 - w.z0);
        const n = Math.floor(len * density + rand());
        for (let k = 0; k < n; k++) walkers.push({ seg, t: rand(), dir: rand() < 0.5 ? 1 : -1, speed: 0.9 + rand() * 0.7, phase: rand() * 10, dodge: 0 });
      });
      if (!walkers.length) return;
      const mesh = new THREE.InstancedMesh(geo, mat, walkers.length);
      walkers.forEach((_, i) => mesh.setColorAt(i, col.setHex(CLOTHES[Math.floor(rand() * CLOTHES.length)])));
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      tiles.set(key, { mesh, walkers, walks: ts.walks });
    },
    removeTile(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      scene.remove(t.mesh);
      t.mesh.dispose();
    },
    update(dt, S) {
      for (const t of tiles.values()) {
        // 멀리 있는 타일의 보행자는 매 프레임 움직일 필요가 없다
        t.walkers.forEach((w, i) => {
          const seg = t.walks[w.seg];
          const len = Math.hypot(seg.x1 - seg.x0, seg.z1 - seg.z0) || 1;
          w.t += (w.dir * w.speed * dt) / len;
          if (w.t > 1) {
            w.t = 1;
            w.dir = -1;
          } else if (w.t < 0) {
            w.t = 0;
            w.dir = 1;
          }
          const x = seg.x0 + (seg.x1 - seg.x0) * w.t;
          const z = seg.z0 + (seg.z1 - seg.z0) * w.t;
          const nx = -(seg.z1 - seg.z0) / len;
          const nz = (seg.x1 - seg.x0) / len;
          // 차가 가까이 오면 인도 안쪽으로 비킨다
          const d = Math.hypot(x - S.x, z - S.z);
          const target = d < 4 ? 1.6 : 0;
          w.dodge += (target - w.dodge) * Math.min(1, dt * 6);
          const px = x + nx * w.dodge;
          const pz = z + nz * w.dodge;
          const bob = Math.abs(Math.sin(w.phase + performance.now() * 0.009 * w.speed)) * 0.05;
          dummy.position.set(px, bob, pz);
          dummy.rotation.set(0, Math.atan2((seg.x1 - seg.x0) * w.dir, (seg.z1 - seg.z0) * w.dir), 0);
          dummy.updateMatrix();
          t.mesh.setMatrixAt(i, dummy.matrix);
        });
        t.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    setNight(night) {
      mat.color.setScalar(1 - night * 0.55);
    },
  };
}
