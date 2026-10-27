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
  sun.shadow.mapSize.set(4096, 4096);
  // 품질 단계가 바뀌면 그림자맵을 다시 만든다
  stage.onShadowSize = (size) => {
    if (sun.shadow.mapSize.x === size) return;
    sun.shadow.mapSize.set(size, size);
    // WebGPU 는 그림자 맵 크기를 매 프레임 mapSize 에 맞춘다. 맵을 버리면 안 된다
    if (stage.backend === 'webgpu') return;
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  };
  sun.shadow.camera.left = -SHADOW_RANGE;
  sun.shadow.camera.right = SHADOW_RANGE;
  sun.shadow.camera.top = SHADOW_RANGE;
  sun.shadow.camera.bottom = -SHADOW_RANGE;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.5;
  scene.add(sun, sun.target);
  const fog = scene.fog as THREE.FogExp2;
  const bg = scene.background as THREE.Color;
  const horizon = new THREE.Color();
  const top = new THREE.Color();
  let lastNight = -1;
  let px = 0;
  let pz = 0;
  const sunDir = new THREE.Vector3();

  // 비구름: 높은 평면에 알파 노이즈를 천천히 흘린다 (맑은 날 구름은 하늘 셰이더가 그린다)
  const cloudTex = cloudTexture();
  const cloudMat = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, fog: false, opacity: 0 });
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
      // ACES 톤매핑 기준 세기. 하늘빛 간접광은 환경맵이 대고, 반구광은 그 보조
      sun.intensity = Math.max(0, elev) * (raining ? 0.6 : 2.5);
      sun.castShadow = elev > 0.05;
      mix(sun.color, 0xffc48a, 0xfff0d6, clamp(elev / 0.4, 0, 1));
      stage.hemi.intensity = lerp(raining ? 0.5 : 0.45, 3.0, night);
      mix(stage.hemi.color, raining ? 0x8c9ab0 : 0xbcc8dc, 0x6f80cf, night);
      mix(stage.hemi.groundColor, 0x9c917c, 0x2c2419, night);
      stage.moon.intensity = 1.6 * night;
      sunDir.set(dirX, elev, dirZ).normalize();
      stage.setSun(sunDir, raining);
      stage.setNight(night);

      // 하늘·안개·구름
      // 밤 하늘: 톤매핑·sRGB 를 거치므로 예전 상수보다 밝게 잡아야 비슷하게 보인다
      mix(top, raining ? 0x6a7890 : 0x3f7fd6, 0x0c1024, night);
      mix(horizon, raining ? 0x9aa6b6 : 0xd3dde6, 0x2b2650, night);
      horizon.lerp(new THREE.Color(0xf0a060), dusk * 0.55 * (raining ? 0.3 : 1));
      top.lerp(new THREE.Color(0x6c5a8a), dusk * 0.35);
      stage.setSky(top, horizon);
      fog.color.copy(horizon);
      bg.copy(horizon);
      fog.density = lerp(0.0015, 0.0034, night) * (raining ? 2.2 : 1);
      stage.setBloomStrength(lerp(0.04, 0.45, night));
      stage.setExposure(lerp(0.9, 1.9, night));
      clouds.position.set(px, 650, pz);
      cloudTex.offset.x += dt * 0.0015;
      clouds.visible = raining;
      cloudMat.opacity = raining ? 1 : 0;
      mix(cloudMat.color, 0x6d7785, 0x1a1a2a, night);

      if (Math.abs(night - lastNight) > 0.01) {
        lastNight = night;
        onNight(night);
      }
    },
  };
  return api;
}
