import * as THREE from 'three';
import { DIRS, N, reduceMotion } from '../config.ts';
import { glowTexture, nameTag } from '../render/textures.ts';
import { rint } from '../util/math.ts';
import { PROBE, type PlayerState } from '../vehicle/player.ts';
import { curveSeg, dirHeading, inGrid, lineSeg, nodePos, segAt, type Node, type Segment } from '../world/roads.ts';

export interface RivalSpec {
  name: string;
  body: number;
  glow: string;
  hex: string;
  /** 1부터. 높을수록 빠르고 보상이 크다 */
  level: number;
  reward: number;
  /** 배틀 중 기본 속도 m/s */
  pace: number;
}

export interface Npc {
  mesh: THREE.Group;
  from: Node;
  to: Node;
  dir: number;
  route: number[];
  seg: Segment;
  s: number;
  speed: number;
  cruise: number;
  stun: number;
  x: number;
  z: number;
  h: number;
  rival: RivalSpec | null;
  racing: boolean;
  cool: number;
}

export const RIVALS: readonly RivalSpec[] = [
  { name: '다크나이트', body: 0x15151c, glow: 'rgba(155,92,255,0.85)', hex: '#9b5cff', level: 1, reward: 800, pace: 34 },
  { name: '블루스톰', body: 0x1f4fd6, glow: 'rgba(79,209,255,0.85)', hex: '#4fd1ff', level: 2, reward: 1600, pace: 44 },
  { name: '레드폭스', body: 0xc0202c, glow: 'rgba(255,122,60,0.85)', hex: '#ff7a3c', level: 3, reward: 3200, pace: 56 },
];

// 서울 느낌: 흰색·은색·검정 승용차 사이로 주황 택시
const TRAFFIC_COLORS = [0xd9dce3, 0x9aa1ad, 0x23252c, 0x2c3e66, 0xf08a24, 0xf08a24, 0x6b1f24, 0xe7e2d6];
const TRAFFIC_COUNT = 34;

export interface Traffic {
  npcs: Npc[];
  /** racePace: 배틀 중인 라이벌의 목표 속도 */
  update(dt: number, player: PlayerState, racePace: (n: Npc) => number): void;
  collidePlayer(S: PlayerState): void;
  nearbyRival(S: PlayerState, range?: number): Npc | null;
}

