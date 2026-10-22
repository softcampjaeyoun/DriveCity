import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import type { PlayerState } from '../vehicle/player.ts';
import type { TileScene, WalkPath } from '../world/city.ts';
import type { Node } from '../world/graph.ts';

/**
 * 큰길 인도를 오가는 보행자. 머리·머리카락·몸통·팔·다리를 부위별 인스턴스로 그려 걷는 동작과 체형 차이를 낸다.
 * 인도 폴리라인 끝에 닿으면 이어진 길(모서리 연결·횡단보도·다음 인도) 중 하나로 옮겨 가고, 횡단보도는 보행 신호가 파란불일 때만 건넌다
 */
export interface Pedestrians {
  addTile(key: string, ts: TileScene): void;
  removeTile(key: string): void;
  update(dt: number, S: PlayerState): void;
  setNight(night: number): void;
  /** 디버그: 전체 보행자, 횡단보도 위, 신호 대기 중 수 */
  stats(): { total: number; crossing: number; standing: number };
  /** 승하차 연출: (x0,z0) 에서 (x1,z1) 로 걸어가 사라지는 사람 count 명 (버스 정류장 ↔ 버스 문) */
  transit(x0: number, z0: number, x1: number, z1: number, count: number, y?: number): void;
}

export interface WalkSignals {
  has(n: Node): boolean;
  walkState(n: Node, edgeId: number): 'red' | 'green' | 'yellow';
  /** (x,z) 지형 높이. 보행로의 y 는 지형 위 상대 높이(연석)라 더해 쓴다 */
  terrainAt(x: number, z: number): number;
}

type Kind = 'man' | 'woman' | 'boy' | 'girl' | 'elder_m' | 'elder_f';

interface Walker {
  path: number;
  /** 길 위 호 길이 */
  s: number;
  dir: 1 | -1;
  speed: number;
  phase: number;
  /** 인도 안쪽으로 비킨 양 (m) */
  dodge: number;
  /** 서 있는 중 (빨간불 대기) */
  standing: boolean;
  /** 몸 비율 */
  height: number;
  shoulder: number;
  hair: number; // 0 없음(모자/짧음) .. 1 긴 머리
  stoop: number; // 노인 구부정
  skirt: boolean;
  bag: boolean;
  /** 승하차 연출: 길 끝에 닿으면 사라진다 */
  transit?: boolean;
}
interface Link {
  path: number;
  end: 0 | 1;
}
interface TilePeds {
  parts: Record<Part, THREE.InstancedMesh>;
  /** 승하차용 묶음은 빈 자리(null)를 재사용한다 */
  walkers: Array<Walker | null>;
  walks: WalkPath[];
  /** 길 끝(path:end)에서 이어지는 다른 길 끝들 */
  adj: Map<string, Link[]>;
  /** 아직 한 번도 자리를 잡지 않음: 첫 갱신 때 거리와 상관없이 전부 놓는다 */
  fresh: boolean;
}
type Part = 'head' | 'hair' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'bag';
const PARTS: Part[] = ['head', 'hair', 'torso', 'armL', 'armR', 'legL', 'legR', 'bag'];
/** 이보다 먼 보행자는 움직이지 않는다 (매 프레임 행렬 수천 개를 올리지 않게) */
const ACTIVE_DIST = 320;

const SKIN = [0xf1c9a5, 0xe8b894, 0xd9a07a, 0xf5d6b8];
const HAIR = [0x1a1512, 0x2b1d14, 0x4a3524, 0x6b4a2e, 0x8a8a8a, 0xd8d0c4];
const TOPS = [0x2b2f3a, 0x8c1d1d, 0x1d4e8c, 0xe8e2d4, 0x3b6b3b, 0x5a3a6b, 0xb8872c, 0x202020, 0xd9d9d9, 0x7a4a2a, 0xf0a0b8, 0x4aa3df, 0xffffff, 0x3a3a52];
const BOTTOMS = [0x1f2a44, 0x2a2a2a, 0x5a5f6b, 0x3b3b3b, 0x8a7a66, 0x1a3a6b, 0x6b2a2a, 0x2f4a3a];

