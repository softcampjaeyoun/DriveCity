import * as THREE from 'three';
import { DIRS, N, reduceMotion } from '../config.ts';
import { glowTexture, nameTag } from '../render/textures.ts';
import { rint } from '../util/math.ts';
import { KINDS, TRAFFIC_MIX, probesFor, type VehicleKind } from '../vehicle/kinds.ts';
import { swapModel } from '../vehicle/models.ts';
import { buildForKind, buildSedan } from '../vehicle/procedural.ts';
import { PROBE, RADIUS, type PlayerState } from '../vehicle/player.ts';
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
  /** models.ts 의 MODELS 키 */
  model?: string;
}

export interface Npc {
  mesh: THREE.Group;
  kind: VehicleKind;
  /** 충돌 원 중심 오프셋 (앞 +) */
  probes: number[];
  radius: number;
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
  { name: '다크나이트', body: 0x15151c, glow: 'rgba(155,92,255,0.85)', hex: '#9b5cff', level: 1, reward: 800, pace: 34, model: 'rival_1' },
  { name: '블루스톰', body: 0x1f4fd6, glow: 'rgba(79,209,255,0.85)', hex: '#4fd1ff', level: 2, reward: 1600, pace: 44, model: 'rival_2' },
  { name: '레드폭스', body: 0xc0202c, glow: 'rgba(255,122,60,0.85)', hex: '#ff7a3c', level: 3, reward: 3200, pace: 56, model: 'rival_3' },
];

export interface Traffic {
  npcs: Npc[];
  /** racePace: 배틀 중인 라이벌의 목표 속도 */
  update(dt: number, player: PlayerState, racePace: (n: Npc) => number): void;
  collidePlayer(S: PlayerState): void;
  nearbyRival(S: PlayerState, range?: number): Npc | null;
}

export function createTraffic(scene: THREE.Scene): Traffic {
  function buildMesh(kind: VehicleKind, hex: number, rival: RivalSpec | null, index: number): THREE.Group {
    const g = new THREE.Group();
    const visual = rival ? buildSedan(hex, kind.length, kind.width) : buildForKind(kind, hex);
    visual.name = 'fallback';
    g.add(visual);
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
    const pool = kind.models;
    swapModel(g, visual, rival ? rival.model : pool?.length ? pool[index % pool.length] : undefined, kind.tintModel ? hex : undefined);
    scene.add(g);
    return g;
  }

  const npcs: Npc[] = [];
  function spawn(kind: VehicleKind, hex: number, rival: RivalSpec | null, index = 0): void {
    let from: Node;
    let dir: number;
    do {
      from = [rint(N + 1), rint(N + 1)];
      dir = rint(4);
    } while (!inGrid(from[0] + DIRS[dir][0], from[1] + DIRS[dir][1]) || Math.hypot(...nodePos(from)) < 80);
    const seg = lineSeg(from, dir);
    const s = Math.random() * seg.len;
    const [x, z] = segAt(seg, s);
    const [c0, c1] = kind.cruise;
    const n: Npc = {
      mesh: buildMesh(kind, hex, rival, index),
      kind,
      probes: probesFor(kind.length),
      radius: kind.width / 2 + 0.15,
      from,
      dir,
      to: [from[0] + DIRS[dir][0], from[1] + DIRS[dir][1]],
      route: [],
      seg,
      s,
      speed: 0,
      cruise: c0 + Math.random() * (c1 - c0),
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
  for (const [id, count] of TRAFFIC_MIX) {
    const kind = KINDS[id];
    for (let i = 0; i < count; i++) spawn(kind, kind.colors[i % kind.colors.length], null, i);
  }
  for (const r of RIVALS) spawn(KINDS.rival, r.body, r);

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

  /** 같은 방향으로 앞에 있는 차(또는 플레이어)의 뒷범퍼까지의 거리 */
  function gapAhead(n: Npc, S: PlayerState): number {
    const fx = Math.sin(n.h);
    const fz = Math.cos(n.h);
    const myFront = n.kind.length / 2;
    let best = Infinity;
    const test = (ox: number, oz: number, oh: number | null, oHalf: number) => {
      const dx = ox - n.x;
      const dz = oz - n.z;
      const fwd = dx * fx + dz * fz - myFront - oHalf;
      if (fwd <= -oHalf || fwd > 16 || Math.abs(dx * fz - dz * fx) > 2.4) return;
      if (oh !== null && Math.sin(oh) * fx + Math.cos(oh) * fz < 0.3) return;
      best = Math.min(best, Math.max(0, fwd));
    };
    for (const o of npcs) if (o !== n) test(o.x, o.z, o.h, o.kind.length / 2);
    test(S.x, S.z, null, 2.1);
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
          want = n.seg.turn ? Math.min(n.cruise, n.kind.turnSpeed) : n.cruise;
          const gap = gapAhead(n, S);
          if (gap < 14) want = Math.min(want, Math.max(0, (gap - 4) * 1.4));
        }
        if (n.stun > 0) {
          n.stun -= dt;
          want = 0;
        }
        if (n.cool > 0) n.cool -= dt;
        // 버스는 무거워서 가감속이 느리다
        const heavy = n.kind.length > 8 ? 0.6 : 1;
        n.speed += (want - n.speed) * Math.min(1, dt * (want < n.speed ? 3 : 1.2) * heavy);
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
        const reach = n.kind.length / 2 + 4;
        if (Math.abs(n.x - S.x) > reach || Math.abs(n.z - S.z) > reach) continue;
        const nfx = Math.sin(n.h);
        const nfz = Math.cos(n.h);
        const minD = RADIUS + n.radius;
        // 버스는 플레이어보다 훨씬 무거워 거의 밀리지 않는다
        const mass = n.kind.length > 8 ? 6 : n.kind.length > 6 ? 3 : 1;
        for (const a of PROBE) {
          for (const b of n.probes) {
            const qx = n.x + nfx * b;
            const qz = n.z + nfz * b;
            let dx = S.x + fx * a - qx;
            let dz = S.z + fz * a - qz;
            const d = Math.hypot(dx, dz);
            if (d >= minD || d < 1e-4) continue;
            dx /= d;
            dz /= d;
            S.x += dx * (minD - d);
            S.z += dz * (minD - d);
            const rel = (S.vx - nfx * n.speed) * dx + (S.vz - nfz * n.speed) * dz;
            if (rel < 0) {
              const k = 1 + 0.2 * Math.min(mass, 2);
              S.vx -= k * rel * dx;
              S.vz -= k * rel * dz;
              S.vx *= 0.88;
              S.vz *= 0.88;
              hit = Math.max(hit, -rel * Math.min(mass, 2));
            }
            if (n.racing) n.speed *= 0.7;
            else n.stun = mass > 1 ? 0.8 : 1.6;
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
