import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import type { PlayerState } from '../vehicle/player.ts';
import type { TileScene } from '../world/city.ts';

/** 큰길 인도를 오가는 보행자. 머리·머리카락·몸통·팔·다리를 부위별 인스턴스로 그려 걷는 동작과 체형 차이를 낸다 */
export interface Pedestrians {
  addTile(key: string, ts: TileScene): void;
  removeTile(key: string): void;
  update(dt: number, S: PlayerState): void;
  setNight(night: number): void;
}

type Kind = 'man' | 'woman' | 'boy' | 'girl' | 'elder_m' | 'elder_f';

interface Walker {
  seg: number;
  /** 0..1 선분 위 위치 */
  t: number;
  dir: 1 | -1;
  speed: number;
  phase: number;
  /** 인도 안쪽으로 비킨 양 (m) */
  dodge: number;
  /** 몸 비율 */
  height: number;
  shoulder: number;
  hair: number; // 0 없음(모자/짧음) .. 1 긴 머리
  stoop: number; // 노인 구부정
  skirt: boolean;
  bag: boolean;
}
interface TilePeds {
  parts: Record<Part, THREE.InstancedMesh>;
  walkers: Walker[];
  walks: TileScene['walks'];
}
type Part = 'head' | 'hair' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'bag';
const PARTS: Part[] = ['head', 'hair', 'torso', 'armL', 'armR', 'legL', 'legR', 'bag'];

const SKIN = [0xf1c9a5, 0xe8b894, 0xd9a07a, 0xf5d6b8];
const HAIR = [0x1a1512, 0x2b1d14, 0x4a3524, 0x6b4a2e, 0x8a8a8a, 0xd8d0c4];
const TOPS = [0x2b2f3a, 0x8c1d1d, 0x1d4e8c, 0xe8e2d4, 0x3b6b3b, 0x5a3a6b, 0xb8872c, 0x202020, 0xd9d9d9, 0x7a4a2a, 0xf0a0b8, 0x4aa3df, 0xffffff, 0x3a3a52];
const BOTTOMS = [0x1f2a44, 0x2a2a2a, 0x5a5f6b, 0x3b3b3b, 0x8a7a66, 0x1a3a6b, 0x6b2a2a, 0x2f4a3a];

