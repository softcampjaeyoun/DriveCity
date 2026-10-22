import * as THREE from 'three';
import { reduceMotion } from './config.ts';
import type { PlayerState } from './vehicle/player.ts';

export type CamMode = 0 | 1 | 2; // 가까운 추적, 먼 추적, 보닛

export interface ChaseCamera {
  mode: CamMode;
  cycle(): void;
  /** 출발 직후 차 뒤로 바로 붙임 */
  snap(S: PlayerState): void;
  update(dt: number, t: number, S: PlayerState, vf: number, vmax: number, started: boolean): void;
}

/** 카메라가 들어가면 안 되는 곳(건물)에서 밀어내는 함수. 겹치지 않으면 null. y 는 차 높이(지하차도 안이면 건물 무시) */
export type CameraBlock = (x: number, z: number, r: number, y: number) => { dx: number; dz: number } | null;

export function createChaseCamera(camera: THREE.PerspectiveCamera, block: CameraBlock = () => null): ChaseCamera {
  const pos = new THREE.Vector3(0, 6, -12);
  const look = new THREE.Vector3();
  const want = new THREE.Vector3();

  return {
    mode: 0,
    cycle() {
      this.mode = ((this.mode + 1) % 3) as CamMode;
    },
    snap(S) {
      pos.set(S.x - Math.sin(S.h) * 9, S.y + 4, S.z - Math.cos(S.h) * 9);
    },
    update(dt, t, S, vf, vmax, started) {
      const fx = Math.sin(S.h);
      const fz = Math.cos(S.h);
      const speed = Math.abs(vf);
      if (!started) {
        const a = t * 0.18;
        camera.position.set(S.x + Math.sin(a) * 11, S.y + 3.6, S.z + Math.cos(a) * 11);
        camera.lookAt(S.x, S.y + 1, S.z);
        camera.fov = 55;
        camera.updateProjectionMatrix();
        return;
      }
      if (this.mode === 2) {
        pos.set(S.x + fx * 0.2, S.y + 1.45, S.z + fz * 0.2);
        look.set(S.x + fx * 20, S.y + 1.2 + Math.tan(S.pitch) * 20, S.z + fz * 20);
      } else {
        const dist = (this.mode === 0 ? 7.2 : 11) + speed * 0.04;
        const height = this.mode === 0 ? 2.7 : 4.4;
        want.set(S.x - fx * dist, S.y + height, S.z - fz * dist);
        // 건물 안이면 차 쪽으로 당기고 조금 올린다
        for (let k = 0; k < 3; k++) {
          const hit = block(want.x, want.z, 1.2, S.y);
          if (!hit) break;
          want.x += hit.dx;
          want.z += hit.dz;
          want.y += 0.6;
        }
        pos.lerp(want, 1 - Math.exp(-dt * 7));
        const again = block(pos.x, pos.z, 0.8, S.y);
        if (again) {
          pos.x += again.dx;
          pos.z += again.dz;
        }
        look.set(S.x + fx * 4, S.y + 1.2, S.z + fz * 4);
      }
      camera.position.copy(pos);
      if (S.shake > 0) {
        camera.position.x += (Math.random() - 0.5) * S.shake * 0.6;
        camera.position.y += (Math.random() - 0.5) * S.shake * 0.6;
        S.shake = Math.max(0, S.shake - dt * 3);
      }
      camera.lookAt(look);
      const fov = reduceMotion ? 62 : 62 + Math.min((speed / vmax) * 16, 24);
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
    },
  };
}
