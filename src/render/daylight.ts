import * as THREE from 'three';
import { clamp } from '../util/math.ts';
import type { Stage } from './scene.ts';

/** 낮·노을·밤 하루 주기. 조명·하늘·안개를 바꾸고, 도시엔 night(0 낮 .. 1 밤) 값을 넘긴다 */
export interface Daylight {
  /** 0..24 */
  hour: number;
  /** 0 = 한낮, 1 = 한밤 */
  readonly night: number;
  readonly label: string;
  update(dt: number, raining: boolean): void;
  /** 시간을 n 시간 앞으로 */
  skip(hours: number): void;
}

const DAY_SECONDS = 14 * 60; // 하루가 도는 실제 시간

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (out: THREE.Color, a: number, b: number, t: number) => out.setHex(a).lerp(new THREE.Color(b), t);

export function createDaylight(stage: Stage, onNight: (night: number) => void, startHour = 16): Daylight {
  const { scene } = stage;
  const sun = new THREE.DirectionalLight(0xfff2dc, 0);
  scene.add(sun);
  const fog = scene.fog as THREE.FogExp2;
  const bg = scene.background as THREE.Color;
  const horizon = new THREE.Color();
  const top = new THREE.Color();
  let lastNight = -1;

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
    update(dt, raining) {
      api.hour = (api.hour + (dt * 24) / DAY_SECONDS) % 24;
      const h = api.hour;
      // 해 높이: 정오 1, 자정 -1
      const elev = Math.sin(((h - 6) / 12) * Math.PI);
      const night = clamp(1 - (elev + 0.12) / 0.4, 0, 1);
      // 노을: 해가 지평선 근처일 때
      const dusk = clamp(1 - Math.abs(elev - 0.02) / 0.2, 0, 1);

      // 햇빛
      const az = ((h - 6) / 12) * Math.PI;
      sun.position.set(Math.cos(az) * 200, Math.max(5, elev * 220), 90);
      sun.intensity = Math.max(0, elev) * (raining ? 0.5 : 1.15);
      mix(sun.color, 0xffd2a0, 0xfff6ea, clamp(elev / 0.4, 0, 1));
      stage.hemi.intensity = lerp(raining ? 0.7 : 0.95, 0.75, night);
      mix(stage.hemi.color, raining ? 0x8c9ab0 : 0xa8c4f0, 0x5a6cc8, night);
      mix(stage.hemi.groundColor, 0x8a8070, 0x1a1208, night);
      stage.moon.intensity = 0.4 * night;

      // 하늘·안개
      mix(top, raining ? 0x6a7890 : 0x3f7fd6, 0x05070f, night);
      mix(horizon, raining ? 0x9aa6b6 : 0xcfdbea, 0x161528, night);
      horizon.lerp(new THREE.Color(0xf0a060), dusk * 0.55 * (raining ? 0.3 : 1));
      top.lerp(new THREE.Color(0x6c5a8a), dusk * 0.35);
      stage.setSky(top, horizon);
      fog.color.copy(horizon);
      bg.copy(horizon);
      fog.density = lerp(0.0013, 0.0045, night) * (raining ? 2.2 : 1);
      stage.setBloomStrength(lerp(0.18, 0.55, night));

      if (Math.abs(night - lastNight) > 0.01) {
        lastNight = night;
        onNight(night);
      }
    },
  };
  return api;
}
