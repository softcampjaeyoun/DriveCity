import * as THREE from 'three';
import type { Dir, Edge, Node, RoadGraph } from './graph.ts';
import { rightOf } from './roads.ts';

export type Light = 'green' | 'yellow' | 'red';

/**
 * 교차로 신호. OSM 신호등 노드 + 큰길이 만나는 3갈래 이상 교차로.
 * 진입 방향을 평행한 두 묶음으로 나눠 번갈아 파란불.
 */
export interface Signals {
  /** 신호등 기둥 위치 (충돌용) */
  poles: Array<[number, number]>;
  has(n: Node): boolean;
  /** 간선 e 를 dir 방향으로 달려 교차로 n 에 들어가는 차가 보는 신호 */
  state(n: Node, e: Edge, dir: Dir): Light;
  update(t: number): void;
}

const CYCLE = 24;
const GREEN = 9;
const YELLOW = 3;

interface Head {
  node: Node;
  edgeId: number;
  group: 0 | 1;
  last: Light | null;
}

export function createSignals(scene: THREE.Scene, g: RoadGraph): Signals {
  const offsets = new Map<Node, number>();
  const groupOf = new Map<string, 0 | 1>(); // `${node}:${edgeId}`
  const heads: Head[] = [];
  const key = (n: Node, e: number) => `${n}:${e}`;

  const signalNodes = new Set<Node>(g.map.signals);
  for (const n of g.majorNodes) {
    const es = g.edgesAt(n);
    // 자동차전용도로(motorway·trunk) 분기점은 입체교차라 신호가 없다
    if (es.some((e) => e.rank <= 1)) continue;
    // 큰길(primary~tertiary, 램프 제외)이 2개 이상 만나면 신호가 있다고 본다
    const big = es.filter((e) => !e.link && (e.rank <= 4 || e.lf + e.lb >= 3)).length;
    if (big >= 2 && g.degree(n) >= 3) signalNodes.add(n);
  }

  for (const n of signalNodes) {
    const approaches = g.edgesAt(n).filter((e) => g.canTravel(e, g.dirInto(e, n)));
    if (approaches.length < 2) continue;
    offsets.set(n, ((n * 7919) % 6) * (CYCLE / 6));
    const ref = g.pointAt(approaches[0], g.dirInto(approaches[0], n), approaches[0].len - 0.5);
    for (const e of approaches) {
      const p = g.pointAt(e, g.dirInto(e, n), e.len - 0.5);
      const parallel = Math.abs(p.hx * ref.hx + p.hz * ref.hz) > 0.5;
      const group: 0 | 1 = parallel ? 0 : 1;
      groupOf.set(key(n, e.id), group);
      heads.push({ node: n, edgeId: e.id, group, last: null });
    }
  }

  const phase = (n: Node, t: number): [Light, Light] => {
    const p = (t + (offsets.get(n) ?? 0)) % CYCLE;
    const half = CYCLE / 2;
    const inHalf = p % half;
    const active: Light = inHalf < GREEN ? 'green' : inHalf < GREEN + YELLOW ? 'yellow' : 'red';
    return p < half ? [active, 'red'] : ['red', active];
  };
  let now = 0;

  // ----- 시각: 기둥, 팔, 함체, 등 3개 -----
  const dummy = new THREE.Object3D();
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x2e323c });
  const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.12, 5.6, 6), poleMat, heads.length);
  const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 1), poleMat, heads.length);
  const boxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 1.3, 0.36), new THREE.MeshLambertMaterial({ color: 0x15171c }), heads.length);
  const lampGeo = new THREE.SphereGeometry(0.15, 10, 8);
  const lampMesh = {
    red: new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), heads.length),
    yellow: new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), heads.length),
    green: new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), heads.length),
  };
  const BRIGHT: Record<Light, number> = { red: 0xff3b3b, yellow: 0xffc73b, green: 0x3bff8a };
  const DIM: Record<Light, number> = { red: 0x3a0e0e, yellow: 0x3a2e0e, green: 0x0e3a1e };
  const col = new THREE.Color();
  const poles: Array<[number, number]> = [];

  heads.forEach((h, idx) => {
    const e = g.edges[h.edgeId];
    const dir = g.dirInto(e, h.node);
    const p = g.pointAt(e, dir, e.len - 0.5);
    const [rx, rz] = rightOf(p.hx, p.hz);
    const [nx, nz] = g.pos(h.node);
    // 운전자 기준 교차로 건너편 오른쪽 모서리에 기둥, 팔은 도로 안쪽으로
    const cross = g.cut(e, h.node) + 1.5;
    const px = nx + p.hx * cross + rx * (e.half + 1.2);
    const pz = nz + p.hz * cross + rz * (e.half + 1.2);
    const yaw = Math.atan2(p.hx, p.hz);
    const armLen = Math.min(e.half + 0.5, 7);
    poles.push([px, pz]);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.position.set(px, 2.8, pz);
    dummy.updateMatrix();
    poleMesh.setMatrixAt(idx, dummy.matrix);
    dummy.rotation.set(0, yaw + Math.PI / 2, 0);
    dummy.scale.set(1, 1, armLen);
    dummy.position.set(px - rx * (armLen / 2), 5.5, pz - rz * (armLen / 2));
    dummy.updateMatrix();
    armMesh.setMatrixAt(idx, dummy.matrix);
    dummy.scale.set(1, 1, 1);
    const hx = px - rx * armLen;
    const hz = pz - rz * armLen;
    dummy.rotation.set(0, yaw, 0);
    dummy.position.set(hx, 5.0, hz);
    dummy.updateMatrix();
    boxMesh.setMatrixAt(idx, dummy.matrix);
    const lampY: Record<Light, number> = { red: 5.42, yellow: 5.0, green: 4.58 };
    for (const c of ['red', 'yellow', 'green'] as const) {
      dummy.position.set(hx - p.hx * 0.2, lampY[c], hz - p.hz * 0.2);
      dummy.updateMatrix();
      lampMesh[c].setMatrixAt(idx, dummy.matrix);
      lampMesh[c].setColorAt(idx, col.setHex(DIM[c]));
    }
  });
  dummy.rotation.set(0, 0, 0);
  scene.add(poleMesh, armMesh, boxMesh, lampMesh.red, lampMesh.yellow, lampMesh.green);

  const state = (n: Node, e: Edge, _dir: Dir): Light => {
    const grp = groupOf.get(key(n, e.id));
    if (grp === undefined) return 'green';
    const [a, b] = phase(n, now);
    return grp === 0 ? a : b;
  };

  return {
    poles,
    has: (n) => offsets.has(n),
    state,
    update(t) {
      now = t;
      let dirty = false;
      heads.forEach((h, idx) => {
        const s = state(h.node, g.edges[h.edgeId], 1);
        if (s === h.last) return;
        h.last = s;
        dirty = true;
        for (const c of ['red', 'yellow', 'green'] as const) lampMesh[c].setColorAt(idx, col.setHex(c === s ? BRIGHT[c] : DIM[c]));
      });
      if (dirty) for (const c of ['red', 'yellow', 'green'] as const) if (lampMesh[c].instanceColor) lampMesh[c].instanceColor.needsUpdate = true;
    },
  };
}
