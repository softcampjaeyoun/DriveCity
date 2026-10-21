import * as THREE from 'three';
import type { Dir, Edge, Node, RoadGraph } from './graph.ts';
import type { TileData } from './mapdata.ts';
import { rightOf } from './roads.ts';

export type Light = 'green' | 'yellow' | 'red';

/**
 * 교차로 신호. OSM 신호등 노드 + 큰길이 만나는 3갈래 이상 교차로.
 * 진입 방향을 평행한 두 묶음으로 나눠 번갈아 파란불. 타일 단위로 만들고 지운다.
 */
export interface Signals {
  has(n: Node): boolean;
  /** 간선 e 를 dir 방향으로 달려 교차로 n 에 들어가는 차가 보는 신호 */
  state(n: Node, e: Edge, dir: Dir): Light;
  /** 횡단보도(차량 신호와 반대) */
  walkState(n: Node, e: Edge): Light;
  addTile(key: string, tile: TileData): Array<[number, number]>;
  removeTile(key: string): void;
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
  walkLast: Light | null;
}
interface TileSignals {
  heads: Head[];
  meshes: THREE.Object3D[];
  lamp: Record<Light, THREE.InstancedMesh>;
  walk: Record<'red' | 'green', THREE.InstancedMesh>;
  nodes: Node[];
}