export function createTraffic(scene: THREE.Scene): Traffic {
  const bodyGeo = new THREE.BoxGeometry(1.9, 0.6, 4.1);
  const cabinGeo = new THREE.BoxGeometry(1.6, 0.5, 2.0);
  const wheelGeo = new THREE.BoxGeometry(2.04, 0.5, 0.74);
  const lightGeo = new THREE.BoxGeometry(0.45, 0.13, 0.05);
  const dark = new THREE.MeshPhongMaterial({ color: 0x0c0e14, shininess: 120, specular: 0x8899bb });
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111216 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0x8a0f18 });
  const bodyMats = new Map<number, THREE.Material>();
  const bodyMat = (hex: number) => {
    let m = bodyMats.get(hex);
    if (!m) {
      m = new THREE.MeshPhongMaterial({ color: hex, shininess: 60, specular: 0x333333 });
      bodyMats.set(hex, m);
    }
    return m;
  };

  function buildMesh(hex: number, rival: RivalSpec | null): THREE.Group {
    const g = new THREE.Group();
    const b = new THREE.Mesh(bodyGeo, bodyMat(hex));
    b.position.y = 0.72;
    const c = new THREE.Mesh(cabinGeo, dark);
    c.position.set(0, 1.27, -0.2);
    g.add(b, c);
    for (const z of [1.3, -1.3]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(0, 0.36, z);
      g.add(w);
    }
    for (const x of [-0.6, 0.6]) {
      const h = new THREE.Mesh(lightGeo, headMat);
      h.position.set(x, 0.8, 2.06);
      const t = new THREE.Mesh(lightGeo, tailMat);
      t.position.set(x, 0.85, -2.06);
      g.add(h, t);
    }
    if (rival) {
      const ug = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 6).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          map: glowTexture(rival.glow),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ug.position.y = 0.04;
      g.add(ug, nameTag(`${rival.name} Lv${rival.level}`, rival.hex));
    }
    scene.add(g);
    return g;
  }

  const npcs: Npc[] = [];
  function spawn(hex: number, rival: RivalSpec | null): void {
    let from: Node;
    let dir: number;
    do {
      from = [rint(N + 1), rint(N + 1)];
      dir = rint(4);
    } while (!inGrid(from[0] + DIRS[dir][0], from[1] + DIRS[dir][1]) || Math.hypot(...nodePos(from)) < 80);
    const seg = lineSeg(from, dir);
    const s = Math.random() * seg.len;
    const [x, z] = segAt(seg, s);
    const n: Npc = {
      mesh: buildMesh(hex, rival),
      from,
      dir,
      to: [from[0] + DIRS[dir][0], from[1] + DIRS[dir][1]],
      route: [],
      seg,
      s,
      speed: 0,
      cruise: rival ? 13 : 8 + Math.random() * 6,
      stun: 0,
      x,
      z,
      h: dirHeading(dir),
      rival,
      racing: false,
      cool: 0,
    };
    n.mesh.position.set(x, 0, z);
    n.mesh.rotation.y = n.h;
    npcs.push(n);
  }
  for (let i = 0; i < TRAFFIC_COUNT; i++) spawn(TRAFFIC_COLORS[i % TRAFFIC_COLORS.length], null);
  for (const r of RIVALS) spawn(r.body, r);

  function chooseDir(n: Npc): number {
    const next = n.route.shift();
    if (next !== undefined) return next;
    const [i, j] = n.to;
    const back = (n.dir + 2) % 4;
    const opts: number[] = [];
    for (let k = 0; k < 4; k++) {
      if (k === back || !inGrid(i + DIRS[k][0], j + DIRS[k][1])) continue;
      opts.push(k);
      if (k === n.dir) opts.push(k, k); // 직진 선호
    }
    return opts.length ? opts[rint(opts.length)] : back;
  }
  function advanceSeg(n: Npc): void {
    if (n.seg.c) {
      n.seg = lineSeg(n.from, n.dir);
      return;
    }
    const d2 = chooseDir(n);
    n.seg = curveSeg(n.to, n.dir, d2);
    n.from = n.to;
    n.dir = d2;
    n.to = [n.from[0] + DIRS[d2][0], n.from[1] + DIRS[d2][1]];
  }

  /** 같은 방향으로 앞에 있는 차(또는 플레이어)까지의 거리 */
  function gapAhead(n: Npc, S: PlayerState): number {
    const fx = Math.sin(n.h);
    const fz = Math.cos(n.h);
    let best = Infinity;
    const test = (ox: number, oz: number, oh: number | null) => {
      const dx = ox - n.x;
      const dz = oz - n.z;
      const fwd = dx * fx + dz * fz;
      if (fwd <= 0 || fwd > 16 || Math.abs(dx * fz - dz * fx) > 2.4) return;
      if (oh !== null && Math.sin(oh) * fx + Math.cos(oh) * fz < 0.3) return;
      best = Math.min(best, fwd);
    };
    for (const o of npcs) if (o !== n) test(o.x, o.z, o.h);
    test(S.x, S.z, null);
    return best;
  }

  return {
    npcs,

    update(dt, S, racePace) {
      for (const n of npcs) {
        let want: number;
        if (n.racing) {
          const turnSoon = !n.seg.c && n.seg.len - n.s < 24 && n.route.length > 0 && n.route[0] !== n.dir;
          if (n.seg.c && n.seg.turn) want = 15;
          else want = turnSoon ? 17 : racePace(n);
        } else {
          want = n.seg.turn ? Math.min(n.cruise, 7) : n.cruise;
          const gap = gapAhead(n, S);
          if (gap < 16) want = Math.min(want, Math.max(0, (gap - 6) * 1.4));
        }
        if (n.stun > 0) {
          n.stun -= dt;
          want = 0;
        }
        if (n.cool > 0) n.cool -= dt;
        n.speed += (want - n.speed) * Math.min(1, dt * (want < n.speed ? 3 : 1.2));
        n.s += n.speed * dt;
        while (n.s >= n.seg.len) {
          n.s -= n.seg.len;
          advanceSeg(n);
        }
        const [x, z] = segAt(n.seg, n.s);
        const mx = x - n.x;
        const mz = z - n.z;
        if (mx * mx + mz * mz > 1e-6) n.h = Math.atan2(mx, mz);
        n.x = x;
        n.z = z;
        n.mesh.position.set(x, 0, z);
        n.mesh.rotation.y = n.h;
      }
    },

    collidePlayer(S) {
      const fx = Math.sin(S.h);
      const fz = Math.cos(S.h);
      let hit = 0;
      for (const n of npcs) {
        if (Math.abs(n.x - S.x) > 7 || Math.abs(n.z - S.z) > 7) continue;
        const nfx = Math.sin(n.h);
        const nfz = Math.cos(n.h);
        for (const a of PROBE) {
          for (const b of PROBE) {
            const qx = n.x + nfx * b;
            const qz = n.z + nfz * b;
            let dx = S.x + fx * a - qx;
            let dz = S.z + fz * a - qz;
            const d = Math.hypot(dx, dz);
            if (d >= 2.2 || d < 1e-4) continue;
            dx /= d;
            dz /= d;
            S.x += dx * (2.2 - d);
            S.z += dz * (2.2 - d);
            const rel = (S.vx - nfx * n.speed) * dx + (S.vz - nfz * n.speed) * dz;
            if (rel < 0) {
              S.vx -= 1.2 * rel * dx;
              S.vz -= 1.2 * rel * dz;
              S.vx *= 0.88;
              S.vz *= 0.88;
              hit = Math.max(hit, -rel);
            }
            if (n.racing) n.speed *= 0.7;
            else n.stun = 1.6;
          }
        }
      }
      if (hit > 3 && !reduceMotion) S.shake = Math.min(1, S.shake + hit / 25);
    },

    nearbyRival(S, range = 22) {
      let best: Npc | null = null;
      let bd = range;
      for (const n of npcs) {
        if (!n.rival || n.cool > 0) continue;
        const d = Math.hypot(n.x - S.x, n.z - S.z);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    },
  };
}
