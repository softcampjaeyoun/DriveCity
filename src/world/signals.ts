import * as THREE from 'three';
import { DIRS, EDGE, backOf } from '../config.ts';
import type { Node, RoadGraph } from './graph.ts';
import { rightOf } from './roads.ts';

export type Light = 'green' | 'yellow' | 'red';

/** 3갈래 이상 교차로의 신호. 남북(0,2)과 동서(1,3)가 번갈아 파란불 */
export interface Signals {
  has(i: number, j: number): boolean;
  /** 방향 d 로 진행해 교차로 node 에 진입하는 차가 보는 신호 */
  state(node: Node, d: number): Light;
  update(t: number): void;
}

const CYCLE = 22;
const GREEN = 8.5;
const YELLOW = 2.5;

export function createSignals(scene: THREE.Scene, g: RoadGraph): Signals {
  const offsets = new Map<number, number>();
  const key = (i: number, j: number) => i * 100 + j;
  const heads: Array<{ node: Node; d: number; last: Light | null }> = [];

  for (let i = 0; i < g.nx; i++) {
    for (let j = 0; j < g.nz; j++) {
      if (g.degree(i, j) < 3) continue;
      offsets.set(key(i, j), ((i * 7 + j * 13) % 4) * (CYCLE / 4));
      for (let d = 0; d < 4; d++) {
        if (!g.hasEdge(i, j, backOf(d))) continue;
        heads.push({ node: [i, j], d, last: null });
      }
    }
  }

  const phase = (i: number, j: number, t: number): [Light, Light] => {
    const p = (t + (offsets.get(key(i, j)) ?? 0)) % CYCLE;
    const half = CYCLE / 2;
    const inHalf = p % half;
    const active: Light = inHalf < GREEN ? 'green' : inHalf < GREEN + YELLOW ? 'yellow' : 'red';
    return p < half ? [active, 'red'] : ['red', active];
  };
  let now = 0;

  // ----- 시각: 기둥, 함체, 등 3개 -----
  const dummy = new THREE.Object3D();
  const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.12, 5.6, 6), new THREE.MeshLambertMaterial({ color: 0x2e323c }), heads.length);
  const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 3.2), new THREE.MeshLambertMaterial({ color: 0x2e323c }), heads.length);
  const boxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 1.3, 0.36), new THREE.MeshLambertMaterial({ color: 0x15171c }), heads.length);
  const lampGeo = new THREE.SphereGeometry(0.15, 10, 8);
  const lampMats = {
    red: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    yellow: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    green: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  const lampMesh = {
    red: new THREE.InstancedMesh(lampGeo, lampMats.red, heads.length),
    yellow: new THREE.InstancedMesh(lampGeo, lampMats.yellow, heads.length),
    green: new THREE.InstancedMesh(lampGeo, lampMats.green, heads.length),
  };
  const BRIGHT: Record<Light, number> = { red: 0xff3b3b, yellow: 0xffc73b, green: 0x3bff8a };
  const DIM: Record<Light, number> = { red: 0x3a0e0e, yellow: 0x3a2e0e, green: 0x0e3a1e };
  const col = new THREE.Color();

  heads.forEach((h, idx) => {
    const [nx, nz] = g.pos(h.node);
    const [dx, dz] = DIRS[h.d];
    const [rx, rz] = rightOf(h.d);
    // 운전자 기준 교차로 건너편 오른쪽 모서리, 도로 쪽으로 팔을 뻗어 등을 단다
    const px = nx + dx * (EDGE + 1.0) + rx * (EDGE + 1.0);
    const pz = nz + dz * (EDGE + 1.0) + rz * (EDGE + 1.0);
    const yaw = Math.atan2(dx, dz);
    dummy.rotation.set(0, yaw, 0);
    dummy.position.set(px, 2.8, pz);
    dummy.updateMatrix();
    poleMesh.setMatrixAt(idx, dummy.matrix);
    // 팔: 기둥에서 도로 안쪽(왼쪽)으로
    dummy.rotation.set(0, yaw + Math.PI / 2, 0);
    dummy.position.set(px - rx * 1.6, 5.5, pz - rz * 1.6);
    dummy.updateMatrix();
    armMesh.setMatrixAt(idx, dummy.matrix);
    const hx = px - rx * 3.2;
    const hz = pz - rz * 3.2;
    dummy.rotation.set(0, yaw, 0);
    dummy.position.set(hx, 5.0, hz);
    dummy.updateMatrix();
    boxMesh.setMatrixAt(idx, dummy.matrix);
    const lampY: Record<Light, number> = { red: 5.42, yellow: 5.0, green: 4.58 };
    for (const c of ['red', 'yellow', 'green'] as const) {
      dummy.position.set(hx - dx * 0.2, lampY[c], hz - dz * 0.2);
      dummy.updateMatrix();
      lampMesh[c].setMatrixAt(idx, dummy.matrix);
      lampMesh[c].setColorAt(idx, col.setHex(DIM[c]));
    }
  });
  dummy.rotation.set(0, 0, 0);
  scene.add(poleMesh, armMesh, boxMesh, lampMesh.red, lampMesh.yellow, lampMesh.green);

  const state = (node: Node, d: number): Light => {
    if (!offsets.has(key(node[0], node[1]))) return 'green';
    const [ns, ew] = phase(node[0], node[1], now);
    return d % 2 === 0 ? ns : ew;
  };

  return {
    has: (i, j) => offsets.has(key(i, j)),
    state,
    update(t) {
      now = t;
      let dirty = false;
      heads.forEach((h, idx) => {
        const s = state(h.node, h.d);
        if (s === h.last) return;
        h.last = s;
        dirty = true;
        for (const c of ['red', 'yellow', 'green'] as const) lampMesh[c].setColorAt(idx, col.setHex(c === s ? BRIGHT[c] : DIM[c]));
      });
      if (dirty) for (const c of ['red', 'yellow', 'green'] as const) if (lampMesh[c].instanceColor) lampMesh[c].instanceColor.needsUpdate = true;
    },
  };
}
