import './style.css';
import { createTraffic } from './ai/traffic.ts';
import { createAudio, type EngineAudio } from './audio.ts';
import { createChaseCamera } from './camera.ts';
import { coarse } from './config.ts';
import { createBattle } from './game/battle.ts';
import { createRun } from './game/run.ts';
import { save } from './game/save.ts';
import { IDLE, createInput } from './input.ts';
import { createStage } from './render/scene.ts';
import { createGarage } from './ui/garage.ts';
import { createHud } from './ui/hud.ts';
import { createMinimap } from './ui/minimap.ts';
import { createPlayer } from './vehicle/player.ts';
import { CARS, computeStats, emptyParts, partsLevel, type CarSpec, type CarStats } from './vehicle/stats.ts';
import { createMarker } from './world/checkpoint.ts';
import { buildCity } from './world/city.ts';

if (coarse) document.documentElement.classList.add('coarse');

const canvas = document.getElementById('view') as HTMLCanvasElement;
const { renderer, scene, camera } = createStage(canvas);
const city = buildCity(scene);
const marker = createMarker(scene);
const player = createPlayer(scene);
const traffic = createTraffic(scene);
const hud = createHud();
const minimap = createMinimap(document.getElementById('minimap') as HTMLCanvasElement, city);
const chase = createChaseCamera(camera);
const input = createInput();

let started = false;
let audio: EngineAudio | null = null;
let flash = 0;
// 차고가 onChange 로 바로 덮어쓴다
let carSpec: CarSpec = CARS[0];
let carStats: CarStats = computeStats(CARS[0], emptyParts());
let carLv = 0;
let lastModelCar = '';

const run = createRun({
  toast: (b, s, secs) => hud.toast(b, s, secs),
  onBest: (t) => hud.setBest(t),
});
const battle = createBattle(traffic, {
  toast: (b, s, secs) => hud.toast(b, s, secs),
  pauseRun: () => run.pause(),
  resumeRun: () => run.resume(),
});
const garage = createGarage(document.getElementById('garage') as HTMLElement, {
  onChange(spec, stats, car) {
    carSpec = spec;
    carStats = stats;
    carLv = partsLevel(car.parts);
    player.setPaint(car.paint);
    player.setGlow(car.glow);
    if (spec.id !== lastModelCar) {
      lastModelCar = spec.id;
      player.setModel(spec.model);
    }
  },
  onOpen: () => run.pause(),
  onClose: () => run.resume(),
});
hud.setBest(save.best);

// ----- 입력 액션 -----
const canOpenGarage = () => started && !battle.active && Math.hypot(player.S.vx, player.S.vz) < 1.5;
input.on('reset', () => {
  if (!garage.open) player.reset();
});
input.on('camera', () => chase.cycle());
input.on('mute', () => audio?.toggleMute());
input.on('battle', () => {
  if (!started || garage.open) return;
  flash = 1;
  battle.challenge(player.S);
});
input.on('garage', () => {
  if (garage.open) garage.hide();
  else if (canOpenGarage()) garage.show();
});
input.on('escape', () => garage.hide());
input.on('start', begin);
document.getElementById('go')!.addEventListener('click', begin);

function begin(): void {
  if (started) return;
  started = true;
  document.getElementById('intro')!.hidden = true;
  chase.snap(player.S);
  audio ??= createAudio();
  audio?.resume();
  run.start(player.S);
}

// 개발 모드 디버그 훅. 브라우저 콘솔이나 자동 테스트에서 상태를 들여다볼 때 쓴다
if (import.meta.env.DEV) {
  (window as unknown as { __dc: unknown }).__dc = { player, traffic, battle, run, garage, save };
}

// ----- 루프 -----
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  const S = player.S;
  const inp = started && !garage.open ? input.read() : IDLE;

  const r = player.step(dt, inp, carStats, city.colliders, () => traffic.collidePlayer(S));
  player.applyVisual(r, inp, dt);
  traffic.update(dt, S, (n) => battle.racePace(n, S));
  const bt = battle.update(S);
  run.update(now, S);

  // 목표 지점: 배틀 중이면 결승, 아니면 다음 체크포인트
  const target = battle.active ? { x: battle.tx, z: battle.tz } : { x: run.tx, z: run.tz };
  marker.setPosition(target.x, target.z);
  marker.setColor(battle.active ? 0xffae4a : 0x4fd1ff);
  marker.update(t);
  city.update(t);
  player.setFlash(flash);
  flash = Math.max(0, flash - dt * 3);

  const dx = target.x - S.x;
  const dz = target.z - S.z;
  const fx = Math.sin(S.h);
  const fz = Math.cos(S.h);
  const span = carStats.vmax / 5;
  const gear = Math.min(5, Math.floor(Math.abs(r.vf) / span));
  const within = Math.min(1, (Math.abs(r.vf) - gear * span) / span);
  const cand = started && !battle.active ? traffic.nearbyRival(S) : null;
  const rivalSpec = battle.rival?.rival ?? null;

  hud.frame({
    time: run.time,
    cp: run.cp,
    credits: save.credits,
    kmh: Math.abs(r.vf) * 3.6,
    reverse: r.vf < -0.5,
    within,
    gear,
    nitro: S.nitro,
    dist: Math.hypot(dx, dz),
    angle: Math.atan2(-(dx * Math.cos(S.h) - dz * Math.sin(S.h)), dx * fx + dz * fz),
    battle: bt && rivalSpec ? { name: `${rivalSpec.name} Lv${rivalSpec.level}`, ...bt } : null,
    promptName: cand?.rival ? cand.rival.name : null,
    garageHint: canOpenGarage() && !garage.open,
    drift: player.driftTimer > 0 && player.driftScore > 5 ? player.driftScore : null,
    carName: carSpec.name,
    carLv,
  });
  hud.tick(dt);
  minimap.draw(t, S, traffic.npcs, target, battle.active);

  audio?.update(48 + within * 85 + gear * 9 + (inp.up ? 8 : 0), inp.up, r.drifting);

  chase.update(dt, t, S, r.vf, carStats.vmax, started);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
