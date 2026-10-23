import * as THREE from 'three';
import { glowTexture } from '../render/textures.ts';

/** 드리프트 타이어 연기: 카메라를 보는 빌보드 조각이 퍼지며 사라진다. 링 버퍼 */
export interface Smoke {
  emit(x: number, y: number, z: number, vx: number, vz: number): void;
  update(dt: number, camera: THREE.Camera): void;
}

const COUNT = 160;

export function createSmoke(scene: THREE.Scene): Smoke {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({ map: glowTexture('rgba(255,255,255,0.9)', 128), color: 0xe8e8ea, transparent: true, opacity: 0.35, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < COUNT; i++) mesh.setMatrixAt(i, hidden);
  scene.add(mesh);
  const px = new Float32Array(COUNT);
  const py = new Float32Array(COUNT);
  const pz = new Float32Array(COUNT);
  const vx = new Float32Array(COUNT);
  const vz = new Float32Array(COUNT);
  const life = new Float32Array(COUNT);
  const seed = new Float32Array(COUNT);
  let idx = 0;
  const dummy = new THREE.Object3D();
  const q = new THREE.Quaternion();
  return {
    emit(x, y, z, ivx, ivz) {
      px[idx] = x + (Math.random() - 0.5) * 0.3;
      py[idx] = y + 0.25;
      pz[idx] = z + (Math.random() - 0.5) * 0.3;
      vx[idx] = ivx * 0.25 + (Math.random() - 0.5) * 1.2;
      vz[idx] = ivz * 0.25 + (Math.random() - 0.5) * 1.2;
      life[idx] = 1;
      seed[idx] = Math.random();
      idx = (idx + 1) % COUNT;
    },
    update(dt, camera) {
      camera.getWorldQuaternion(q);
      let any = false;
      for (let i = 0; i < COUNT; i++) {
        if (life[i] <= 0) continue;
        any = true;
        life[i] -= dt * 0.9;
        if (life[i] <= 0) {
          mesh.setMatrixAt(i, hidden);
          continue;
        }
        px[i] += vx[i] * dt;
        pz[i] += vz[i] * dt;
        py[i] += dt * (0.6 + seed[i] * 0.6);
        const t = 1 - life[i];
        const s = 0.6 + t * 2.2;
        dummy.position.set(px[i], py[i], pz[i]);
        dummy.quaternion.copy(q);
        dummy.rotation.z += seed[i] * 6.28;
        dummy.scale.setScalar(s * (0.6 + 0.4 * life[i] + 0.4 * (1 - life[i])));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      if (any) mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