export function createSignals(scene: THREE.Scene, g: RoadGraph): Signals {
  const offsets = new Map<Node, number>();
  const groupOf = new Map<string, 0 | 1>();
  const key = (n: Node, e: number) => `${n}:${e}`;
  const tiles = new Map<string, TileSignals>();
  let now = 0;

  const dummy = new THREE.Object3D();
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x2e323c });
  const boxMat = new THREE.MeshLambertMaterial({ color: 0x15171c });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const poleGeo = new THREE.CylinderGeometry(0.1, 0.12, 5.6, 6);
  const armGeo = new THREE.BoxGeometry(0.1, 0.1, 1);
  const boxGeo = new THREE.BoxGeometry(0.42, 1.3, 0.36);
  const lampGeo = new THREE.SphereGeometry(0.15, 10, 8);
  const walkBoxGeo = new THREE.BoxGeometry(0.3, 0.6, 0.2);
  const walkLampGeo = new THREE.BoxGeometry(0.18, 0.18, 0.05);
  const BRIGHT: Record<Light, number> = { red: 0xff3b3b, yellow: 0xffc73b, green: 0x3bff8a };
  const DIM: Record<Light, number> = { red: 0x3a0e0e, yellow: 0x3a2e0e, green: 0x0e3a1e };
  const col = new THREE.Color();

  const phase = (n: Node, t: number): [Light, Light] => {
    const p = (t + (offsets.get(n) ?? 0)) % CYCLE;
    const half = CYCLE / 2;
    const inHalf = p % half;
    const active: Light = inHalf < GREEN ? 'green' : inHalf < GREEN + YELLOW ? 'yellow' : 'red';
    return p < half ? [active, 'red'] : ['red', active];
  };
  const state = (n: Node, e: Edge, _dir: Dir): Light => {
    const grp = groupOf.get(key(n, e.id));
    if (grp === undefined) return 'green';
    const [a, b] = phase(n, now);
    return grp === 0 ? a : b;
  };
  const walkState = (n: Node, e: Edge): Light => {
    // 이 길을 건너는 보행자는 교차하는 길의 차량 신호와 같이 움직인다
    const grp = groupOf.get(key(n, e.id));
    if (grp === undefined) return 'red';
    const [a, b] = phase(n, now);
    const other = grp === 0 ? b : a;
    return other === 'green' ? 'green' : 'red';
  };

  function isSignalNode(n: Node, osm: Set<Node>): boolean {
    if (g.degree(n) < 3) return false;
    if (osm.has(n)) return true;
    const es = g.edgesAt(n);
    if (es.some((e) => e.rank <= 1)) return false;
    const big = es.filter((e) => !e.link && (e.rank <= 4 || e.lf + e.lb >= 3)).length;
    return big >= 2;
  }

  return {
    has: (n) => offsets.has(n),
    state,
    walkState,

    addTile(tileKey, tile) {
      if (tiles.has(tileKey)) return [];
      const osm = new Set<Node>(tile.signals);
      const heads: Head[] = [];
      const nodes: Node[] = [];
      for (const [n] of tile.nodes) {
        if (offsets.has(n) || !isSignalNode(n, osm)) continue;
        const approaches = g.edgesAt(n).filter((e) => g.canTravel(e, g.dirInto(e, n)));
        if (approaches.length < 2) continue;
        offsets.set(n, ((n * 7919) % 6) * (CYCLE / 6));
        nodes.push(n);
        const ref = g.pointAt(approaches[0], g.dirInto(approaches[0], n), approaches[0].len - 0.5);
        for (const e of approaches) {
          const p = g.pointAt(e, g.dirInto(e, n), e.len - 0.5);
          const parallel = Math.abs(p.hx * ref.hx + p.hz * ref.hz) > 0.5;
          const group: 0 | 1 = parallel ? 0 : 1;
          groupOf.set(key(n, e.id), group);
          heads.push({ node: n, edgeId: e.id, group, last: null, walkLast: null });
        }
      }
      const count = heads.length;
      const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, count);
      const armMesh = new THREE.InstancedMesh(armGeo, poleMat, count);
      const boxMesh = new THREE.InstancedMesh(boxGeo, boxMat, count);
      const lamp: Record<Light, THREE.InstancedMesh> = {
        red: new THREE.InstancedMesh(lampGeo, lampMat, count),
        yellow: new THREE.InstancedMesh(lampGeo, lampMat, count),
        green: new THREE.InstancedMesh(lampGeo, lampMat, count),
      };
      const walkBox = new THREE.InstancedMesh(walkBoxGeo, boxMat, count);
      const walk: Record<'red' | 'green', THREE.InstancedMesh> = {
        red: new THREE.InstancedMesh(walkLampGeo, lampMat, count),
        green: new THREE.InstancedMesh(walkLampGeo, lampMat, count),
      };
      const poles: Array<[number, number]> = [];
      heads.forEach((h, idx) => {
        const e = g.edge(h.edgeId)!;
        const dir = g.dirInto(e, h.node);
        const p = g.pointAt(e, dir, e.len - 0.5);
        const [rx, rz] = rightOf(p.hx, p.hz);
        const [nx, nz] = g.pos(h.node);
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
          lamp[c].setMatrixAt(idx, dummy.matrix);
          lamp[c].setColorAt(idx, col.setHex(DIM[c]));
        }
        // 보행 신호: 기둥에 붙은 작은 함체, 횡단보도(정지선 앞)를 향한다
        dummy.rotation.set(0, yaw + Math.PI, 0);
        dummy.position.set(px - p.hx * 0.25, 2.3, pz - p.hz * 0.25);
        dummy.updateMatrix();
        walkBox.setMatrixAt(idx, dummy.matrix);
        for (const [c, y] of [
          ['red', 2.48],
          ['green', 2.12],
        ] as const) {
          dummy.position.set(px - p.hx * 0.38, y, pz - p.hz * 0.38);
          dummy.updateMatrix();
          walk[c].setMatrixAt(idx, dummy.matrix);
          walk[c].setColorAt(idx, col.setHex(DIM[c]));
        }
      });
      dummy.rotation.set(0, 0, 0);
      const meshes = [poleMesh, armMesh, boxMesh, lamp.red, lamp.yellow, lamp.green, walkBox, walk.red, walk.green];
      if (count) scene.add(...meshes);
      tiles.set(tileKey, { heads, meshes, lamp, walk, nodes });
      return poles;
    },

    removeTile(tileKey) {
      const t = tiles.get(tileKey);
      if (!t) return;
      tiles.delete(tileKey);
      for (const m of t.meshes) {
        scene.remove(m);
        (m as THREE.InstancedMesh).dispose();
      }
      for (const n of t.nodes) offsets.delete(n);
      for (const h of t.heads) groupOf.delete(key(h.node, h.edgeId));
    },

    update(t) {
      now = t;
      for (const ts of tiles.values()) {
        let dirty = false;
        let walkDirty = false;
        ts.heads.forEach((h, idx) => {
          const e = g.edge(h.edgeId);
          if (!e) return;
          const s = state(h.node, e, 1);
          if (s !== h.last) {
            h.last = s;
            dirty = true;
            for (const c of ['red', 'yellow', 'green'] as const) ts.lamp[c].setColorAt(idx, col.setHex(c === s ? BRIGHT[c] : DIM[c]));
          }
          const w = walkState(h.node, e);
          if (w !== h.walkLast) {
            h.walkLast = w;
            walkDirty = true;
            ts.walk.red.setColorAt(idx, col.setHex(w === 'red' ? BRIGHT.red : DIM.red));
            ts.walk.green.setColorAt(idx, col.setHex(w === 'green' ? BRIGHT.green : DIM.green));
          }
        });
        if (dirty) for (const c of ['red', 'yellow', 'green'] as const) if (ts.lamp[c].instanceColor) ts.lamp[c].instanceColor.needsUpdate = true;
        if (walkDirty) for (const c of ['red', 'green'] as const) if (ts.walk[c].instanceColor) ts.walk[c].instanceColor.needsUpdate = true;
      }
    },
  };
}
