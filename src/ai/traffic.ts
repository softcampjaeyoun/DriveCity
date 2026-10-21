import * as THREE from 'three';
import { reduceMotion } from '../config.ts';
import { glowTexture, nameTag } from '../render/textures.ts';
import { clamp, rint } from '../util/math.ts';
import { KINDS, POLICE_COUNT, TRAFFIC_MIX, probesFor, type VehicleKind } from '../vehicle/kinds.ts';
import { swapModel } from '../vehicle/models.ts';
import { buildForKind, buildSedan } from '../vehicle/procedural.ts';
import { PROBE, RADIUS, type PlayerState } from '../vehicle/player.ts';
import type { Dir, Edge, Node, RoadGraph, Step } from '../world/graph.ts';
import { curveBetween, edgeSeg, segPos, turnOf, type EdgeSeg, type Seg } from '../world/roads.ts';
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
  seg: Seg;
  s: number;
  /** 지금 향하는(또는 통과 중인) 교차로 */
  node: Node;
  /** 교차로에서 갈 다음 간선. 직선 구간 시작 때 정한다 */
  next: Step | null;
  route: Step[];
  lane: number;
  /** 중심선에서 오른쪽 거리. 차선 변경 중엔 두 차선 사이 값 */
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
  /** 이 차를 낳은 타일. 타일이 내려가면 같이 사라진다. 라이벌·경찰은 null (항상 유지) */
  tile: string | null;
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
  /** 타일이 들어오면 그 타일 도로 길이에 비례해 차를 뿌린다 */
  addTile(key: string, roadLen: number, cx: number, cz: number): void;
  removeTile(key: string): void;
  update(dt: number, player: PlayerState, racePace: (n: Npc) => number, chasePace: number): void;
  collidePlayer(S: PlayerState): void;
  nearbyRival(S: PlayerState, range?: number): Npc | null;
  /** 라이벌·경찰에게 목적지까지 경로를 준다 */
  assignRoute(n: Npc, goal: Node): void;
  /** 수배 등급에 맞춰 경찰 몇 대가 추격할지 */
  setChase(count: number, playerNode: Node): void;
  /** 0 낮 .. 1 밤: 전조등·후미등 번짐 세기 */
  setNight(night: number): void;
}

