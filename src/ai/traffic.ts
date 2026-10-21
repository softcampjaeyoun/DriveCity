import * as THREE from 'three';
import { DIRS, LANES, backOf, leftTurn, reduceMotion, rightTurn } from '../config.ts';
import { glowTexture, nameTag } from '../render/textures.ts';
import { clamp, rint } from '../util/math.ts';
import { KINDS, POLICE_COUNT, TRAFFIC_MIX, probesFor, type VehicleKind } from '../vehicle/kinds.ts';
import { swapModel } from '../vehicle/models.ts';
import { buildForKind, buildSedan } from '../vehicle/procedural.ts';
import { PROBE, RADIUS, type PlayerState } from '../vehicle/player.ts';
import type { Node, RoadGraph } from '../world/graph.ts';
import { curveSeg, dirHeading, laneIndex, lineSeg, rightOf, segAt, type Segment } from '../world/roads.ts';
import type { Signals } from '../world/signals.ts';

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

export interface PoliceState {
  chasing: boolean;
  lights: [THREE.Mesh, THREE.Mesh];
  routeTimer: number;
  blink: number;
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
  /** 다음 교차로에서 갈 방향. 차선을 미리 잡기 위해 직선 구간 시작 때 정한다 */
  nextDir: number;
  route: number[];
  seg: Segment;
  s: number;
  /** 도로 중앙에서 오른쪽 거리. 차선 변경 중엔 두 차선 사이 값 */
  lat: number;
  latTarget: number;
  laneCool: number;
  speed: number;
  cruise: number;
  stun: number;
  x: number;
  z: number;
  h: number;
  rival: RivalSpec | null;
  racing: boolean;
  cool: number;
  police: PoliceState | null;
}

export const RIVALS: readonly RivalSpec[] = [
  { name: '다크나이트', body: 0x15151c, glow: 'rgba(155,92,255,0.85)', hex: '#9b5cff', level: 1, reward: 800, pace: 34, model: 'rival_1' },
  { name: '블루스톰', body: 0x1f4fd6, glow: 'rgba(79,209,255,0.85)', hex: '#4fd1ff', level: 2, reward: 1600, pace: 44, model: 'rival_2' },
  { name: '레드폭스', body: 0xc0202c, glow: 'rgba(255,122,60,0.85)', hex: '#ff7a3c', level: 3, reward: 3200, pace: 56, model: 'rival_3' },
];

export interface TrafficEvents {
  /** 플레이어가 NPC 와 부딪혔을 때. impact 는 상대 속도 m/s */
  onHit(n: Npc, impact: number): void;
}

export interface Traffic {
  npcs: Npc[];
  police: Npc[];
  update(dt: number, player: PlayerState, racePace: (n: Npc) => number, chasePace: number): void;
  collidePlayer(S: PlayerState): void;
  nearbyRival(S: PlayerState, range?: number): Npc | null;
  /** 라이벌·경찰에게 목적지까지 경로를 준다 */
  assignRoute(n: Npc, goal: Node): void;
  /** 수배 등급에 맞춰 경찰 몇 대가 추격할지 */
  setChase(count: number, playerNode: Node): void;
}

const LANE_RATE = 2.2;
const SIGNAL_STOP = 4.6;

