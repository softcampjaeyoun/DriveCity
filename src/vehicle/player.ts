import * as THREE from 'three';
import { reduceMotion } from '../config.ts';
import type { Input } from '../input.ts';
import { glowTexture } from '../render/textures.ts';
import { clamp } from '../util/math.ts';
import type { CollisionWorld } from '../world/collision.ts';
import type { RoadGraph } from '../world/graph.ts';
import { swapModel } from './models.ts';
import type { CarStats } from './stats.ts';
import { createSkids } from './skids.ts';

export interface PlayerState {
  x: number;
  z: number;
  /** 노면 높이 (고가 위 +, 지하차도 -) */
  y: number;
  /** 진행 방향 (rad). sin → x, cos → z */
  h: number;
  /** 경사 피치 (rad, 오르막 +) */
  pitch: number;
  vx: number;
  vz: number;
  steer: number;
  nitro: number;
  shake: number;
  wheelSpin: number;
}

export interface StepResult {
  /** 전방 속도 m/s */
  vf: number;
  /** 측면 속도 m/s. 클수록 미끄러지는 중 */
  vl: number;
  boosting: boolean;
  drifting: boolean;
}

export interface Player {
  S: PlayerState;
  group: THREE.Group;
  driftScore: number;
  driftTimer: number;
  step(dt: number, inp: Input, stats: CarStats, world: CollisionWorld, after: () => void): StepResult;
  applyVisual(r: StepResult, inp: Input, dt: number): void;
  setPaint(hex: string): void;
  setGlow(hex: string): void;
  setFlash(v: number): void;
  /** 등록된 glb 모델로 교체. 없으면 상자 모델로 돌아간다 */
  setModel(id: string | undefined): void;
  /** 가장 가까운 교차로로 되돌린다 */
  reset(): void;
  /** 이번 프레임에 강에 빠졌는지 */
  fell: boolean;
  /** 이번 프레임 빌딩·경계 충돌 세기 (m/s). 0 이면 없음 */
  crash: number;
}

/** 차 중심에서 앞/뒤로 떨어진 충돌 원 2개 */
export const PROBE: readonly number[] = [1.3, -1.3];
export const RADIUS = 1.15;