const LANE_RATE = 2.2;

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
    // 밤 전조등·후미등 바닥 번짐. 밤에만 보이고 브레이크 때 후미등이 밝아진다
    const head = new THREE.Mesh(headGlowGeo, headGlowMat);
    head.position.set(0, 0.05, kind.length / 2 + 3.6);
    head.name = 'headGlow';
    const tail = new THREE.Mesh(tailGlowGeo, new THREE.MeshBasicMaterial({ map: tailTex, color: 0xff2a2a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    tail.position.set(0, 0.05, -kind.length / 2 - 1.1);
    tail.name = 'tailGlow';
    mesh.add(head, tail);
    const pool = kind.models;
    swapModel(mesh, visual, rival ? rival.model : pool?.length ? pool[index % pool.length] : undefined, kind.tintModel ? hex : undefined);
    scene.add(mesh);
    return { mesh, police };
  }
  const headGlowGeo = new THREE.PlaneGeometry(3.2, 8).rotateX(-Math.PI / 2);
  const tailGlowGeo = new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2);
  const headGlowMat = new THREE.MeshBasicMaterial({ map: glowTexture('rgba(255,240,200,0.55)'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const tailTex = glowTexture('rgba(255,80,80,0.6)');
  let nightK = 1;

  const npcs: Npc[] = [];
  const police: Npc[] = [];

  const edgeStartNode = (st: Step): Node => (st.dir === 1 ? st.e.a : st.e.b);
  const isReverse = (seg: EdgeSeg, e: Edge, dir: Dir) => seg.e.id === e.id && seg.dir !== dir;

  /** 교차로에서 갈 간선을 고른다. 경로가 있으면 따르고, 없으면 직진을 선호 */
  function chooseStep(n: Npc, seg: EdgeSeg): Step {
    const node = seg.node;
    const r = n.route[0];
    if (r && edgeStartNode(r) === node && g.hasEdge(r.e.id) && g.canTravel(r.e, r.dir)) {
      n.route.shift();
      return r;
    }
    n.route = [];
    const end = g.pointAt(seg.e, seg.dir, seg.e.len - 0.5);
    const opts: Array<{ st: Step; w: number }> = [];
    for (const e of g.edgesAt(node)) {
      const dir: Dir = e.a === node ? 1 : -1;
      if (!g.canTravel(e, dir) || isReverse(seg, e, dir)) continue;
      const start = g.pointAt(e, dir, Math.min(e.len - 0.5, g.cut(e, node) + 0.5));
      const dot = end.hx * start.hx + end.hz * start.hz;
      let w = dot > 0.7 ? 3 : dot > -0.5 ? 1 : 0.2;
      if (n.kind.length > 8 && e.rank >= 6) w *= 0.2; // 버스는 골목을 피한다
      if (n.kind.id !== 'police' && e.rank <= 1) w *= 0.6;
      opts.push({ st: { e, dir }, w });
    }
    if (!opts.length) {
      // 막다른 길(또는 아직 안 들어온 타일 경계): 유턴
      if (g.canTravel(seg.e, (seg.dir * -1) as Dir)) return { e: seg.e, dir: (seg.dir * -1) as Dir };
      const e = g.edgesAt(node)[0] ?? seg.e;
      return { e, dir: e.a === node ? 1 : -1 };
    }
    let total = opts.reduce((s, o) => s + o.w, 0);
    for (const o of opts) {
      total -= Math.random() * total < o.w ? total : 0;
      if (total <= 0) return o.st;
    }
    return opts[rint(opts.length)].st;
  }

  function turnFor(seg: EdgeSeg, st: Step) {
    const end = g.pointAt(seg.e, seg.dir, seg.s1);
    const start = g.pointAt(st.e, st.dir, Math.min(st.e.len - 0.5, g.cut(st.e, edgeStartNode(st)) + 0.5));
    return turnOf(end.hx, end.hz, start.hx, start.hz);
  }

  /** 직선 구간에 들어설 때 다음 방향과 그에 맞는 차선을 정한다 */
  function planNext(n: Npc, seg: EdgeSeg): void {
    n.next = chooseStep(n, seg);
    const lanes = g.lanes(seg.e, seg.dir);
    const turn = turnFor(seg, n.next);
    let lane = n.lane;
    if (turn === 'right') lane = lanes - 1;
    else if (turn === 'left' || turn === 'uturn') lane = 0;
    else if (n.kind.lane !== undefined) lane = n.kind.lane === 1 ? lanes - 1 : 0;
    lane = clamp(lane, 0, lanes - 1);
    n.latTarget = g.laneOffset(seg.e, seg.dir, lane);
  }

  function spawn(kind: VehicleKind, hex: number, rival: RivalSpec | null, index = 0, near?: { x: number; z: number; r: number }, tile: string | null = null): Npc {
    let e: Edge;
    let dir: Dir;
    let guard = 0;
    do {
      e = g.randomEdge(near);
      dir = Math.random() < 0.5 ? 1 : -1;
      if (!g.canTravel(e, dir)) dir = (dir * -1) as Dir;
    } while ((!g.canTravel(e, dir) || e.len < 20 || (kind.length > 8 && e.rank >= 6)) && guard++ < 200);
    const seg = edgeSeg(g, e, dir);
    const lanes = g.lanes(e, dir);
    const lane = kind.lane === 1 ? lanes - 1 : kind.lane === 0 ? 0 : rint(lanes);
    const [c0, c1] = kind.cruise;
    const built = buildMesh(kind, hex, rival, index);
    const n: Npc = {
      mesh: built.mesh,
      kind,
      probes: probesFor(kind.length),
      radius: kind.width / 2 + 0.15,
      seg,
      s: seg.s0 + Math.random() * seg.len,
      node: seg.node,
      next: null,
      route: [],
      lane,
      lat: g.laneOffset(e, dir, lane),
      latTarget: 0,
      laneCool: Math.random() * 4,
      speed: 0,
      cruise: c0 + Math.random() * (c1 - c0),
      stun: 0,
      x: 0,
      z: 0,
      h: 0,
      rival,
      racing: false,
      cool: 0,
      police: built.police,
      tile,
    };
    n.latTarget = n.lat;
    planNext(n, seg);
    [n.x, n.z] = segPos(g, seg, n.s, n.lat);
    const p = g.pointAt(e, dir, n.s);
    n.h = Math.atan2(p.hx, p.hz);
    n.mesh.position.set(n.x, 0, n.z);
    n.mesh.rotation.y = n.h;
    npcs.push(n);
    return n;
  }
  function despawn(n: Npc): void {
    const i = npcs.indexOf(n);
    if (i >= 0) npcs.splice(i, 1);
    scene.remove(n.mesh);
  }
  /** 차가 서 있던 길이 사라졌을 때(타일 해제) 플레이어 근처 로드된 길로 옮긴다 */
  function relocate(n: Npc, S: PlayerState): void {
    let e: Edge;
    let dir: Dir;
    let guard = 0;
    do {
      e = g.randomEdge({ x: S.x, z: S.z, r: 700 });
      dir = Math.random() < 0.5 ? 1 : -1;
      if (!g.canTravel(e, dir)) dir = (dir * -1) as Dir;
    } while ((!g.canTravel(e, dir) || e.len < 20 || Math.hypot(e.pts[0] - S.x, e.pts[1] - S.z) < 120) && guard++ < 100);
    const seg = edgeSeg(g, e, dir);
    n.seg = seg;
    n.s = seg.s0 + Math.random() * seg.len;
    n.node = seg.node;
    n.route = [];
    n.next = null;
    n.lane = clamp(n.lane, 0, g.lanes(e, dir) - 1);
    n.lat = n.latTarget = g.laneOffset(e, dir, n.lane);
    planNext(n, seg);
    [n.x, n.z] = segPos(g, seg, n.s, n.lat);
    n.mesh.position.set(n.x, 0, n.z);
  }
  let persistentSpawned = false;
  const DENSITY = 1.5; // 도로 1km 당 차량 대수 (3×3 타일 기준 300대 안팎)

  function advance(n: Npc): void {
    if (n.seg.kind === 'curve') {
      const st = n.next!;
      const seg = edgeSeg(g, st.e, st.dir);
      n.seg = seg;
      n.s = seg.s0;
      n.node = seg.node;
      n.lat = n.latTarget = g.laneOffset(st.e, st.dir, n.lane);
      planNext(n, seg);
      return;
    }
    const seg = n.seg;
    const st = n.next ?? chooseStep(n, seg);
    const turn = turnFor(seg, st);
    const outLanes = g.lanes(st.e, st.dir);
    const laneOut = turn === 'right' ? outLanes - 1 : turn === 'straight' ? clamp(n.lane, 0, outLanes - 1) : 0;
    const from = g.pointAt(seg.e, seg.dir, seg.s1);
    const toSeg = edgeSeg(g, st.e, st.dir);
    const to = g.pointAt(st.e, st.dir, toSeg.s0);
    const latOut = g.laneOffset(st.e, st.dir, laneOut);
    n.seg = curveBetween(from, n.lat, to, latOut);
    n.s = 0;
    n.lane = laneOut;
    n.next = st;
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
      if (Math.abs(dx) > 24 || Math.abs(dz) > 24) return;
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
      if (Math.abs(dx) > 16 || Math.abs(dz) > 16) return false;
      const fwd = dx * fx + dz * fz;
      const cross = -(dx * fz - dz * fx);
      if (Math.abs(fwd) > 14 || Math.abs(cross - shift) > 2.2) return false;
      if (oh !== null && Math.sin(oh) * fx + Math.cos(oh) * fz < 0.3) return false;
      return true;
    };
    for (const o of npcs) if (o !== n && blocked(o.x, o.z, o.h)) return false;
    return !blocked(S.x, S.z, null);
  }

  function considerLaneChange(n: Npc, S: PlayerState, ahead: { gap: number; speed: number }): void {
    if (n.seg.kind !== 'edge' || n.laneCool > 0 || n.seg.s1 - n.s < 30) return;
    const lanes = g.lanes(n.seg.e, n.seg.dir);
    if (lanes < 2) return;
    if (Math.abs(n.latTarget - n.lat) > 0.05) return;
    const wantLat = n.latTarget;
    const curLat = g.laneOffset(n.seg.e, n.seg.dir, n.lane);
    // 회전 차선 잡기: planNext 가 정한 latTarget 이 지금 차선과 다르면 비었을 때 옮긴다
    if (Math.abs(wantLat - curLat) > 0.1) {
      if (laneClear(n, S, wantLat)) {
        n.laneCool = 3;
        n.lane = Math.round((wantLat - g.laneOffset(n.seg.e, n.seg.dir, 0)) / n.seg.e.laneW);
      } else n.latTarget = curLat;
      return;
    }
    const passing = n.racing ? ahead.gap < 30 : ahead.gap < 18 && ahead.speed < n.cruise - 2;
    if (!passing) return;
    const other = n.lane + 1 < lanes ? n.lane + 1 : n.lane - 1;
    if (n.kind.lane !== undefined && !n.racing) return;
    const otherLat = g.laneOffset(n.seg.e, n.seg.dir, other);
    if (laneClear(n, S, otherLat)) {
      n.lane = other;
      n.latTarget = otherLat;
      n.laneCool = n.racing ? 2 : 5;
    }
  }

  function signalWant(n: Npc): number {
    if (n.seg.kind !== 'edge' || !signals.has(n.seg.node)) return Infinity;
    const light = signals.state(n.seg.node, n.seg.e, n.seg.dir);
    if (light === 'green') return Infinity;
    const remaining = n.seg.s1 - n.s - 1.2;
    if (light === 'yellow' && remaining < 10) return Infinity;
    return Math.max(0, (remaining - 0.5) * 1.3);
  }

  /** 신호 없는 교차로: 다른 길에서 먼저 들어온 차가 있으면 양보 */
  function yieldWant(n: Npc): number {
    if (n.seg.kind !== 'edge' || signals.has(n.seg.node)) return Infinity;
    const remaining = n.seg.s1 - n.s;
    if (remaining > 12) return Infinity;
    const [nx, nz] = g.pos(n.seg.node);
    for (const o of npcs) {
      if (o === n || Math.abs(o.x - nx) > 10 || Math.abs(o.z - nz) > 10) continue;
      const sameEdge = o.seg.kind === 'edge' && o.seg.e.id === n.seg.e.id;
      if (sameEdge) continue;
      if (o.seg.kind === 'curve' || (o.seg.kind === 'edge' && o.seg.node === n.seg.node && o.seg.s1 - o.s < remaining)) return Math.max(0, (remaining - 3) * 0.8);
    }
    return Infinity;
  }

  return {
    npcs,
    police,

    addTile(key, roadLen, cx, cz) {
      const near = { x: cx, z: cz, r: 760 };
      const total = Math.round((roadLen / 1000) * DENSITY);
      const mixTotal = TRAFFIC_MIX.reduce((s, [, c]) => s + c, 0);
      let i = 0;
      for (const [id, count] of TRAFFIC_MIX) {
        const kind = KINDS[id];
        const n = Math.round((total * count) / mixTotal);
        for (let k = 0; k < n; k++) spawn(kind, kind.colors[(i + k) % kind.colors.length], null, i + k, near, key);
        i += n;
      }
      if (!persistentSpawned) {
        persistentSpawned = true;
        for (const r of RIVALS) spawn(KINDS.rival, r.body, r, 0, near);
        for (let k = 0; k < POLICE_COUNT; k++) police.push(spawn(KINDS.police, KINDS.police.colors[0], null, k, near));
      }
    },

    removeTile(key) {
      for (const n of npcs.slice()) if (n.tile === key) despawn(n);
    },

    update(dt, S, racePace, chasePace) {
      for (const n of npcs.slice()) {
        // 서 있는 길이 사라졌으면(타일 해제) 일반 차는 없애고, 라이벌·경찰은 옮긴다
        const curEdge = n.seg.kind === 'edge' ? n.seg.e : n.next?.e;
        if (curEdge && !g.hasEdge(curEdge.id)) {
          if (n.tile !== null) {
            despawn(n);
            continue;
          }
          relocate(n, S);
        }
        if (n.next && !g.hasEdge(n.next.e.id)) {
          n.next = null;
          n.route = [];
          if (n.seg.kind === 'edge') planNext(n, n.seg);
        }
        let want: number;
        const chasing = !!n.police?.chasing;
        const onCurve = n.seg.kind === 'curve';
        const turning = onCurve && n.seg.kind === 'curve' && n.seg.turn !== 'straight';
        if (n.racing || chasing) {
          const turnSoon = n.seg.kind === 'edge' && n.seg.s1 - n.s < 24 && n.next && turnFor(n.seg, n.next) !== 'straight';
          if (turning) want = 15;
          else if (turnSoon) want = 17;
          else if (chasing) {
            want = chasePace;
            const dx = S.x - n.x;
            const dz = S.z - n.z;
            const fwd = dx * Math.sin(n.h) + dz * Math.cos(n.h);
            const pv = Math.hypot(S.vx, S.vz);
            if (fwd > 0 && fwd < 16) want = Math.max(want, pv + 6);
            if (Math.hypot(dx, dz) < 7) want = Math.min(want, pv + 1.5);
          } else want = racePace(n);
          if (n.racing) considerLaneChange(n, S, gapAhead(n, S));
        } else {
          want = turning ? Math.min(n.cruise, n.kind.turnSpeed) : n.cruise;
          if (n.seg.kind === 'edge' && n.seg.e.rank >= 6) want = Math.min(want, 9);
          const ahead = gapAhead(n, S);
          if (ahead.gap < 14) want = Math.min(want, Math.max(0, (ahead.gap - 4) * 1.4));
          want = Math.min(want, signalWant(n), yieldWant(n));
          considerLaneChange(n, S, ahead);
        }
        if (n.stun > 0) {
          n.stun -= dt;
          want = 0;
        }
        if (n.cool > 0) n.cool -= dt;
        if (n.laneCool > 0) n.laneCool -= dt;
        const heavy = n.kind.length > 8 ? 0.6 : 1;
        const braking = want < n.speed - 0.5;
        n.speed += (want - n.speed) * Math.min(1, dt * (want < n.speed ? 3 : 1.2) * heavy);
        const tail = n.mesh.getObjectByName('tailGlow') as THREE.Mesh | undefined;
        if (tail) (tail.material as THREE.MeshBasicMaterial).opacity = braking ? 0.35 + 0.5 * nightK : 0.4 * nightK;
        n.s += n.speed * dt;
        let guard = 0;
        while (guard++ < 4) {
          const end = n.seg.kind === 'edge' ? n.seg.s1 : n.seg.len;
          if (n.s < end) break;
          const over = n.s - end;
          advance(n);
          n.s += over;
        }
        if (n.seg.kind === 'edge') n.lat += clamp(n.latTarget - n.lat, -LANE_RATE * dt, LANE_RATE * dt);
        const [x, z] = segPos(g, n.seg, n.s, n.lat);
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
      n.route = g.route(n.node, goal);
      if (n.seg.kind === 'edge') planNext(n, n.seg);
    },

    setNight(night) {
      nightK = night;
      headGlowMat.opacity = night;
    },

    setChase(count, playerNode) {
      const sorted = police.map((p) => ({ p, d: Math.hypot(p.x - g.pos(playerNode)[0], p.z - g.pos(playerNode)[1]) })).sort((a, b) => a.d - b.d);
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
          if (p.seg.kind === 'edge') planNext(p, p.seg);
        }
        if (st.chasing) {
          st.routeTimer -= 1 / 60;
          if (st.routeTimer <= 0) {
            st.routeTimer = 2;
            this.assignRoute(p, playerNode);
          }
        }
      });
    },
  };
}
