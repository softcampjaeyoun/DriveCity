import * as THREE from 'three';
import { clamp } from '../util/math.ts';
import { cloudTexture } from './assets.ts';
import type { Stage } from './scene.ts';

/** 낮·노을·밤 하루 주기. 조명·하늘·안개·그림자·구름을 바꾸고, 도시엔 night(0 낮 .. 1 밤) 값을 넘긴다 */
export interface Daylight {
  /** 0..24 */
  hour: number;
  /** 0 = 한낮, 1 = 한밤 */
  readonly night: number;
  readonly label: string;
  update(dt: number, raining: boolean): void;
  /** 그림자 카메라가 플레이어를 따라가게 */
  follow(x: number, z: number): void;
  /** 시간을 n 시간 앞으로 */
  skip(hours: number): void;
}

const DAY_SECONDS = 14 * 60; // 하루가 도는 실제 시간
const SHADOW_RANGE = 170;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (out: THREE.Color, a: number, b: number, t: number) => out.setHex(a).lerp(new THREE.Color(b), t);

export function createDaylight(stage: Stage, onNight: (night: number) => void, startHour = 15): Daylight {
  const { scene } = stage;
  const sun = new THREE.DirectionalLight(0xfff2dc, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_RANGE;
  sun.shadow.camera.right = SHADOW_RANGE;
  sun.shadow.camera.top = SHADOW_RANGE;
  sun.shadow.camera.bottom = -SHADOW_RANGE;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const fog = scene.fog as THREE.FogExp2;
  const bg = scene.background as THREE.Color;
  const horizon = new THREE.Color();
  const top = new THREE.Color();
  let lastNight = -1;
  let px = 0;
  let pz = 0;

  // 구름: 높은 평면에 알파 노이즈를 천천히 흘린다
  const cloudTex = cloudTexture();
  const cloudMat = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, fog: false, opacity: 0.9 });
  const clouds = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(Math.PI / 2), cloudMat);
  clouds.position.y = 650;
  clouds.renderOrder = -1;
  scene.add(clouds);

  const api: Daylight = {
    hour: startHour,
    get night() {
      return lastNight < 0 ? 0 : lastNight;
    },
    get label() {
      const h = Math.floor(api.hour);
      const m = Math.floor((api.hour - h) * 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    },
    skip(hours) {
      api.hour = (api.hour + hours + 24) % 24;
    },
    follow(x, z) {
      px = x;
      pz = z;
    },
    update(dt, raining) {
      api.hour = (api.hour + (dt * 24) / DAY_SECONDS) % 24;
      const h = api.hour;
      // 해 높이: 정오 1, 자정 -1
      const elev = Math.sin(((h - 6) / 12) * Math.PI);
      const night = clamp(1 - (elev + 0.12) / 0.4, 0, 1);
      // 노을: 해가 지평선 근처일 때
      const dusk = clamp(1 - Math.abs(elev - 0.02) / 0.2, 0, 1);

      // 햇빛: 플레이어 주변을 비추고 그림자 상자도 따라간다
      const az = ((h - 6) / 12) * Math.PI;
      const dirX = Math.cos(az);
      const dirY = Math.max(0.12, elev);
      const dirZ = 0.45;
      sun.position.set(px + dirX * 400, dirY * 400, pz + dirZ * 400);
      sun.target.position.set(px, 0, pz);
      sun.intensity = Math.max(0, elev) * (raining ? 0.45 : 1.6);
      sun.castShadow = elev > 0.05;
      mix(sun.color, 0xffc98a, 0xfff6ea, clamp(elev / 0.4, 0, 1));
      stage.hemi.intensity = lerp(raining ? 0.75 : 1.0, 0.75, night);
      mix(stage.hemi.color, raining ? 0x8c9ab0 : 0xa8c4f0, 0x5a6cc8, night);
      mix(stage.hemi.groundColor, 0x8a8070, 0x1a1208, night);
      stage.moon.intensity = 0.4 * night;

      // 하늘·안개·구름
      mix(top, raining ? 0x6a7890 : 0x3f7fd6, 0x05070f, night);
      mix(horizon, raining ? 0x9aa6b6 : 0xcfdbea, 0x161528, night);
      horizon.lerp(new THREE.Color(0xf0a060), dusk * 0.55 * (raining ? 0.3 : 1));
      top.lerp(new THREE.Color(0x6c5a8a), dusk * 0.35);
      stage.setSky(top, horizon);
      fog.color.copy(horizon);
      bg.copy(horizon);
      fog.density = lerp(0.0013, 0.0045, night) * (raining ? 2.2 : 1);
      stage.setBloomStrength(lerp(0.12, 0.55, night));
      stage.setExposure(lerp(1.0, 1.15, night));
      clouds.position.set(px, 650, pz);
      cloudTex.offset.x += dt * 0.0015;
      cloudMat.opacity = raining ? 1 : lerp(0.85, 0.08, night);
      mix(cloudMat.color, raining ? 0x7d8795 : 0xffffff, 0x1a1a2a, night);
      cloudMat.color.lerp(new THREE.Color(0xffb080), dusk * 0.5);

      if (Math.abs(night - lastNight) > 0.01) {
        lastNight = night;
        onNight(night);
      }
    },
  };
  return api;
}