export function createTraffic(scene: THREE.Scene, g: RoadGraph, signals: Signals, ev: TrafficEvents): Traffic {
  function buildMesh(kind: VehicleKind, hex: number, rival: RivalSpec | null, index: number): { mesh: THREE.Group; police: PoliceState | null } {
    const mesh = new THREE.Group();
    const visual = rival ? buildSedan(hex, kind.length, kind.width) : buildForKind(kind, hex);
    visual.name = 'fallback';
    mesh.add(visual);
    let police: PoliceState | null = null;
    if (rival) {
      const ug = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 6).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: glowTexture(rival.glow), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      ug.position.y = 0.04;
      mesh.add(ug, nameTag(`${rival.name} Lv${rival.level}`, rival.hex));
    }
    if (kind.id === 'police') {
      const geo = new THREE.BoxGeometry(0.5, 0.18, 0.4);
      const red = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
      const blue = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2a6bff }));
      red.position.set(-0.45, 1.68, -0.2);
      blue.position.set(0.45, 1.68, -0.2);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.42), new THREE.MeshLambertMaterial({ color: 0x15171c }));
      bar.position.set(0, 1.56, -0.2);
      const glow = new THREE.PointLight(0xff4a4a, 0, 14);
      glow.position.set(0, 2.2, 0);
      glow.name = 'policeGlow';
      mesh.add(bar, red, blue, glow);
      red.visible = blue.visible = false;
      police = { chasing: false, lights: [red, blue], routeTimer: 0, blink: 0 };
    }
    const pool = kind.models;
    swapModel(mesh, visual, rival ? rival.model : pool?.length ? pool[index % pool.length] : undefined, kind.tintModel ? hex : undefined);
    scene.add(mesh);
    return { mesh, police };
  }

  const npcs: Npc[] = [];
  const police: Npc[] = [];

  function chooseDir(n: Npc): number {
    const next = n.route.shift();
    if (next !== undefined && g.hasEdge(n.to[0], n.to[1], next)) return next;
    const [i, j] = n.to;
    const back = backOf(n.dir);
    const opts: number[] = [];
    for (let k = 0; k < 4; k++) {
      if (k === back || !g.hasEdge(i, j, k)) continue;
      opts.push(k);
      if (k === n.dir) opts.push(k, k); // 직진 선호
    }
    return opts.length ? opts[rint(opts.length)] : back;
  }
  /** 직선 구간에 들어설 때 다음 방향과 그에 맞는 차선을 정한다 */
  function planNext(n: Npc): void {
    n.nextDir = chooseDir(n);
    if (n.nextDir === rightTurn(n.dir)) n.latTarget = LANES[1];
    else if (n.nextDir === leftTurn(n.dir) || n.nextDir === backOf(n.dir)) n.latTarget = LANES[0];
    else if (n.kind.lane !== undefined) n.latTarget = LANES[n.kind.lane];
  }

  function spawn(kind: VehicleKind, hex: number, rival: RivalSpec | null, index = 0): Npc {
    let from: Node;
    let dir: number;
    do {
      from = g.randomNode();
      dir = rint(4);
    } while (!g.hasEdge(from[0], from[1], dir) || Math.hypot(...g.pos(from)) < 80);
    const lane = kind.lane ?? rint(2);
    const seg = lineSeg(g, from, dir, 0);
    const s = Math.random() * seg.len;
    const [c0, c1] = kind.cruise;
    const built = buildMesh(kind, hex, rival, index);
    const n: Npc = {
      mesh: built.mesh,
      kind,
      probes: probesFor(kind.length),
      radius: kind.width / 2 + 0.15,
      from,
      dir,
      nextDir: dir,
      to: [from[0] + DIRS[dir][0], from[1] + DIRS[dir][1]],
      route: [],
      seg,
      s,
      lat: LANES[lane],
      latTarget: LANES[lane],
      laneCool: Math.random() * 4,
      speed: 0,
      cruise: c0 + Math.random() * (c1 - c0),
      stun: 0,
      x: 0,
      z: 0,
      h: dirHeading(dir),
      rival,
      racing: false,
      cool: 0,
      police: built.police,
    };
    planNext(n);
    [n.x, n.z] = positionOf(n);
    n.mesh.position.set(n.x, 0, n.z);
    n.mesh.rotation.y = n.h;
    npcs.push(n);
    return n;
  }
  for (const [id, count] of TRAFFIC_MIX) {
    const kind = KINDS[id];
    for (let i = 0; i < count; i++) spawn(kind, kind.colors[i % kind.colors.length], null, i);
  }
  for (const r of RIVALS) spawn(KINDS.rival, r.body, r);
  for (let i = 0; i < POLICE_COUNT; i++) police.push(spawn(KINDS.police, KINDS.police.colors[0], null, i));

  function positionOf(n: Npc): [number, number] {
    const [x, z] = segAt(n.seg, n.s);
    if (n.seg.c) return [x, z];
    const [rx, rz] = rightOf(n.seg.dir);
    return [x + rx * n.lat, z + rz * n.lat];
  }

  function advanceSeg(n: Npc): void {
    if (n.seg.c) {
      n.seg = lineSeg(g, n.from, n.dir, 0);
      planNext(n);
      return;
    }
    const d2 = n.nextDir;
    const laneOut = d2 === rightTurn(n.dir) ? 1 : d2 === n.dir ? laneIndex(n.lat) : 0;
    n.seg = curveSeg(g, n.to, n.dir, d2, n.lat, LANES[laneOut]);
    n.lat = n.latTarget = LANES[laneOut];
    n.from = n.to;
    n.dir = d2;
    n.to = [n.from[0] + DIRS[d2][0], n.from[1] + DIRS[d2][1]];
  }

  /** 같은 방향으로 앞에 있는 차(또는 플레이어)의 뒷범퍼까지의 거리와 그 차의 속도 */
  function gapAhead(n: Npc, S: PlayerState, latShift = 0): { gap: number; speed: number } {
    const fx = Math.sin(n.h);
    const fz = Math.cos(n.h);
    const myFront = n.kind.length / 2;
    let best = Infinity;
    let speed = 0;
    const test = (ox: number, oz: number, oh: number | null, oHalf: number, ov: number) => {
      const dx = ox - n.x;
      const dz = oz - n.z;
      const fwd = dx * fx + dz * fz - myFront - oHalf;
      const cross = dx * fz - dz * fx;
      if (fwd <= -oHalf || fwd > 18 || Math.abs(cross + latShift) > 2.2) return;
      if (oh !== null && Math.sin(oh) * fx + Math.cos(oh) * fz < 0.3) return;
      if (fwd < best) {
        best = Math.max(0, fwd);
        speed = ov;
      }
    };
    for (const o of npcs) if (o !== n) test(o.x, o.z, o.h, o.kind.length / 2, o.speed);
    test(S.x, S.z, null, 2.1, Math.hypot(S.vx, S.vz));
    return { gap: best, speed };
  }

  /** 옆 차선으로 옮겨도 되는지 (앞뒤 14m 안에 같은 방향 차가 없는지) */
  function laneClear(n: Npc, S: PlayerState, targetLat: number): boolean {
    const fx = Math.sin(n.h);
    const fz = Math.cos(n.h);
    const shift = targetLat - n.lat;
    const blocked = (ox: number, oz: number, oh: number | null) => {
      const dx = ox - n.x;
      const dz = oz - n.z;
      const fwd = dx * fx + dz * fz;
      const cross = -(dx * fz - dz * fx); // 오른쪽이 +
      if (Math.abs(fwd) > 14 || Math.abs(cross - shift) > 2.2) return false;
      if (oh !== null && Math.sin(oh) * fx + Math.cos(oh) * fz < 0.3) return false;
      return true;
    };
    for (const o of npcs) if (o !== n && blocked(o.x, o.z, o.h)) return false;
    return !blocked(S.x, S.z, null);
  }

  function considerLaneChange(n: Npc, S: PlayerState, ahead: { gap: number; speed: number }): void {
    if (n.seg.c || n.laneCool > 0 || n.seg.len - n.s < 30) return;
    const cur = laneIndex(n.lat);
    if (Math.abs(n.latTarget - n.lat) > 0.05) return;
    const wantLane = laneIndex(n.latTarget);
    // 회전 차선 잡기: planNext 가 정한 latTarget 이 지금 차선과 다르면 비었을 때 옮긴다
    if (wantLane !== cur) {
      if (laneClear(n, S, n.latTarget)) n.laneCool = 3;
      else n.latTarget = n.lat; // 못 옮기면 일단 유지, 다음에 다시 시도
      return;
    }
    // 추월: 앞차가 내 순항 속도보다 느리면 옆 차선이 비었을 때 옮긴다
    const passing = n.racing ? ahead.gap < 30 : ahead.gap < 18 && ahead.speed < n.cruise - 2;
    if (!passing || n.nextDir !== n.dir) return;
    const other = LANES[1 - cur];
    if (n.kind.lane !== undefined && 1 - cur !== n.kind.lane && !n.racing) return;
    if (laneClear(n, S, other)) {
      n.latTarget = other;
      n.laneCool = n.racing ? 2 : 5;
    }
  }

  function signalWant(n: Npc): number {
    if (n.seg.c) return Infinity;
    const light = signals.state(n.to, n.dir);
    if (light === 'green') return Infinity;
    const remaining = n.seg.len - n.s - SIGNAL_STOP;
    if (light === 'yellow' && remaining < 10) return Infinity; // 황색에 가까우면 통과
    return Math.max(0, (remaining - 1) * 1.3);
  }

  return {
    npcs,
    police,

    update(dt, S, racePace, chasePace) {
      for (const n of npcs) {
        let want: number;
        const chasing = !!n.police?.chasing;
        if (n.racing || chasing) {
          const turnSoon = !n.seg.c && n.seg.len - n.s < 24 && n.nextDir !== n.dir;
          if (n.seg.c && n.seg.turn) want = 15;
          else if (turnSoon) want = 17;
          else if (chasing) {
            want = chasePace;
            const dx = S.x - n.x;
            const dz = S.z - n.z;
            const fwd = dx * Math.sin(n.h) + dz * Math.cos(n.h);
            const pv = Math.hypot(S.vx, S.vz);
            if (fwd > 0 && fwd < 16) want = Math.max(want, pv + 6);
            // 바짝 붙었으면 계속 들이받지 않고 속도를 맞춰 가둔다
            if (Math.hypot(dx, dz) < 7) want = Math.min(want, pv + 1.5);
          } else want = racePace(n);
          if (n.racing) considerLaneChange(n, S, gapAhead(n, S));
        } else {
          want = n.seg.turn ? Math.min(n.cruise, n.kind.turnSpeed) : n.cruise;
          const ahead = gapAhead(n, S);
          if (ahead.gap < 14) want = Math.min(want, Math.max(0, (ahead.gap - 4) * 1.4));
          want = Math.min(want, signalWant(n));
          considerLaneChange(n, S, ahead);
        }
        if (n.stun > 0) {
          n.stun -= dt;
          want = 0;
        }
        if (n.cool > 0) n.cool -= dt;
        if (n.laneCool > 0) n.laneCool -= dt;
        const heavy = n.kind.length > 8 ? 0.6 : 1;
        n.speed += (want - n.speed) * Math.min(1, dt * (want < n.speed ? 3 : 1.2) * heavy);
        n.s += n.speed * dt;
        while (n.s >= n.seg.len) {
          n.s -= n.seg.len;
          advanceSeg(n);
        }
        if (!n.seg.c) n.lat += clamp(n.latTarget - n.lat, -LANE_RATE * dt, LANE_RATE * dt);
        const [x, z] = positionOf(n);
        const mx = x - n.x;
        const mz = z - n.z;
        if (mx * mx + mz * mz > 1e-6) n.h = Math.atan2(mx, mz);
        n.x = x;
        n.z = z;
        n.mesh.position.set(x, 0, z);
        n.mesh.rotation.y = n.h;

        if (n.police) {
          const p = n.police;
          const glow = n.mesh.getObjectByName('policeGlow') as THREE.PointLight | undefined;
          if (p.chasing) {
            p.blink += dt * 8;
            const phase = Math.floor(p.blink) % 2 === 0;
            p.lights[0].visible = phase;
            p.lights[1].visible = !phase;
            if (glow) {
              glow.intensity = 1.6;
              glow.color.setHex(phase ? 0xff3a3a : 0x3a6bff);
            }
          } else {
            p.lights[0].visible = p.lights[1].visible = false;
            if (glow) glow.intensity = 0;
          }
        }
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
        const mass = n.kind.length > 8 ? 6 : n.kind.length > 6 ? 3 : 1;
        let touched = 0;
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
              touched = Math.max(touched, -rel);
            }
            if (n.racing || n.police?.chasing) n.speed *= 0.7;
            else n.stun = mass > 1 ? 0.8 : 1.6;
          }
        }
        if (touched > 2) ev.onHit(n, touched);
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

    assignRoute(n, goal) {
      n.route = g.route(n.to, goal);
      if (!n.seg.c) planNext(n);
    },

    setChase(count, playerNode) {
      const sorted = police
        .map((p) => ({ p, d: g.dist(p.to, playerNode) }))
        .sort((a, b) => a.d - b.d);
      sorted.forEach(({ p }, idx) => {
        const st = p.police!;
        const should = idx < count;
        if (should && !st.chasing) {
          st.chasing = true;
          st.routeTimer = 0;
        }
        if (!should && st.chasing) {
          st.chasing = false;
          p.route = [];
          if (!p.seg.c) planNext(p);
        }
        if (st.chasing) {
          st.routeTimer -= 1 / 60;
          if (st.routeTimer <= 0) {
            st.routeTimer = 1.5;
            p.route = g.route(p.to, playerNode);
            if (!p.seg.c) planNext(p);
          }
        }
      });
    },
  };
}
