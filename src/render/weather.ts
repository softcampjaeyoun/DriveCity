import * as THREE from 'three';
import type { City } from '../world/city.ts';

export interface Weather {
  readonly raining: boolean;
  setRain(on: boolean, announce?: boolean): void;
  toggle(): void;
  update(dt: number, camera: THREE.Camera): void;
}

const DROPS = 1400;
const BOX = { x: 70, y: 36, z: 70 };

/** 비: 카메라 주위 상자 안에서 떨어지는 빗줄기 + 짙은 안개 + 젖은 노면. 2~3분마다 바뀐다 */
export function createWeather(scene: THREE.Scene, city: City, toast: (big: string, sub: string) => void): Weather {
  const fog = scene.fog as THREE.FogExp2;
  const pos = new Float32Array(DROPS * 6);
  const vel = new Float32Array(DROPS);
  for (let i = 0; i < DROPS; i++) {
    pos[i * 6] = (Math.random() - 0.5) * BOX.x;
    pos[i * 6 + 1] = Math.random() * BOX.y;
    pos[i * 6 + 2] = (Math.random() - 0.5) * BOX.z;
    vel[i] = 26 + Math.random() * 10;
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  geo.setAttribute('position', attr);
  const rain = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fb6d8, transparent: true, opacity: 0.35 }));
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  let raining = false;
  let timer = 90 + Math.random() * 90;
  const wind = 3;

  const setRain = (on: boolean, announce = true) => {
    if (on === raining) return;
    raining = on;
    rain.visible = on;
    city.setWet(on);
    fog.density = on ? 0.0095 : 0.0062;
    if (announce) toast(on ? '비가 내리기 시작했어요' : '비가 그쳤어요', on ? '노면이 미끄러워요. 조심하세요' : '');
  };

  return {
    get raining() {
      return raining;
    },
    setRain,
    toggle() {
      setRain(!raining);
      timer = 120 + Math.random() * 90;
    },
    update(dt, camera) {
      timer -= dt;
      if (timer <= 0) {
        setRain(!raining && Math.random() < 0.55);
        timer = raining ? 70 + Math.random() * 60 : 120 + Math.random() * 100;
      }
      if (!raining) return;
      const cx = camera.position.x;
      const cz = camera.position.z;
      for (let i = 0; i < DROPS; i++) {
        let y = pos[i * 6 + 1] - vel[i] * dt;
        let x = pos[i * 6] + wind * dt;
        if (y < 0) {
          y += BOX.y;
          x = cx + (Math.random() - 0.5) * BOX.x;
          pos[i * 6 + 2] = cz + (Math.random() - 0.5) * BOX.z;
        }
        // 카메라에서 너무 멀어진 빗방울은 근처로 되돌린다
        if (Math.abs(x - cx) > BOX.x / 2) x = cx + (Math.random() - 0.5) * BOX.x;
        if (Math.abs(pos[i * 6 + 2] - cz) > BOX.z / 2) pos[i * 6 + 2] = cz + (Math.random() - 0.5) * BOX.z;
        pos[i * 6] = x;
        pos[i * 6 + 1] = y;
        pos[i * 6 + 3] = x - wind * 0.02;
        pos[i * 6 + 4] = y + 0.9;
        pos[i * 6 + 5] = pos[i * 6 + 2];
      }
      attr.needsUpdate = true;
    },
  };
}