export function createPedestrians(scene: THREE.Scene, density = 1 / 40): Pedestrians {
  // 단위 부위 지오메트리. 원점이 각 부위의 붙는 지점이라 회전이 자연스럽다
  const geo: Record<Part, THREE.BufferGeometry> = {
    head: new THREE.SphereGeometry(0.11, 10, 8),
    hair: new THREE.SphereGeometry(0.12, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.01, 0),
    torso: new THREE.BoxGeometry(0.34, 0.5, 0.2).translate(0, -0.25, 0),
    armL: new THREE.BoxGeometry(0.09, 0.56, 0.09).translate(0, -0.28, 0),
    armR: new THREE.BoxGeometry(0.09, 0.56, 0.09).translate(0, -0.28, 0),
    legL: new THREE.BoxGeometry(0.13, 0.78, 0.14).translate(0, -0.39, 0),
    legR: new THREE.BoxGeometry(0.13, 0.78, 0.14).translate(0, -0.39, 0),
    bag: new THREE.BoxGeometry(0.26, 0.3, 0.12).translate(0, -0.15, 0),
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const tiles = new Map<string, TilePeds>();
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let nightK = 0;

  function makeWalker(rand: () => number, seg: number): Walker {
    const r = rand();
    const kind: Kind = r < 0.3 ? 'man' : r < 0.6 ? 'woman' : r < 0.7 ? 'boy' : r < 0.8 ? 'girl' : r < 0.9 ? 'elder_m' : 'elder_f';
    const base = { seg, t: rand(), dir: rand() < 0.5 ? 1 : -1, phase: rand() * 10, dodge: 0 } as const;
    switch (kind) {
      case 'man':
        return { ...base, speed: 1.1 + rand() * 0.5, height: 1.7 + rand() * 0.12, shoulder: 1.1, hair: rand() * 0.3, stoop: 0, skirt: false, bag: rand() < 0.3 };
      case 'woman':
        return { ...base, speed: 1.0 + rand() * 0.5, height: 1.58 + rand() * 0.1, shoulder: 0.9, hair: 0.5 + rand() * 0.5, stoop: 0, skirt: rand() < 0.5, bag: rand() < 0.6 };
      case 'boy':
        return { ...base, speed: 1.2 + rand() * 0.6, height: 1.15 + rand() * 0.25, shoulder: 0.9, hair: 0.2, stoop: 0, skirt: false, bag: rand() < 0.5 };
      case 'girl':
        return { ...base, speed: 1.1 + rand() * 0.6, height: 1.12 + rand() * 0.25, shoulder: 0.85, hair: 0.8, stoop: 0, skirt: rand() < 0.6, bag: rand() < 0.5 };
      case 'elder_m':
        return { ...base, speed: 0.6 + rand() * 0.3, height: 1.6 + rand() * 0.08, shoulder: 1.0, hair: 0.1, stoop: 0.18, skirt: false, bag: rand() < 0.2 };
      default:
        return { ...base, speed: 0.6 + rand() * 0.3, height: 1.5 + rand() * 0.08, shoulder: 0.85, hair: 0.6, stoop: 0.15, skirt: rand() < 0.4, bag: rand() < 0.4 };
    }
  }

  return {
    addTile(key, ts) {
      if (tiles.has(key) || !ts.walks.length) return;
      const rand = mulberry32(key.length * 31 + key.charCodeAt(0) * 7 + 11);
      const walkers: Walker[] = [];
      ts.walks.forEach((w, seg) => {
        const len = Math.hypot(w.x1 - w.x0, w.z1 - w.z0);
        const n = Math.floor(len * density + rand());
        for (let k = 0; k < n; k++) walkers.push(makeWalker(rand, seg));
      });
      if (!walkers.length) return;
      const parts = {} as Record<Part, THREE.InstancedMesh>;
      for (const p of PARTS) {
        const m = new THREE.InstancedMesh(geo[p], mat, walkers.length);
        m.castShadow = true;
        m.frustumCulled = false;
        parts[p] = m;
        scene.add(m);
      }
      walkers.forEach((w, i) => {
        const skin = SKIN[Math.floor(rand() * SKIN.length)];
        const hair = w.height < 1.5 && w.hair < 0.3 ? HAIR[Math.floor(rand() * 4)] : w.stoop > 0 ? HAIR[4 + Math.floor(rand() * 2)] : HAIR[Math.floor(rand() * 4)];
        const top = TOPS[Math.floor(rand() * TOPS.length)];
        const bottom = w.skirt ? TOPS[Math.floor(rand() * TOPS.length)] : BOTTOMS[Math.floor(rand() * BOTTOMS.length)];
        parts.head.setColorAt(i, col.setHex(skin));
        parts.hair.setColorAt(i, col.setHex(hair));
        parts.torso.setColorAt(i, col.setHex(top));
        parts.armL.setColorAt(i, col.setHex(rand() < 0.5 ? top : skin));
        parts.armR.setColorAt(i, col.setHex(parts.armL.instanceColor ? top : top));
        parts.legL.setColorAt(i, col.setHex(bottom));
        parts.legR.setColorAt(i, col.setHex(bottom));
        parts.bag.setColorAt(i, col.setHex(BOTTOMS[Math.floor(rand() * BOTTOMS.length)]));
      });
      tiles.set(key, { parts, walkers, walks: ts.walks });
    },
    removeTile(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      for (const p of PARTS) {
        scene.remove(t.parts[p]);
        t.parts[p].dispose();
      }
    },
    update(dt, S) {
      const now = performance.now() * 0.001;
      for (const t of tiles.values()) {
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
          // 차가 가까이 오면 차도에서 먼 쪽(건물 쪽)으로 비킨다
          const d = Math.hypot(x - S.x, z - S.z);
          const target = d < 5 ? 1.5 : 0;
          w.dodge += (target - w.dodge) * Math.min(1, dt * 6);
          const px = x + seg.nx * w.dodge;
          const pz = z + seg.nz * w.dodge;
          const yaw = Math.atan2((seg.x1 - seg.x0) * w.dir, (seg.z1 - seg.z0) * w.dir);
          // 걷기: 다리·팔 스윙, 몸 살짝 상하
          const sw = Math.sin(w.phase + now * (4.2 + w.speed * 2));
          const s = w.height / 1.7;
          const bob = Math.abs(sw) * 0.03 * s;
          const legLen = 0.78 * s;
          const torsoLen = 0.5 * s;
          const hipY = legLen + bob;
          const place = (part: Part, ox: number, oy: number, oz: number, rx: number, sx: number, sy: number, sz: number) => {
            dummy.position.set(px, 0, pz);
            dummy.rotation.set(0, yaw, 0);
            dummy.updateMatrix();
            const local = new THREE.Matrix4().makeRotationX(rx).setPosition(ox, oy, oz);
            const scale = new THREE.Matrix4().makeScale(sx, sy, sz);
            dummy.matrix.multiply(local).multiply(scale);
            t.parts[part].setMatrixAt(i, dummy.matrix);
          };
          const swing = 0.55 * Math.min(1, w.speed / 1.2);
          place('legL', -0.085 * s * w.shoulder, hipY, 0, sw * swing, s, s, s);
          place('legR', 0.085 * s * w.shoulder, hipY, 0, -sw * swing, s, s, s);
          const shoulderY = hipY + torsoLen;
          place('torso', 0, shoulderY, -w.stoop * 0.15, w.stoop, s * w.shoulder, s * (w.skirt ? 1.05 : 1), s);
          place('armL', -0.22 * s * w.shoulder, shoulderY - 0.02, 0, -sw * swing * 0.7, s, s, s);
          place('armR', 0.22 * s * w.shoulder, shoulderY - 0.02, 0, sw * swing * 0.7, s, s, s);
          const headY = shoulderY + 0.12 * s;
          place('head', 0, headY, -w.stoop * 0.22, w.stoop * 0.5, s, s, s);
          place('hair', 0, headY, -w.stoop * 0.22, w.stoop * 0.5, s * (1 + w.hair * 0.15), s * (1 + w.hair * 0.5), s * (1 + w.hair * 0.4));
          place('bag', 0, shoulderY - 0.05, -0.17 * s, 0, w.bag ? s : 0.0001, w.bag ? s : 0.0001, w.bag ? s : 0.0001);
        });
        for (const p of PARTS) t.parts[p].instanceMatrix.needsUpdate = true;
      }
    },
    setNight(night) {
      nightK = night;
      mat.color.setScalar(1 - nightK * 0.5);
    },
  };
}