export function createPlayer(scene: THREE.Scene, g: RoadGraph): Player {
  const S: PlayerState = { x: g.index.start.x, z: g.index.start.z, y: 0, h: 0, pitch: 0, vx: 0, vz: 0, steer: 0, nitro: 0.6, shake: 0, wheelSpin: 0 };
  const bounds = { minX: g.bbox.minX + 1.3, maxX: g.bbox.maxX - 1.3, minZ: g.bbox.minZ + 1.3, maxZ: g.bbox.maxZ - 1.3 };
  // 시작 교차로에서 큰길 방향을 보고 차선 위에 놓는다
  {
    const edges = g.edgesAt(g.start).slice().sort((a, b) => a.rank - b.rank);
    const e = edges[0];
    if (e) {
      const dir = e.a === g.start ? 1 : -1;
      const p = g.pointAt(e, g.canTravel(e, dir) ? dir : ((dir * -1) as 1 | -1), Math.min(e.len * 0.5, g.cut(e, g.start) + 8));
      S.x = p.x - p.hz * g.laneOffset(e, 1, 0);
      S.z = p.z + p.hx * g.laneOffset(e, 1, 0);
      S.y = p.y;
      S.h = Math.atan2(p.hx, p.hz);
    }
  }
  const skids = createSkids(scene);

  // ----- 모델 -----
  const group = new THREE.Group();
  // 요(진행 방향) 먼저, 그 다음 경사 피치
  group.rotation.order = 'YXZ';
  // fallback 아래에 상자 모델 전부. 외부 모델이 오면 fallback 만 숨긴다
  const fallback = new THREE.Group();
  fallback.name = 'fallback';
  group.add(fallback);
  const body = new THREE.Group();
  fallback.add(body);
  // 도장은 클리어코트(하늘·가로등이 비친다), 유리·스포일러는 매끈한 검정
  const paint = new THREE.MeshPhysicalMaterial({ color: 0xe8394a, roughness: 0.3, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x0c0e14, roughness: 0.12, metalness: 0.6 });
  const lower = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 4.3), paint);
  lower.position.y = 0.68;
  lower.castShadow = true;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.48, 2.0), dark);
  cabin.position.set(0, 1.18, -0.25);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.3), paint);
  hood.position.set(0, 0.99, 1.35);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.08, 0.42), dark);
  spoiler.position.set(0, 1.32, -2.0);
  const strutGeo = new THREE.BoxGeometry(0.08, 0.36, 0.12);
  const s1 = new THREE.Mesh(strutGeo, dark);
  s1.position.set(0.6, 1.12, -2.0);
  const s2 = s1.clone();
  s2.position.x = -0.6;
  body.add(lower, cabin, hood, spoiler, s1, s2);

  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0x8a0f18 });
  for (const sx of [-0.65, 0.65]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.05), headMat);
    h.position.set(sx, 0.78, 2.16);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.05), tailMat);
    t.position.set(sx, 0.82, -2.16);
    body.add(h, t);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.32, 18).rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111216 });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0x9aa3b5 });
  const rimGeo = new THREE.BoxGeometry(0.34, 0.5, 0.08);
  const wheels: THREE.Mesh[] = [];
  const frontPivots: THREE.Group[] = [];
  for (const [x, z] of [
    [-0.98, 1.35],
    [0.98, 1.35],
    [-0.98, -1.35],
    [0.98, -1.35],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.38, z);
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.add(new THREE.Mesh(rimGeo, rimMat));
    pivot.add(w);
    fallback.add(pivot);
    wheels.push(w);
    if (z > 0) frontPivots.push(pivot);
  }

  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTexture('rgba(255,255,255,0.7)'),
    color: 0x4fd1ff,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 6).rotateX(-Math.PI / 2), glowMat);
  glow.position.y = 0.04;
  group.add(glow);
  const underLight = new THREE.PointLight(0x4fd1ff, 1.3, 9);
  underLight.position.set(0, 0.4, 0);
  group.add(underLight);
  const headLight = new THREE.SpotLight(0xfff1d0, 2.4, 75, 0.48, 0.6, 1);
  headLight.position.set(0, 0.85, 2.0);
  headLight.target.position.set(0, 0, 22);
  group.add(headLight, headLight.target);
  scene.add(group);

  // ----- 충돌 (건물 폴리곤, 물, 맵 경계) -----
  function collide(world: CollisionWorld): void {
    const fx = Math.sin(S.h);
    const fz = Math.cos(S.h);
    let hit = 0;
    for (const off of PROBE) {
      for (let iter = 0; iter < 2; iter++) {
        const r = world.push({ x: S.x + fx * off, z: S.z + fz * off, r: RADIUS, y: S.y });
        if (!r) break;
        S.x += r.dx;
        S.z += r.dz;
        const vn = S.vx * r.nx + S.vz * r.nz;
        if (vn < 0) {
          S.vx -= 1.25 * vn * r.nx;
          S.vz -= 1.25 * vn * r.nz;
          S.vx *= 0.82;
          S.vz *= 0.82;
          hit = Math.max(hit, -vn);
        }
      }
    }
    if (world.inWater(S.x, S.z, S.y)) player.fell = true;
    for (const axis of ['x', 'z'] as const) {
      const v = axis === 'x' ? 'vx' : 'vz';
      const lo = axis === 'x' ? bounds.minX : bounds.minZ;
      const hi = axis === 'x' ? bounds.maxX : bounds.maxZ;
      if (S[axis] < lo || S[axis] > hi) {
        hit = Math.max(hit, Math.abs(S[v]));
        S[axis] = clamp(S[axis], lo, hi);
        S[v] *= -0.3;
      }
    }
    player.crash = hit;
    if (hit > 3 && !reduceMotion) S.shake = Math.min(1, S.shake + hit / 25);
  }

  let lastDrift = false;
  const player: Player = {
    S,
    group,
    driftScore: 0,
    driftTimer: 0,
    fell: false,
    crash: 0,

    step(dt, inp, st, world, after) {
      player.fell = false;
      const fx = Math.sin(S.h);
      const fz = Math.cos(S.h);
      const lx = Math.cos(S.h);
      const lz = -Math.sin(S.h);
      let vf = S.vx * fx + S.vz * fz;
      let vl = S.vx * lx + S.vz * lz;

      // 경사: 앞뒤 2.2m 노면 높이차. 오르막은 느려지고 내리막은 빨라진다
      const yAhead = g.groundAt(S.x + fx * 2.2, S.z + fz * 2.2, S.y);
      const yBehind = g.groundAt(S.x - fx * 2.2, S.z - fz * 2.2, S.y);
      const slope = clamp((yAhead - yBehind) / 4.4, -0.2, 0.2);
      vf -= 9.81 * slope * 0.7 * dt;

      const boosting = inp.nitro && S.nitro > 0.01 && inp.up;
      const vmax = boosting ? st.nitroVmax : st.vmax;
      if (boosting) S.nitro = Math.max(0, S.nitro - dt * st.nitroDrain);

      if (inp.up) {
        if (vf < 0) vf += st.brake * dt;
        else vf += (st.accel + (boosting ? st.nitroAccel : 0)) * Math.max(0, 1 - (vf / vmax) ** 2) * dt;
      }
      if (inp.down) {
        if (vf > 0.5) vf -= st.brake * dt;
        else vf = Math.max(-st.revMax, vf - st.accel * 0.6 * dt);
      }
      if (!inp.up && !inp.down) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 3.2 * dt);
      vf -= vf * 0.07 * dt;
      if (vf > vmax) vf -= (vf - vmax) * 1.5 * dt;
      if (inp.hb) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), Math.abs(vl) * 0.22 * dt);

      const grip = inp.hb ? st.hbGrip : Math.abs(vl) > 4 ? st.grip * 0.45 : st.grip;
      vl *= Math.exp(-grip * dt);

      const steerIn = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
      S.steer += (steerIn - S.steer) * Math.min(1, dt * (steerIn ? 6 : 9));
      const low = clamp(Math.abs(vf) / 6, 0, 1);
      const high = 1 - 0.5 * Math.min(Math.abs(vf) / st.vmax, 1);
      const yaw = S.steer * st.maxYaw * low * high * Math.sign(vf || 1) * (inp.hb ? 1.4 : 1);
      S.h += yaw * dt;

      S.vx = fx * vf + lx * vl;
      S.vz = fz * vf + lz * vl;
      S.x += S.vx * dt;
      S.z += S.vz * dt;
      collide(world);
      after();
      // 노면 높이를 따라간다. 순간이동처럼 크게 다르면 바로 맞춘다
      const gy = g.groundAt(S.x, S.z, S.y);
      const dy = gy - S.y;
      S.y += Math.abs(dy) > 3 ? dy : dy * Math.min(1, dt * 12);
      S.pitch += (Math.atan(slope) - S.pitch) * Math.min(1, dt * 6);

      const drifting = Math.abs(vl) > 3.2 && Math.abs(vf) > 8;
      if (drifting) {
        S.nitro = Math.min(1, S.nitro + dt * st.nitroGain);
        player.driftScore += Math.abs(vl) * dt * 10;
        player.driftTimer = 0.6;
        for (const side of [-0.95, 0.95]) skids.add(S.x - fx * 1.35 + lx * side, S.z - fz * 1.35 + lz * side, S.h, S.y);
      } else {
        S.nitro = Math.min(1, S.nitro + dt * 0.02);
        player.driftTimer -= dt;
        if (player.driftTimer <= 0 && !lastDrift) player.driftScore = 0;
      }
      lastDrift = drifting;
      return { vf, vl, boosting, drifting };
    },

    applyVisual(r, inp, dt) {
      group.position.set(S.x, S.y, S.z);
      group.rotation.y = S.h;
      group.rotation.x = -S.pitch;
      body.rotation.z = clamp(-r.vl * 0.012, -0.08, 0.08);
      body.rotation.x = clamp((inp.down ? 0.03 : 0) - (inp.up ? 0.02 : 0), -0.05, 0.05);
      S.wheelSpin += (r.vf * dt) / 0.38;
      for (const w of wheels) w.rotation.x = S.wheelSpin;
      for (const p of frontPivots) p.rotation.y = S.steer * 0.5;
      tailMat.color.setHex(inp.down || inp.hb ? 0xff2436 : 0x8a0f18);
      glowMat.opacity = r.boosting ? 1 : 0.75;
    },

    setPaint(hex) {
      paint.color.set(hex);
    },
    setGlow(hex) {
      glowMat.color.set(hex);
      underLight.color.set(hex);
    },
    setFlash(v) {
      headLight.intensity = 2.4 + v * 6;
    },
    setModel(id) {
      const prev = group.getObjectByName('model');
      if (prev) group.remove(prev);
      fallback.visible = true;
      swapModel(group, fallback, id);
    },
    reset() {
      // 가장 가까운 길 위로, 그 길 방향을 보고
      const hit = g.nearestEdge(S.x, S.z, 120);
      if (hit) {
        const dir = hit.side >= 0 ? 1 : -1;
        const p = g.pointAt(hit.e, dir, dir === 1 ? hit.s : hit.e.len - hit.s);
        const lat = g.laneOffset(hit.e, dir, 0);
        S.x = p.x - p.hz * lat;
        S.z = p.z + p.hx * lat;
        S.y = p.y;
        S.h = Math.atan2(p.hx, p.hz);
      } else {
        const n = g.nearestNode(S.x, S.z);
        [S.x, S.z] = g.pos(n);
        S.y = g.posY(n);
      }
      S.pitch = 0;
      S.vx = S.vz = 0;
      S.steer = 0;
    },
  };
  return player;
}