/** 폴리라인 위 호 길이 s 의 점·진행 방향·그 구간의 바깥 방향 */
function sampleAt(p: WalkPath, s: number): { x: number; z: number; hx: number; hz: number; nx: number; nz: number } {
  const cum = p.cum;
  const n = cum.length;
  const sa = Math.min(Math.max(0, s), p.len);
  let lo = 0;
  let hi = Math.max(0, n - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= sa) lo = mid;
    else hi = mid - 1;
  }
  const l = cum[lo + 1] - cum[lo] || 1;
  const t = (sa - cum[lo]) / l;
  const x0 = p.pts[lo * 2];
  const z0 = p.pts[lo * 2 + 1];
  const x1 = p.pts[lo * 2 + 2] ?? x0;
  const z1 = p.pts[lo * 2 + 3] ?? z0;
  return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, hx: (x1 - x0) / l, hz: (z1 - z0) / l, nx: p.nrm[lo * 2] ?? 0, nz: p.nrm[lo * 2 + 1] ?? 0 };
}

export function createPedestrians(scene: THREE.Scene, sig: WalkSignals, density = 1 / 40): Pedestrians {
  // 단위 부위 지오메트리. 원점이 각 부위의 붙는 지점이라 회전이 자연스럽다
  const geo: Record<Part, THREE.BufferGeometry> = {
    head: new THREE.SphereGeometry(0.11, 10, 8),
    hair: new THREE.SphereGeometry(0.12, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.01, 0),
    // 몸통·팔다리는 캡슐로 (상자보다 사람 실루엣에 가깝다). 원점은 붙는 지점(목·어깨·엉덩이)
    torso: new THREE.CapsuleGeometry(0.15, 0.26, 3, 8).scale(1.15, 1, 0.68).translate(0, -0.25, 0),
    armL: new THREE.CapsuleGeometry(0.045, 0.46, 2, 6).translate(0, -0.28, 0),
    armR: new THREE.CapsuleGeometry(0.045, 0.46, 2, 6).translate(0, -0.28, 0),
    legL: new THREE.CapsuleGeometry(0.068, 0.62, 2, 6).translate(0, -0.39, 0),
    legR: new THREE.CapsuleGeometry(0.068, 0.62, 2, 6).translate(0, -0.39, 0),
    bag: new THREE.BoxGeometry(0.26, 0.3, 0.12).translate(0, -0.15, 0),
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 });
  const tiles = new Map<string, TilePeds>();
  const dummy = new THREE.Object3D();
  const local = new THREE.Matrix4();
  const scale = new THREE.Matrix4();
  const col = new THREE.Color();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let nightK = 0;
  const TRANSIT_CAP = 48;
  const transitRand = mulberry32(4242);

  /** 승하차 연출용 묶음 (자리 48개, 빈 자리를 돌려 쓴다) */
  function transitTile(): TilePeds {
    let t = tiles.get('__transit');
    if (t) return t;
    const parts = {} as Record<Part, THREE.InstancedMesh>;
    for (const p of PARTS) {
      const m = new THREE.InstancedMesh(geo[p], mat, TRANSIT_CAP);
      m.castShadow = true;
      m.frustumCulled = false;
      for (let i = 0; i < TRANSIT_CAP; i++) m.setMatrixAt(i, hidden);
      parts[p] = m;
      scene.add(m);
    }
    t = { parts, walkers: new Array<Walker | null>(TRANSIT_CAP).fill(null), walks: [], adj: new Map(), fresh: false };
    tiles.set('__transit', t);
    return t;
  }
  function paint(parts: Record<Part, THREE.InstancedMesh>, i: number, w: Walker, rand: () => number): void {
    const skin = SKIN[Math.floor(rand() * SKIN.length)];
    const hair = w.height < 1.5 && w.hair < 0.3 ? HAIR[Math.floor(rand() * 4)] : w.stoop > 0 ? HAIR[4 + Math.floor(rand() * 2)] : HAIR[Math.floor(rand() * 4)];
    const top = TOPS[Math.floor(rand() * TOPS.length)];
    const bottom = w.skirt ? TOPS[Math.floor(rand() * TOPS.length)] : BOTTOMS[Math.floor(rand() * BOTTOMS.length)];
    parts.head.setColorAt(i, col.setHex(skin));
    parts.hair.setColorAt(i, col.setHex(hair));
    parts.torso.setColorAt(i, col.setHex(top));
    parts.armL.setColorAt(i, col.setHex(rand() < 0.5 ? top : skin));
    parts.armR.setColorAt(i, col.setHex(top));
    parts.legL.setColorAt(i, col.setHex(bottom));
    parts.legR.setColorAt(i, col.setHex(bottom));
    parts.bag.setColorAt(i, col.setHex(BOTTOMS[Math.floor(rand() * BOTTOMS.length)]));
    for (const p of PARTS) if (parts[p].instanceColor) parts[p].instanceColor.needsUpdate = true;
  }

  function makeWalker(rand: () => number, path: number, len: number): Walker {
    const r = rand();
    const kind: Kind = r < 0.3 ? 'man' : r < 0.6 ? 'woman' : r < 0.7 ? 'boy' : r < 0.8 ? 'girl' : r < 0.9 ? 'elder_m' : 'elder_f';
    const base = { path, s: rand() * len, dir: rand() < 0.5 ? 1 : -1, phase: rand() * 10, dodge: 0, standing: false } as const;
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

  /** 길 끝끼리 1.2m 안이면 이어진 것으로 */
  function buildAdj(walks: WalkPath[]): Map<string, Link[]> {
    const ends: Array<{ x: number; z: number; link: Link }> = [];
    walks.forEach((p, i) => {
      ends.push({ x: p.pts[0], z: p.pts[1], link: { path: i, end: 0 } }, { x: p.pts[p.pts.length - 2], z: p.pts[p.pts.length - 1], link: { path: i, end: 1 } });
    });
    const grid = new Map<string, typeof ends>();
    const kOf = (x: number, z: number) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
    for (const e of ends) {
      const k = kOf(e.x, e.z);
      const l = grid.get(k) ?? [];
      l.push(e);
      grid.set(k, l);
    }
    const adj = new Map<string, Link[]>();
    for (const e of ends) {
      const cx = Math.floor(e.x / 4);
      const cz = Math.floor(e.z / 4);
      const out: Link[] = [];
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const o of grid.get(`${cx + i},${cz + j}`) ?? []) {
            if (o.link.path === e.link.path) continue;
            if (Math.hypot(o.x - e.x, o.z - e.z) < 1.2) out.push(o.link);
          }
        }
      }
      if (out.length) adj.set(`${e.link.path}:${e.link.end}`, out);
    }
    return adj;
  }

  /** 길 끝에 닿은 보행자를 이어진 길로 보낸다. 이어진 길이 없으면 돌아선다 */
  function hop(w: Walker, t: TilePeds, rnd: number): void {
    const end: 0 | 1 = w.dir === 1 ? 1 : 0;
    const next = t.adj.get(`${w.path}:${end}`);
    if (!next?.length) {
      w.dir = (w.dir * -1) as 1 | -1;
      w.s = end === 1 ? t.walks[w.path].len : 0;
      return;
    }
    const c = next[Math.floor(rnd * next.length) % next.length];
    w.path = c.path;
    w.dir = c.end === 0 ? 1 : -1;
    w.s = c.end === 0 ? 0 : t.walks[c.path].len;
  }

  return {
    addTile(key, ts) {
      if (tiles.has(key) || !ts.walks.length) return;
      const rand = mulberry32(key.length * 31 + key.charCodeAt(0) * 7 + 11);
      const walkers: Walker[] = [];
      ts.walks.forEach((w, i) => {
        if (w.crowd <= 0) return;
        const n = Math.floor(w.len * density * w.crowd + rand());
        for (let k = 0; k < n; k++) walkers.push(makeWalker(rand, i, w.len));
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
      walkers.forEach((w, i) => paint(parts, i, w, rand));
      tiles.set(key, { parts, walkers, walks: ts.walks, adj: buildAdj(ts.walks), fresh: true });
    },
    transit(x0, z0, x1, z1, count, y = 0.12) {
      const t = transitTile();
      for (let k = 0; k < count; k++) {
        const slot = t.walkers.indexOf(null);
        if (slot < 0) return;
        // 출발점을 조금씩 흩어 줄지어 걷게
        const jx = (transitRand() - 0.5) * 1.6;
        const jz = (transitRand() - 0.5) * 1.6;
        const pts = [x0 + jx, z0 + jz, x1 + jx * 0.3, z1 + jz * 0.3];
        const cum = [0, Math.hypot(pts[2] - pts[0], pts[3] - pts[1])];
        t.walks.push({ pts, nrm: [0, 0, 0, 0], cum, len: cum[1], y, crowd: 0 });
        const w = makeWalker(transitRand, t.walks.length - 1, 0);
        w.s = 0;
        w.dir = 1;
        w.transit = true;
        w.speed *= 0.9;
        t.walkers[slot] = w;
        paint(t.parts, slot, w, transitRand);
      }
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
        let dirty = false;
        t.walkers.forEach((w, i) => {
          if (!w) return;
          let P = t.walks[w.path];
          // 멀리 있는 보행자는 그대로 둔다 (처음 한 번은 전부 놓는다)
          const here = sampleAt(P, w.s);
          const d = Math.hypot(here.x - S.x, here.z - S.z);
          if (!t.fresh && d > ACTIVE_DIST) return;
          dirty = true;
          // 횡단보도 앞: 보행 신호가 파란불이 아니면 연석에서 기다린다
          const step = w.speed * dt;
          w.standing = false;
          if (P.cross) {
            const ahead = w.dir === 1 ? w.s < P.cross.s0 && w.s + step >= P.cross.s0 - 0.01 : w.s > P.cross.s1 && w.s - step <= P.cross.s1 + 0.01;
            if (ahead && sig.has(P.cross.node) && sig.walkState(P.cross.node, P.cross.edge) !== 'green') {
              w.standing = true;
              w.s = w.dir === 1 ? P.cross.s0 - 0.05 : P.cross.s1 + 0.05;
            }
          }
          if (!w.standing) {
            w.s += w.dir * step;
            if (w.s >= P.len || w.s <= 0) {
              if (w.transit) {
                // 승하차 연출 끝: 자리를 비우고 숨긴다
                t.walkers[i] = null;
                for (const p of PARTS) t.parts[p].setMatrixAt(i, hidden);
                dirty = true;
                return;
              }
              hop(w, t, (Math.sin(w.phase * 7.3 + now) + 1) * 0.5);
              P = t.walks[w.path];
            }
          }
          const q = sampleAt(P, w.s);
          // 차가 가까이 오면 차도에서 먼 쪽(건물 쪽)으로 비킨다
          const target = d < 5 ? 1.5 : 0;
          w.dodge += (target - w.dodge) * Math.min(1, dt * 6);
          const px = q.x + q.nx * w.dodge;
          const pz = q.z + q.nz * w.dodge;
          const yaw = Math.atan2(q.hx * w.dir, q.hz * w.dir);
          // 걷기: 다리·팔 스윙, 몸 살짝 상하. 서 있으면 멈춘다
          const sw = w.standing ? 0 : Math.sin(w.phase + now * (4.2 + w.speed * 2));
          const s = w.height / 1.7;
          const bob = Math.abs(sw) * 0.03 * s;
          const legLen = 0.78 * s;
          const torsoLen = 0.5 * s;
          const hipY = legLen + bob;
          const place = (part: Part, ox: number, oy: number, oz: number, rx: number, sx: number, sy: number, sz: number) => {
            dummy.position.set(px, P.y + sig.terrainAt(px, pz), pz);
            dummy.rotation.set(0, yaw, 0);
            dummy.updateMatrix();
            local.makeRotationX(rx).setPosition(ox, oy, oz);
            scale.makeScale(sx, sy, sz);
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
        t.fresh = false;
        if (dirty) for (const p of PARTS) t.parts[p].instanceMatrix.needsUpdate = true;
      }
    },
    setNight(night) {
      nightK = night;
      mat.color.setScalar(1 - nightK * 0.5);
    },
    stats() {
      let total = 0;
      let crossing = 0;
      let standing = 0;
      for (const t of tiles.values()) {
        for (const w of t.walkers) {
          if (!w) continue;
          total++;
          if (w.standing) standing++;
          const c = t.walks[w.path].cross;
          if (c && w.s >= c.s0 && w.s <= c.s1) crossing++;
        }
      }
      return { total, crossing, standing };
    },
  };
}
